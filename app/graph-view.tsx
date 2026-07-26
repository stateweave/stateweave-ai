"use client";

import { ArrowCounterClockwise, X } from "@phosphor-icons/react";
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
type Camera = { x: number; y: number; scale: number };
type PanState = { pointerId: number; start: GraphPoint; camera: Camera };
type PinchState = { midpoint: GraphPoint; distance: number; camera: Camera; anchor: GraphPoint };

const WIDTH = 720;
const HEIGHT = 560;
const MAX_VISIBLE_NODES = 110;
const BOUNDS = 38;
const MIN_ZOOM = 0.55;
const MAX_ZOOM = 4;

export function GraphView({ graph, active }: { graph: StateGraph; active: boolean }) {
  const [selectedId, setSelectedId] = useState<string>();
  const [, setInteractionVersion] = useState(0);
  const svgRef = useRef<SVGSVGElement>(null);
  const viewportRef = useRef<SVGGElement>(null);
  const nodeElements = useRef(new Map<string, SVGGElement>());
  const edgeElements = useRef<Array<SVGLineElement | null>>([]);
  const [positionStore] = useState(() => new Map<string, SavedPosition>());
  const drag = useRef<DragState | undefined>(undefined);
  const pan = useRef<PanState | undefined>(undefined);
  const pinch = useRef<PinchState | undefined>(undefined);
  const pointers = useRef(new Map<number, GraphPoint>());
  const camera = useRef<Camera>({ x: 0, y: 0, scale: 1 });
  const hoverPoint = useRef<GraphPoint | undefined>(undefined);
  const hoveredNodeId = useRef<string | undefined>(undefined);
  const layout = useMemo(() => buildLayout(graph, positionStore), [graph, positionStore]);
  const selected = layout.nodes.find((node) => node.id === selectedId);
  const latestIds = new Set(layout.nodes.slice(-7).map((node) => node.id));

  useEffect(() => {
    if (!layout.nodes.length || !svgRef.current) return;
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
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && !animationFrame) animationFrame = window.requestAnimationFrame(animate);
      if (!entry?.isIntersecting && animationFrame) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      }
    });
    observer.observe(svgRef.current);
    return () => {
      observer.disconnect();
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
    };
  }, [layout, positionStore]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const zoomWithWheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = svgPoint(svg, event.clientX, event.clientY);
      if (!point) return;
      const current = camera.current;
      const anchor = cameraPoint(point, current);
      const scale = clamp(current.scale * Math.exp(-event.deltaY * .0015), MIN_ZOOM, MAX_ZOOM);
      const next = { x: point.x - anchor.x * scale, y: point.y - anchor.y * scale, scale };
      camera.current = next;
      viewportRef.current?.setAttribute("transform", `translate(${next.x.toFixed(2)} ${next.y.toFixed(2)}) scale(${next.scale.toFixed(4)})`);
    };
    svg.addEventListener("wheel", zoomWithWheel, { passive: false });
    return () => svg.removeEventListener("wheel", zoomWithWheel);
  }, [layout.nodes.length]);

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

  function updateCamera(next: Camera) {
    camera.current = { ...next, scale: clamp(next.scale, MIN_ZOOM, MAX_ZOOM) };
    const current = camera.current;
    viewportRef.current?.setAttribute("transform", `translate(${current.x.toFixed(2)} ${current.y.toFixed(2)}) scale(${current.scale.toFixed(4)})`);
  }

  function beginPinch() {
    const points = [...pointers.current.values()].slice(0, 2);
    if (points.length < 2) return;
    const midpoint = midpointOf(points[0], points[1]);
    const current = camera.current;
    pinch.current = {
      midpoint,
      distance: Math.max(1, distanceBetween(points[0], points[1])),
      camera: { ...current },
      anchor: cameraPoint(midpoint, current),
    };
    if (drag.current) rememberPosition(drag.current.node, positionStore);
    drag.current = undefined;
    pan.current = undefined;
  }

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const point = svgPoint(svgRef.current, event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, point);

    if (pointers.current.size >= 2) {
      beginPinch();
      return;
    }

    const target = event.target as Element;
    const nodeId = target.closest<SVGGElement>("[data-node-id]")?.dataset.nodeId;
    const node = nodeId ? layout.nodes.find((candidate) => candidate.id === nodeId) : undefined;
    if (node) {
      selectNode(node);
      const graphPoint = cameraPoint(point, camera.current);
      node.x = clamp(graphPoint.x, BOUNDS, WIDTH - BOUNDS);
      node.y = clamp(graphPoint.y, BOUNDS, HEIGHT - BOUNDS);
      node.vx = 0;
      node.vy = 0;
      drag.current = { node, pointerId: event.pointerId, start: point, moved: false };
      updateGraphDom(layout, nodeElements.current, edgeElements.current);
    } else {
      pan.current = { pointerId: event.pointerId, start: point, camera: { ...camera.current } };
    }
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const point = svgPoint(svgRef.current, event.clientX, event.clientY);
    if (!point) return;
    hoverPoint.current = cameraPoint(point, camera.current);
    if (!pointers.current.has(event.pointerId)) return;
    event.preventDefault();
    pointers.current.set(event.pointerId, point);

    if (pointers.current.size >= 2) {
      const points = [...pointers.current.values()].slice(0, 2);
      const gesture = pinch.current;
      if (!gesture) return beginPinch();
      const midpoint = midpointOf(points[0], points[1]);
      const scale = clamp(gesture.camera.scale * distanceBetween(points[0], points[1]) / gesture.distance, MIN_ZOOM, MAX_ZOOM);
      updateCamera({
        x: midpoint.x - gesture.anchor.x * scale,
        y: midpoint.y - gesture.anchor.y * scale,
        scale,
      });
      return;
    }

    const currentDrag = drag.current;
    if (currentDrag?.pointerId === event.pointerId) {
      const graphPoint = cameraPoint(point, camera.current);
      currentDrag.moved = currentDrag.moved || distanceBetween(currentDrag.start, point) > 4;
      if (currentDrag.moved) currentDrag.node.pinned = true;
      currentDrag.node.x = clamp(graphPoint.x, BOUNDS, WIDTH - BOUNDS);
      currentDrag.node.y = clamp(graphPoint.y, BOUNDS, HEIGHT - BOUNDS);
      currentDrag.node.vx = 0;
      currentDrag.node.vy = 0;
      rememberPosition(currentDrag.node, positionStore);
      updateGraphDom(layout, nodeElements.current, edgeElements.current);
      return;
    }

    const currentPan = pan.current;
    if (currentPan?.pointerId === event.pointerId) {
      updateCamera({
        x: currentPan.camera.x + point.x - currentPan.start.x,
        y: currentPan.camera.y + point.y - currentPan.start.y,
        scale: currentPan.camera.scale,
      });
    }
  }

  function handlePointerEnd(event: ReactPointerEvent<SVGSVGElement>) {
    if (drag.current?.pointerId === event.pointerId) rememberPosition(drag.current.node, positionStore);
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = undefined;
    pan.current = undefined;
    pinch.current = undefined;
    const remaining = [...pointers.current.entries()][0];
    if (remaining) pan.current = { pointerId: remaining[0], start: remaining[1], camera: { ...camera.current } };
  }

  function releaseNode(node: LayoutNode) {
    node.pinned = false;
    rememberPosition(node, positionStore);
    setInteractionVersion((version) => version + 1);
    selectNode(node);
  }

  return (
    <div className={`graph-visual ${active ? "is-active" : ""} ${selected ? "has-selection" : ""}`}>
      <div className="graph-help"><span>Drag nodes · scroll to zoom</span><span>Drag nodes · pinch to zoom</span></div>
      <button className="graph-reset" type="button" aria-label="Reset graph view" title="Reset graph view" onClick={() => updateCamera({ x: 0, y: 0, scale: 1 })}>
        <ArrowCounterClockwise size={16} />
      </button>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`Interactive StateWeave graph with ${graph.nodes.length} nodes and ${graph.edges.length} edges`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onPointerLeave={() => { hoverPoint.current = undefined; hoveredNodeId.current = undefined; }}
      >
        <g ref={viewportRef} className="graph-viewport">
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
                data-node-id={node.id}
                transform={`translate(${node.x} ${node.y})`}
                role="button"
                tabIndex={0}
                aria-label={`${node.type}: ${node.text}`}
                onPointerEnter={() => { hoveredNodeId.current = node.id; }}
                onPointerLeave={() => { if (hoveredNodeId.current === node.id) hoveredNodeId.current = undefined; }}
                onDoubleClick={() => releaseNode(node)}
                onClick={() => selectNode(node)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") selectNode(node);
                  if (event.key === "Escape") releaseNode(node);
                }}
              >
                <circle r={Math.max(node.radius + 24, 36)} className="node-hit" />
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
        </g>
      </svg>
      {selected ? (
        <section className="node-inspector" aria-label={`${humanType(selected.type)} node context`}>
          <header>
            <span>{humanType(selected.type)}{selected.pinned ? " · pinned" : ""}</span>
            <button type="button" aria-label="Close node context" onClick={() => setSelectedId(undefined)}>
              <X size={15} weight="bold" />
            </button>
          </header>
          <div className="node-inspector-content" tabIndex={0}>
            <p>{selected.text}</p>
          </div>
        </section>
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

function cameraPoint(point: GraphPoint, camera: Camera): GraphPoint {
  return { x: (point.x - camera.x) / camera.scale, y: (point.y - camera.y) / camera.scale };
}

function midpointOf(a: GraphPoint, b: GraphPoint): GraphPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distanceBetween(a: GraphPoint, b: GraphPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
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
