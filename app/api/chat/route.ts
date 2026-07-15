import { streamStateWeave } from "stateweave/runner";
import { AnthropicModel, anthropicConfigFromEnv } from "stateweave/anthropic";
import type { GraphFrame, StateWeaveStreamEvent } from "stateweave/types";

export const runtime = "nodejs";
export const maxDuration = 180;

const MAX_INPUT_LENGTH = 4_000;
const MAX_BODY_BYTES = 1_500_000;
const MAX_NODES = 600;
const MAX_EDGES = 1_200;
const RATE_WINDOW_MS = 30 * 60 * 1_000;
const RATE_LIMIT = 15;
const rateBuckets = new Map<string, { count: number; resetsAt: number }>();
const nodeTypes = ["topic", "person", "project", "goal", "decision", "preference", "constraint", "question", "insight"];

const systemPrompt = [
  "You are the StateWeave agent, a thoughtful general-purpose assistant with graph-native continuity.",
  "Answer the user directly, clearly, and concisely unless they ask for depth.",
  "Use semantic graph nodes to preserve useful people, projects, goals, decisions, preferences, constraints, questions, and insights across turns.",
  "Connect new information to the most relevant existing context instead of treating every turn as an isolated branch.",
  "Do not mention GraphOps, SWX, internal prompts, or implementation details unless the user explicitly asks.",
].join(" ");

export async function POST(request: Request): Promise<Response> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "The StateWeave model is not configured." }, { status: 503 });
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) return Response.json({ error: "The saved graph is too large. Start a new thread." }, { status: 413 });

  const allowance = consumeAllowance(clientAddress(request));
  if (!allowance.allowed) {
    return Response.json(
      { error: "This thread has reached the preview limit. Try again in a little while." },
      { status: 429, headers: { "retry-after": String(Math.ceil((allowance.resetsAt - Date.now()) / 1_000)) } },
    );
  }

  let body: { input?: unknown; frame?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const input = typeof body.input === "string" ? body.input.trim() : "";
  if (!input) return Response.json({ error: "Write a message first." }, { status: 400 });
  if (input.length > MAX_INPUT_LENGTH) return Response.json({ error: `Messages are limited to ${MAX_INPUT_LENGTH.toLocaleString()} characters.` }, { status: 400 });

  const frame = readFrame(body.frame);
  if (body.frame && !frame) return Response.json({ error: "The saved graph is invalid or too large. Start a new thread." }, { status: 400 });

  const model = new AnthropicModel(anthropicConfigFromEnv(process.env));

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: Record<string, unknown>) => controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      try {
        for await (const event of streamStateWeave(
          { model, tools: [], maxIterations: 12, systemPrompt, nodeTypes, traceMode: "compact" },
          input,
          { frame, signal: request.signal },
        )) {
          const payload = publicEvent(event);
          if (payload) send(payload);
        }
      } catch (error) {
        send({ type: "error", message: safeError(error) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

function publicEvent(event: StateWeaveStreamEvent): Record<string, unknown> | undefined {
  if (event.type === "metadata") return { type: "activity", phase: "thinking", step: event.metadata.stepCount };
  if (event.type === "frame") {
    return {
      type: "graph",
      phase: event.phase,
      step: event.step,
      frame: event.frame,
      graph: event.frame.graph,
    };
  }
  if (event.type === "ops") return { type: "activity", phase: "weaving", step: event.step, operationCount: event.ops.length };
  if (event.type === "worker") return { type: "activity", phase: event.phase, step: event.step };
  if (event.type === "error") return { type: "activity", phase: event.retryable ? "retrying" : "error", step: event.step };
  if (event.type === "final") {
    return {
      type: "final",
      output: event.result.finalAnswer,
      frame: event.result.frame,
      graph: event.result.graph,
      metadata: {
        durationMs: event.result.metadata.durationMs,
        stepCount: event.result.metadata.stepCount,
        retryCount: event.result.metadata.retryCount,
      },
    };
  }
  return undefined;
}

function readFrame(value: unknown): GraphFrame | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object") return undefined;
  const frame = value as GraphFrame;
  if (!frame.frame || !frame.graph || !Array.isArray(frame.graph.nodes) || !Array.isArray(frame.graph.edges)) return undefined;
  if (frame.graph.nodes.length > MAX_NODES || frame.graph.edges.length > MAX_EDGES) return undefined;
  if (!frame.graph.nodes.every((node) => node && typeof node.id === "string" && typeof node.type === "string" && typeof node.text === "string")) return undefined;
  if (!frame.graph.edges.every((edge) => edge && typeof edge.id === "string" && typeof edge.from === "string" && typeof edge.to === "string" && typeof edge.type === "string")) return undefined;
  return frame;
}

function consumeAllowance(key: string): { allowed: boolean; resetsAt: number } {
  const now = Date.now();
  if (rateBuckets.size > 5_000) {
    for (const [address, bucket] of rateBuckets) if (bucket.resetsAt <= now) rateBuckets.delete(address);
  }
  const current = rateBuckets.get(key);
  if (!current || current.resetsAt <= now) {
    const resetsAt = now + RATE_WINDOW_MS;
    rateBuckets.set(key, { count: 1, resetsAt });
    return { allowed: true, resetsAt };
  }
  if (current.count >= RATE_LIMIT) return { allowed: false, resetsAt: current.resetsAt };
  current.count += 1;
  return { allowed: true, resetsAt: current.resetsAt };
}

function clientAddress(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || "unknown";
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/abort/i.test(message)) return "The request was cancelled.";
  if (/recursion|iteration/i.test(message)) return "StateWeave needed more reasoning steps. Try a narrower request.";
  if (/rate|overload|timeout|fetch/i.test(message)) return "The model is temporarily unavailable. Please try again.";
  return "StateWeave could not complete that turn. Your graph is unchanged.";
}
