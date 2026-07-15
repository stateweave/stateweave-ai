"use client";

import { PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";

type GraphNode = {
  id: string;
  type: string;
  text: string;
  data?: Record<string, unknown>;
  status?: string;
  createdAt: string;
};

type GraphEdge = {
  id: string;
  from: string;
  to: string;
  type: string;
};

export type StateGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

type LayoutNode = GraphNode & {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  degree: number;
  pinned: boolean;
};

type LayoutEdge = GraphEdge & { fromNode: LayoutNode; toNode: LayoutNode };
type GraphLayout = { nodes: LayoutNode[]; edges: LayoutEdge[] };
type SavedPosition = Pick<LayoutNode, "x" | "y" | "vx" | "vy" | "pinned">;
type GraphPoint = { x: number; y: number };
type DragState = { node: LayoutNode; pointerId: number; start: GraphPoint; moved: boolean };

const WIDTH = 720;
const HEIGHT = 560;
const MAX_VISIBLE_NODES = 110;
const BOUNDS = 38;

export function GraphView({ graph, active }: { graph: StateGraph; active: boolean }) {
  const [selectedId, setSelectedId] = useState<string>();
  const [, setInteractionVersion] = useState(0);
  const svgRef = useRef<SVGSVGElement>(null);
  const nodeElements = useRef(new Map<string, SVGGElement>());
  const edgeElements = useRef<Array<SVGLineElement | null>>([]);
  const [positionStore] = useState(() => new Map<string, SavedPosition>());
  const drag = useRef<DragState | undefined>(undefined);
  const hoverPoint = useRef<GraphPoint | undefined>(undefined);
  const hoveredNodeId = useRef<string | undefined>(undefined);
  const layout = useMemo(() => buildLayout(graph, positionStore), [graph, positionStore]);
  const selected = layout.nodes.find((node) => node.id === selectedId);
  const latestIds = new Set(layout.nodes.slice(-7).map((node) => node.id));

  useEffect(() => {
    if (!layout.nodes.length) return;
    let animationFrame = 0;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const animate = () => {
      applyGraphForces(layout, positionStore, {
        draggingNodeId: drag.current?.node.id,
        hoveredNodeId: hoveredNodeId.current,
        hoverPoint: hoverPoint.current,
        cooling: drag.current ? 0.96 : 0.72,
        ambient: !reducedMotion,
      });
      updateGraphDom(layout, nodeElements.current, edgeElements.current);
      animationFrame = window.requestAnimationFrame(animate);
    };
    animationFrame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [layout, positionStore]);

  if (!layout.nodes.length) {
    return (
      <div className="graph-empty" aria-label="Empty StateWeave graph">
        <span className="empty-node" />
        <p>Your memory starts with your first thought.</p>
      </div>
    );
  }

  function selectNode(node: LayoutNode) {
    setSelectedId(node.id);
  }

  function startDrag(event: ReactPointerEvent<SVGGElement>, node: LayoutNode) {
    selectNode(node);
    if (event.button !== 0) return;
    event.preventDefault();
    const point = svgPoint(svgRef.current, event.clientX, event.clientY);
    if (!point) return;
    node.pinned = true;
    node.x = clamp(point.x, BOUNDS, WIDTH - BOUNDS);
    node.y = clamp(point.y, BOUNDS, HEIGHT - BOUNDS);
    node.vx = 0;
    node.vy = 0;
    drag.current = { node, pointerId: event.pointerId, start: point, moved: false };
    setInteractionVersion((version) => version + 1);
    event.currentTarget.setPointerCapture(event.pointerId);
    rememberPosition(node, positionStore);
    updateGraphDom(layout, nodeElements.current, edgeElements.current);
  }

  function moveDrag(event: ReactPointerEvent<SVGGElement>, node: LayoutNode) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId || current.node.id !== node.id) return;
    event.preventDefault();
    const point = svgPoint(svgRef.current, event.clientX, event.clientY);
    if (!point) return;
    current.moved = current.moved || Math.hypot(point.x - current.start.x, point.y - current.start.y) > 4;
    node.x = clamp(point.x, BOUNDS, WIDTH - BOUNDS);
    node.y = clamp(point.y, BOUNDS, HEIGHT - BOUNDS);
    node.vx = 0;
    node.vy = 0;
    rememberPosition(node, positionStore);
    updateGraphDom(layout, nodeElements.current, edgeElements.current);
  }

  function endDrag(event: ReactPointerEvent<SVGGElement>, node: LayoutNode) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId || current.node.id !== node.id) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    rememberPosition(node, positionStore);
    drag.current = undefined;
  }

  function releaseNode(node: LayoutNode) {
    node.pinned = false;
    rememberPosition(node, positionStore);
    setInteractionVersion((version) => version + 1);
    selectNode(node);
  }

  return (
    <div className={`graph-visual ${active ? "is-active" : ""}`}>
      <div className="graph-help">Drag to reshape · double-click to release</div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`Interactive StateWeave graph with ${graph.nodes.length} nodes and ${graph.edges.length} edges`}
        onPointerMove={(event) => { hoverPoint.current = svgPoint(svgRef.current, event.clientX, event.clientY); }}
        onPointerLeave={() => { hoverPoint.current = undefined; hoveredNodeId.current = undefined; }}
      >
        <g className="graph-edges">
          {layout.edges.map((edge, index) => (
            <line
              key={edge.id}
              ref={(element) => { edgeElements.current[index] = element; }}
              x1={edge.fromNode.x}
              y1={edge.fromNode.y}
              x2={edge.toNode.x}
              y2={edge.toNode.y}
              className={`graph-edge edge-${slug(edge.type)} ${selectedId && (edge.from === selectedId || edge.to === selectedId) ? "is-selected" : ""}`}
            />
          ))}
        </g>
        <g className="graph-nodes">
          {layout.nodes.map((node) => {
            const selectedNode = node.id === selected?.id;
            const label = selectedNode || latestIds.has(node.id) || layout.nodes.length <= 15;
            const labelOnLeft = node.x > WIDTH * 0.7;
            return (
              <g
                key={node.id}
                ref={(element) => {
                  if (element) nodeElements.current.set(node.id, element);
                  else nodeElements.current.delete(node.id);
                }}
                className={`graph-node node-${slug(node.type)} ${selectedNode ? "is-selected" : ""} ${node.pinned ? "is-pinned" : ""}`}
                transform={`translate(${node.x} ${node.y})`}
                role="button"
                tabIndex={0}
                aria-label={`${node.type}: ${node.text}`}
                onPointerEnter={() => { hoveredNodeId.current = node.id; }}
                onPointerLeave={() => { if (hoveredNodeId.current === node.id) hoveredNodeId.current = undefined; }}
                onPointerDown={(event) => startDrag(event, node)}
                onPointerMove={(event) => moveDrag(event, node)}
                onPointerUp={(event) => endDrag(event, node)}
                onPointerCancel={(event) => endDrag(event, node)}
                onDoubleClick={() => releaseNode(node)}
                onClick={() => selectNode(node)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") selectNode(node);
                  if (event.key === "Escape") releaseNode(node);
                }}
              >
                <circle r={node.radius + (selectedNode ? 5 : 0)} className="node-halo" />
                <circle r={node.radius} className="node-core" />
                {label ? (
                  <text x={labelOnLeft ? -(node.radius + 8) : node.radius + 8} y="4" textAnchor={labelOnLeft ? "end" : "start"}>
                    {shortLabel(node)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>
      {selected ? (
        <div className="node-inspector">
          <span>{humanType(selected.type)}{selected.pinned ? " · pinned" : ""}</span>
          <p>{selected.text}</p>
        </div>
      ) : null}
    </div>
  );
}

function buildLayout(graph: StateGraph, positions: Map<string, SavedPosition>): GraphLayout {
  const visible = visibleNodes(graph);
  if (!visible.length) return { nodes: [], edges: [] };

  const visibleIds = new Set(visible.map((node) => node.id));
  const graphEdges = graph.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));
  const degree = new Map<string, number>();
  for (const edge of graphEdges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }

  const nodes = visible.map<LayoutNode>((node, index) => {
    const existing = positions.get(node.id);
    const root = node.id === "system_root" || node.type === "system";
    const ring = root ? 0 : 74 + Math.sqrt(index + 1) * 34;
    const angle = seededAngle(node.id, index);
    return {
      ...node,
      x: existing?.x ?? (root ? WIDTH / 2 : WIDTH / 2 + Math.cos(angle) * ring * 1.25),
      y: existing?.y ?? (root ? HEIGHT / 2 : HEIGHT / 2 + Math.sin(angle) * ring * .88),
      vx: existing?.vx ?? 0,
      vy: existing?.vy ?? 0,
      radius: nodeRadius(node.type, degree.get(node.id) ?? 0),
      degree: degree.get(node.id) ?? 0,
      pinned: existing?.pinned ?? false,
    };
  });
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const edges = graphEdges.flatMap<LayoutEdge>((edge) => {
    const fromNode = nodeMap.get(edge.from);
    const toNode = nodeMap.get(edge.to);
    return fromNode && toNode ? [{ ...edge, fromNode, toNode }] : [];
  });
  const layout = { nodes, edges };

  for (let iteration = 0; iteration < 80; iteration += 1) {
    applyGraphForces(layout, positions, { cooling: 1 - iteration / 100, ambient: false });
  }
  for (const node of nodes) rememberPosition(node, positions);
  for (const id of positions.keys()) if (!visibleIds.has(id)) positions.delete(id);
  return layout;
}

function applyGraphForces(
  layout: GraphLayout,
  positions: Map<string, SavedPosition>,
  options: { draggingNodeId?: string; hoveredNodeId?: string; hoverPoint?: GraphPoint; cooling: number; ambient: boolean },
): void {
  const movable = (node: LayoutNode) => !node.pinned && node.id !== options.draggingNodeId;

  for (let index = 0; index < layout.nodes.length; index += 1) {
    const a = layout.nodes[index];
    for (let otherIndex = index + 1; otherIndex < layout.nodes.length; otherIndex += 1) {
      const b = layout.nodes[otherIndex];
      const dx = b.x - a.x || .01;
      const dy = b.y - a.y || .01;
      const distanceSquared = Math.max(120, dx * dx + dy * dy);
      const distance = Math.sqrt(distanceSquared);
      const force = ((a.radius + b.radius + 44) * 18) / distanceSquared;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      if (movable(a)) { a.vx -= fx; a.vy -= fy; }
      if (movable(b)) { b.vx += fx; b.vy += fy; }
    }
  }

  for (const edge of layout.edges) {
    const dx = edge.toNode.x - edge.fromNode.x;
    const dy = edge.toNode.y - edge.fromNode.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const ideal = edge.from === "system_root" || edge.to === "system_root" ? 116 : 102;
    const force = (distance - ideal) * .008;
    const fx = (dx / distance) * force;
    const fy = (dy / distance) * force;
    if (movable(edge.fromNode)) { edge.fromNode.vx += fx; edge.fromNode.vy += fy; }
    if (movable(edge.toNode)) { edge.toNode.vx -= fx; edge.toNode.vy -= fy; }
  }

  const hovered = options.hoveredNodeId ? layout.nodes.find((node) => node.id === options.hoveredNodeId) : undefined;
  const time = options.ambient ? performance.now() / 1000 : 0;
  for (const node of layout.nodes) {
    if (node.id === options.draggingNodeId || node.pinned) {
      node.vx = 0;
      node.vy = 0;
      rememberPosition(node, positions);
      continue;
    }
    if (options.ambient) {
      const nodeHash = hash(node.id);
      node.vx += Math.sin(time * .7 + nodeHash) * .004;
      node.vy += Math.cos(time * .6 + nodeHash) * .004;
    }
    node.vx += (WIDTH / 2 - node.x) * .0008;
    node.vy += (HEIGHT / 2 - node.y) * .0008;
    if (options.hoverPoint) repelFromPoint(node, options.hoverPoint, 105, .025);
    if (hovered && hovered.id !== node.id) repelFromPoint(node, hovered, 145, .032);
    node.x = clamp(node.x + node.vx * options.cooling, BOUNDS, WIDTH - BOUNDS);
    node.y = clamp(node.y + node.vy * options.cooling, BOUNDS, HEIGHT - BOUNDS);
    node.vx *= .84;
    node.vy *= .84;
    rememberPosition(node, positions);
  }
}

function updateGraphDom(layout: GraphLayout, nodes: Map<string, SVGGElement>, edges: Array<SVGLineElement | null>): void {
  for (const node of layout.nodes) {
    const element = nodes.get(node.id);
    if (!element) continue;
    element.setAttribute("transform", `translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})`);
    element.classList.toggle("is-pinned", node.pinned);
  }
  layout.edges.forEach((edge, index) => {
    const line = edges[index];
    if (!line) return;
    line.setAttribute("x1", edge.fromNode.x.toFixed(1));
    line.setAttribute("y1", edge.fromNode.y.toFixed(1));
    line.setAttribute("x2", edge.toNode.x.toFixed(1));
    line.setAttribute("y2", edge.toNode.y.toFixed(1));
  });
}

function rememberPosition(node: LayoutNode, positions: Map<string, SavedPosition>): void {
  positions.set(node.id, { x: node.x, y: node.y, vx: node.vx, vy: node.vy, pinned: node.pinned });
}

function repelFromPoint(node: LayoutNode, point: GraphPoint, radius: number, strength: number): void {
  const dx = node.x - point.x || .01;
  const dy = node.y - point.y || .01;
  const distance = Math.hypot(dx, dy);
  if (distance > radius) return;
  const force = ((radius - distance) / radius) * strength;
  node.vx += (dx / distance) * force;
  node.vy += (dy / distance) * force;
}

function svgPoint(svg: SVGSVGElement | null, clientX: number, clientY: number): GraphPoint | undefined {
  const matrix = svg?.getScreenCTM();
  if (!svg || !matrix) return undefined;
  const point = svg.createSVGPoint();
  point.x = clientX;
  point.y = clientY;
  const transformed = point.matrixTransform(matrix.inverse());
  return { x: transformed.x, y: transformed.y };
}

function visibleNodes(graph: StateGraph): GraphNode[] {
  if (graph.nodes.length <= MAX_VISIBLE_NODES) return graph.nodes;
  const root = graph.nodes.find((node) => node.id === "system_root" || node.type === "system");
  const recent = graph.nodes.slice(-(MAX_VISIBLE_NODES - (root ? 1 : 0)));
  return root && !recent.some((node) => node.id === root.id) ? [root, ...recent] : recent;
}

function nodeRadius(type: string, degree: number): number {
  const base = type === "system" ? 10 : type === "user_input" ? 8 : type === "assistant_output" ? 7 : type === "artifact" ? 8 : 6;
  return Math.min(base + Math.sqrt(degree) * .8, 13);
}

function seededAngle(id: string, index: number): number {
  return ((hash(`${id}:${index}`) % 10_000) / 10_000) * Math.PI * 2;
}

function shortLabel(node: GraphNode): string {
  if (node.type === "system") return "memory root";
  const normalized = node.text.replace(/\s+/g, " ").trim();
  return normalized.length > 30 ? `${normalized.slice(0, 29)}…` : normalized;
}

function humanType(type: string): string {
  return type.replaceAll("_", " ");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
