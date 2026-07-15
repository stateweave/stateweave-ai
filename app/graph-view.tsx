"use client";

import { useMemo, useState } from "react";

type GraphNode = {
  id: string;
  type: string;
  text: string;
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

type PositionedNode = GraphNode & { x: number; y: number; radius: number };

const WIDTH = 720;
const HEIGHT = 560;
const MAX_VISIBLE_NODES = 110;

export function GraphView({ graph, active }: { graph: StateGraph; active: boolean }) {
  const [selectedId, setSelectedId] = useState<string>();
  const layout = useMemo(() => buildLayout(graph), [graph]);
  const selected = layout.nodes.find((node) => node.id === selectedId);
  const latestIds = new Set(layout.nodes.slice(-7).map((node) => node.id));

  if (!layout.nodes.length) {
    return (
      <div className="graph-empty" aria-label="Empty StateWeave graph">
        <span className="empty-node" />
        <p>Your memory starts with your first thought.</p>
      </div>
    );
  }

  return (
    <div className={`graph-visual ${active ? "is-active" : ""}`}>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`StateWeave graph with ${graph.nodes.length} nodes and ${graph.edges.length} edges`}>
        <g className="graph-edges">
          {layout.edges.map((edge) => (
            <line
              key={edge.id}
              x1={edge.fromNode.x}
              y1={edge.fromNode.y}
              x2={edge.toNode.x}
              y2={edge.toNode.y}
              className={`graph-edge edge-${slug(edge.type)}`}
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
                className={`graph-node node-${slug(node.type)} ${selectedNode ? "is-selected" : ""}`}
                style={{ transform: `translate(${node.x}px, ${node.y}px)` }}
                role="button"
                tabIndex={0}
                aria-label={`${node.type}: ${node.text}`}
                onClick={() => setSelectedId(node.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") setSelectedId(node.id);
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
          <span>{humanType(selected.type)}</span>
          <p>{selected.text}</p>
        </div>
      ) : null}
    </div>
  );
}

function buildLayout(graph: StateGraph): {
  nodes: PositionedNode[];
  edges: Array<GraphEdge & { fromNode: PositionedNode; toNode: PositionedNode }>;
} {
  const visible = visibleNodes(graph);
  if (!visible.length) return { nodes: [], edges: [] };

  const visibleIds = new Set(visible.map((node) => node.id));
  const edges = graph.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));
  const root = visible.find((node) => node.id === "system_root" || node.type === "system") ?? visible[0];
  const depths = graphDepths(root.id, visibleIds, edges);
  const groups = new Map<number, GraphNode[]>();

  for (const node of visible) {
    const depth = depths.get(node.id) ?? Math.max(3, Math.ceil(Math.sqrt(visible.length)));
    const group = groups.get(depth) ?? [];
    group.push(node);
    groups.set(depth, group);
  }

  const positioned: PositionedNode[] = [];
  for (const [depth, group] of [...groups.entries()].sort(([a], [b]) => a - b)) {
    group.sort((a, b) => hash(a.id) - hash(b.id));
    if (depth === 0) {
      positioned.push({ ...group[0], x: WIDTH / 2, y: HEIGHT / 2, radius: 10 });
      continue;
    }
    const ring = Math.min(76 + depth * 60, 244);
    const offset = ((hash(`${depth}:${group.length}`) % 628) / 100) - Math.PI;
    group.forEach((node, index) => {
      const angle = offset + (Math.PI * 2 * index) / group.length;
      const jitter = ((hash(node.id) % 21) - 10) * 0.7;
      positioned.push({
        ...node,
        x: WIDTH / 2 + Math.cos(angle) * (ring + jitter) * 1.22,
        y: HEIGHT / 2 + Math.sin(angle) * (ring + jitter) * 0.88,
        radius: nodeRadius(node.type),
      });
    });
  }

  const nodeMap = new Map(positioned.map((node) => [node.id, node]));
  return {
    nodes: positioned,
    edges: edges.flatMap((edge) => {
      const fromNode = nodeMap.get(edge.from);
      const toNode = nodeMap.get(edge.to);
      return fromNode && toNode ? [{ ...edge, fromNode, toNode }] : [];
    }),
  };
}

function visibleNodes(graph: StateGraph): GraphNode[] {
  if (graph.nodes.length <= MAX_VISIBLE_NODES) return graph.nodes;
  const root = graph.nodes.find((node) => node.id === "system_root" || node.type === "system");
  const recent = graph.nodes.slice(-(MAX_VISIBLE_NODES - (root ? 1 : 0)));
  return root && !recent.some((node) => node.id === root.id) ? [root, ...recent] : recent;
}

function graphDepths(rootId: string, nodeIds: Set<string>, edges: GraphEdge[]): Map<string, number> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const from = adjacency.get(edge.from) ?? [];
    const to = adjacency.get(edge.to) ?? [];
    from.push(edge.to);
    to.push(edge.from);
    adjacency.set(edge.from, from);
    adjacency.set(edge.to, to);
  }
  const depths = new Map([[rootId, 0]]);
  const queue = [rootId];
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    const depth = depths.get(id) ?? 0;
    for (const neighbor of adjacency.get(id) ?? []) {
      if (!nodeIds.has(neighbor) || depths.has(neighbor)) continue;
      depths.set(neighbor, depth + 1);
      queue.push(neighbor);
    }
  }
  return depths;
}

function nodeRadius(type: string): number {
  if (type === "system") return 10;
  if (type === "user_input") return 8;
  if (type === "assistant_output") return 7;
  return 6;
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
