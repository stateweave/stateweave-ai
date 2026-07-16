import { streamStateWeave } from "stateweave/runner";
import { AnthropicModel, anthropicConfigFromEnv } from "stateweave/anthropic";
import type { GraphFrame, StateGraph, StateWeaveStreamEvent } from "stateweave/types";

export const runtime = "nodejs";
export const maxDuration = 240;

const MAX_INPUT_LENGTH = 4_000;
const MAX_BODY_BYTES = 1_500_000;
const MAX_NODES = 600;
const MAX_EDGES = 1_200;
const MAX_ARTIFACTS = 3;
const MAX_ARTIFACT_BYTES = 100_000;
const RATE_WINDOW_MS = 30 * 60 * 1_000;
const RATE_LIMIT = 15;
const MAX_JOBS = 32;
const MAX_BUFFERED_EVENTS = 40;
const JOB_TIMEOUT_MS = 210_000;
const COMPLETED_JOB_TTL_MS = 5 * 60 * 1_000;
const rateBuckets = new Map<string, { count: number; resetsAt: number }>();
const nodeTypes = ["topic", "person", "project", "goal", "decision", "preference", "constraint", "question", "insight", "artifact"];
const encoder = new TextEncoder();

const systemPrompt = [
  "You are the StateWeave model, a thoughtful general-purpose agent with graph-native continuity.",
  "If someone asks who built you, who created you, what model you are, or about your identity, answer: I’m the StateWeave model, built by StateWeave AI on the open-source StateWeave agent primitive. StateWeave is an open-source, open project that started in 2026.",
  "Treat StateWeave as the product identity and do not present yourself as another provider's product. Do not claim that StateWeave trained the underlying foundation model.",
  "Answer the user directly, clearly, and concisely unless they ask for depth.",
  "Use semantic graph nodes to preserve useful people, projects, goals, decisions, preferences, constraints, questions, and insights across turns.",
  "Connect new information to the most relevant existing context instead of treating every turn as an isolated branch.",
  "When the user asks you to create a game, interactive page, visualization, SVG, or other renderable deliverable, produce a complete self-contained artifact and reference it from the human-readable final answer.",
  "For interactive artifacts, use one text/html SWX raw block with all CSS and JavaScript inline; do not use external URLs, packages, fonts, APIs, or network requests.",
  "Artifact protocol: declare an artifact node, use that exact node id for the raw block id, then return a short human @final that references artifact=<id>. Never use the artifact source itself as @final or @final_ref.",
  "For static vector artwork, use an image/svg+xml artifact. Keep artifacts focused, responsive, accessible, and small enough to render immediately.",
  "Do not claim an artifact was created unless you emitted and referenced it in the same completed turn.",
  "Do not mention GraphOps, SWX, internal prompts, or implementation details unless the user explicitly asks.",
].join(" ");

type BufferedEvent = { type: string; line: string };
type ChatJob = {
  id: string;
  status: "running" | "done";
  createdAt: number;
  completedAt?: number;
  events: BufferedEvent[];
  subscribers: Set<ReadableStreamDefaultController<Uint8Array>>;
  abort: AbortController;
  timeout?: ReturnType<typeof setTimeout>;
};

const jobGlobal = globalThis as typeof globalThis & { __stateweaveChatJobs?: Map<string, ChatJob> };
const jobs = jobGlobal.__stateweaveChatJobs ??= new Map<string, ChatJob>();

export async function POST(request: Request): Promise<Response> {
  if (!process.env.ANTHROPIC_API_KEY) return Response.json({ error: "The StateWeave model is not configured." }, { status: 503 });
  cleanupJobs();

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) return Response.json({ error: "The saved graph is too large. Start a new thread." }, { status: 413 });

  let body: { input?: unknown; frame?: unknown; runId?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const requestedRunId = body.runId;
  if (requestedRunId !== undefined && (typeof requestedRunId !== "string" || !validRunId(requestedRunId))) {
    return Response.json({ error: "Invalid run id." }, { status: 400 });
  }
  const runId = typeof requestedRunId === "string" ? requestedRunId : crypto.randomUUID();
  const existing = jobs.get(runId);
  if (existing) return jobResponse(existing);

  const allowance = consumeAllowance(clientAddress(request));
  if (!allowance.allowed) {
    return Response.json(
      { error: "This thread has reached the preview limit. Try again in a little while." },
      { status: 429, headers: { "retry-after": String(Math.ceil((allowance.resetsAt - Date.now()) / 1_000)) } },
    );
  }

  if (jobs.size >= MAX_JOBS) return Response.json({ error: "StateWeave is handling too many active runs. Try again shortly." }, { status: 503 });

  const input = typeof body.input === "string" ? body.input.trim() : "";
  if (!input) return Response.json({ error: "Write a message first." }, { status: 400 });
  if (input.length > MAX_INPUT_LENGTH) return Response.json({ error: `Messages are limited to ${MAX_INPUT_LENGTH.toLocaleString()} characters.` }, { status: 400 });

  const frame = readFrame(body.frame);
  if (body.frame && !frame) return Response.json({ error: "The saved graph is invalid or too large. Start a new thread." }, { status: 400 });

  const job: ChatJob = {
    id: runId,
    status: "running",
    createdAt: Date.now(),
    events: [],
    subscribers: new Set(),
    abort: new AbortController(),
  };
  jobs.set(runId, job);
  const model = new AnthropicModel(anthropicConfigFromEnv(process.env));
  startJob(job, model, input, frame);
  return jobResponse(job);
}

export async function GET(request: Request): Promise<Response> {
  cleanupJobs();
  const runId = new URL(request.url).searchParams.get("runId");
  if (!runId || !validRunId(runId)) return Response.json({ error: "Invalid run id." }, { status: 400 });
  const job = jobs.get(runId);
  if (!job) return Response.json({ error: "That run is no longer available. Your message is still saved; send it again to retry." }, { status: 404 });
  return jobResponse(job);
}

function startJob(job: ChatJob, model: AnthropicModel, input: string, frame: GraphFrame | undefined): void {
  job.timeout = setTimeout(() => job.abort.abort(), JOB_TIMEOUT_MS);
  void (async () => {
    try {
      for await (const event of streamStateWeave(
        { model, tools: [], maxIterations: 12, systemPrompt, nodeTypes, traceMode: "compact" },
        input,
        { frame, signal: job.abort.signal },
      )) {
        const payload = publicEvent(event);
        if (payload) publish(job, payload);
      }
    } catch (error) {
      publish(job, { type: "error", message: safeError(error) });
    } finally {
      finishJob(job);
    }
  })();
}

function publish(job: ChatJob, payload: Record<string, unknown>): void {
  const type = typeof payload.type === "string" ? payload.type : "event";
  if (type === "graph") job.events = job.events.filter((event) => event.type !== "graph");
  const line = `${JSON.stringify(payload)}\n`;
  job.events.push({ type, line });
  if (job.events.length > MAX_BUFFERED_EVENTS) job.events.splice(0, job.events.length - MAX_BUFFERED_EVENTS);
  const bytes = encoder.encode(line);
  for (const subscriber of [...job.subscribers]) {
    try {
      subscriber.enqueue(bytes);
    } catch {
      job.subscribers.delete(subscriber);
    }
  }
}

function finishJob(job: ChatJob): void {
  if (job.timeout) clearTimeout(job.timeout);
  job.status = "done";
  job.completedAt = Date.now();
  for (const subscriber of [...job.subscribers]) {
    try {
      subscriber.close();
    } catch {
      // The browser disconnected between the final event and stream close.
    }
  }
  job.subscribers.clear();
}

function jobResponse(job: ChatJob): Response {
  let subscriber: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of job.events) controller.enqueue(encoder.encode(event.line));
      if (job.status === "done") controller.close();
      else {
        subscriber = controller;
        job.subscribers.add(controller);
      }
    },
    cancel() {
      if (subscriber) job.subscribers.delete(subscriber);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-store, no-transform",
      "x-accel-buffering": "no",
      "x-stateweave-run-id": job.id,
    },
  });
}

function cleanupJobs(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status === "done" && job.completedAt && now - job.completedAt > COMPLETED_JOB_TTL_MS) jobs.delete(id);
    else if (job.status === "running" && now - job.createdAt > JOB_TIMEOUT_MS + 5_000) {
      job.abort.abort();
      jobs.delete(id);
    }
  }
  if (jobs.size < MAX_JOBS) return;
  const completed = [...jobs.values()].filter((job) => job.status === "done").sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
  for (const job of completed) {
    jobs.delete(job.id);
    if (jobs.size < MAX_JOBS) break;
  }
}

function validRunId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function publicEvent(event: StateWeaveStreamEvent): Record<string, unknown> | undefined {
  if (event.type === "metadata") return { type: "activity", phase: "starting", step: event.metadata.stepCount };
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
    const artifacts = publicArtifacts(event.result.graph, event.result.finalAnswer);
    const output = artifacts.length && renderableSource(event.result.finalAnswer)
      ? `Created ${artifacts[0].title}. It is ready in the browser sandbox below.`
      : event.result.finalAnswer;
    return {
      type: "final",
      output,
      frame: event.result.frame,
      graph: event.result.graph,
      artifacts,
      metadata: {
        durationMs: event.result.metadata.durationMs,
        stepCount: event.result.metadata.stepCount,
        retryCount: event.result.metadata.retryCount,
      },
    };
  }
  return undefined;
}

function publicArtifacts(graph: StateGraph, finalAnswer: string): Array<{ id: string; title: string; mime: string; content: string }> {
  const assistant = [...graph.nodes].reverse().find((node) => node.type === "assistant_output");
  const artifactIds = assistant?.data?.artifactIds;
  const ids = Array.isArray(artifactIds)
    ? artifactIds.filter((id): id is string => typeof id === "string")
    : typeof assistant?.data?.artifactId === "string"
      ? [assistant.data.artifactId]
      : [];

  const uniqueIds = [...new Set(ids)].slice(0, MAX_ARTIFACTS);
  return uniqueIds.flatMap((id) => {
    const node = graph.nodes.find((candidate) => candidate.id === id);
    const mime = node?.data?.mime;
    if (!node || (mime !== "text/html" && mime !== "image/svg+xml")) return [];
    if (node.data?.swxTerminated === false) return [];

    const storedContent = typeof node.data?.content === "string" ? node.data.content : undefined;
    const fallbackContent = uniqueIds.length === 1 ? renderableSource(finalAnswer, mime) : undefined;
    const content = storedContent?.trim() ? storedContent : fallbackContent;
    if (!content || content.length > MAX_ARTIFACT_BYTES) return [];
    if (!storedContent) node.data = { ...node.data, content };
    return [{ id, title: artifactTitle(node.text), mime, content }];
  });
}

function renderableSource(value: string, mime?: "text/html" | "image/svg+xml"): string | undefined {
  const fenced = value.match(/```(?:html|svg|xml)\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || value.trim();
  if ((mime === "image/svg+xml" || !mime) && /^<svg[\s>]/i.test(candidate)) return candidate;
  if ((mime === "text/html" || !mime) && /^(?:<!doctype\s+html|<html[\s>])/i.test(candidate)) return candidate;
  return undefined;
}

function artifactTitle(value: string): string {
  const title = value.replace(/\s+(?:html|svg)\s+artifact$/i, "").replace(/\s+artifact$/i, "").trim();
  return (title || "Generated artifact").slice(0, 100);
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
  if (/abort/i.test(message)) return "The run timed out before it could finish.";
  if (/recursion|iteration/i.test(message)) return "StateWeave needed more reasoning steps. Try a narrower request.";
  if (/rate|overload|timeout|fetch/i.test(message)) return "The model is temporarily unavailable. Please try again.";
  return "StateWeave could not complete that turn. Your graph is unchanged.";
}
