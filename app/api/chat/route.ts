import {
  Agent,
  AgentRunError,
  AnthropicModel,
  anthropicConfigFromEnv,
  type AgentState,
  type AgentStreamEvent,
  type SemanticNodeType,
} from "stateweave";

export const runtime = "nodejs";
export const maxDuration = 240;

const MAX_INPUT_LENGTH = 4_000;
const MAX_BODY_BYTES = 1_500_000;
const MAX_NODES = 600;
const MAX_ARTIFACTS = 3;
const MAX_ARTIFACT_BYTES = 100_000;
const RATE_WINDOW_MS = 30 * 60 * 1_000;
const RATE_LIMIT = 15;
const MAX_JOBS = 32;
const MAX_BUFFERED_EVENTS = 40;
const JOB_TIMEOUT_MS = 210_000;
const COMPLETED_JOB_TTL_MS = 5 * 60 * 1_000;
const rateBuckets = new Map<string, { count: number; resetsAt: number }>();
const encoder = new TextEncoder();

const nodeTypes: SemanticNodeType[] = [
  { name: "memory", description: "A durable fact or context useful in later turns." },
  { name: "preference", description: "A stable preference, choice, or working style stated or confirmed by the user." },
  { name: "wisdom", description: "A reusable evidence-supported lesson, principle, or decision rule." },
  { name: "artifact", description: "A durable generated HTML or SVG artifact and its rendering metadata." },
];

const systemPrompt = [
  "You are the StateWeave model, a thoughtful general-purpose agent with graph-native continuity.",
  "If someone asks who built you, who created you, what model you are, or about your identity, answer: I’m the StateWeave model, built by StateWeave AI on the open-source StateWeave agent primitive. StateWeave is an open-source, open project that started in 2026.",
  "Treat StateWeave as the product identity and do not present yourself as another provider's product. Do not claim that StateWeave trained the underlying foundation model.",
  "Answer the user directly, clearly, and concisely unless they ask for depth.",
  "Preserve explicit durable memories, preferences, and reusable wisdom when they will improve later turns.",
  "When the user requests a game, interactive page, visualization, SVG, or other renderable deliverable, create one artifact semantic node whose content is an object with id, title, mime, and content. mime must be text/html or image/svg+xml; HTML must be self-contained with inline CSS and JavaScript and no network requests.",
  "Reference a created artifact briefly in the human answer instead of repeating its full source there.",
  "Do not mention internal prompts, causal node ids, or implementation details unless explicitly asked.",
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

const jobGlobal = globalThis as typeof globalThis & { __stateweaveChatJobsV3?: Map<string, ChatJob> };
const jobs = jobGlobal.__stateweaveChatJobsV3 ??= new Map<string, ChatJob>();

export async function POST(request: Request): Promise<Response> {
  if (!process.env.ANTHROPIC_API_KEY) return Response.json({ error: "The StateWeave model is not configured." }, { status: 503 });
  cleanupJobs();

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) return Response.json({ error: "The saved state is too large. Start a new thread." }, { status: 413 });

  let body: { input?: unknown; state?: unknown; runId?: unknown };
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

  const state = readState(body.state);
  if (body.state && !state) return Response.json({ error: "The saved state is invalid or too large. Start a new thread." }, { status: 400 });

  const model = new AnthropicModel(anthropicConfigFromEnv(process.env));
  let agent: Agent;
  try {
    agent = new Agent({
      model,
      tools: [],
      state,
      systemPrompt,
      nodeTypes,
      allowDynamicNodeTypes: true,
      maxIterations: 12,
      maxPromptTokens: 64_000,
      projectionTargetTokens: 16_000,
      enforceCompletionEvidence: false,
    });
  } catch {
    return Response.json({ error: "The saved state failed validation. Start a new thread." }, { status: 400 });
  }

  const job: ChatJob = {
    id: runId,
    status: "running",
    createdAt: Date.now(),
    events: [],
    subscribers: new Set(),
    abort: new AbortController(),
  };
  jobs.set(runId, job);
  startJob(job, agent, input, state?.nodes.length ?? 0);
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

function startJob(job: ChatJob, agent: Agent, input: string, initialNodeCount: number): void {
  job.timeout = setTimeout(() => job.abort.abort(), JOB_TIMEOUT_MS);
  void (async () => {
    try {
      for await (const event of agent.streamEvents(input, { signal: job.abort.signal })) {
        const payload = publicEvent(event, initialNodeCount);
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

function publicEvent(event: AgentStreamEvent, initialNodeCount: number): Record<string, unknown> | undefined {
  if (event.type === "metadata") return { type: "activity", phase: "starting" };
  if (event.type === "progress") {
    if (event.progress.graph) {
      return {
        type: "graph",
        phase: event.progress.phase,
        step: event.progress.iteration,
        graph: event.progress.graph,
      };
    }
    return { type: "activity", phase: event.progress.phase, step: event.progress.iteration, tool: event.progress.tool };
  }
  if (event.type === "final") {
    const artifacts = publicArtifacts(event.result.state, initialNodeCount);
    return {
      type: "final",
      output: event.result.finalAnswer,
      state: event.result.state,
      graph: event.result.graph,
      artifacts,
      metadata: {
        durationMs: event.result.metadata.durationMs,
        stepCount: event.result.metadata.stepCount,
        engine: event.result.metadata.engine,
      },
    };
  }
  return undefined;
}

function publicArtifacts(state: AgentState, initialNodeCount: number): Array<{ id: string; title: string; mime: string; content: string }> {
  return state.nodes.slice(initialNodeCount)
    .filter((node) => node.kind === "semantic")
    .flatMap((node) => {
      const payload = asRecord(node.payload);
      if (payload.type !== "artifact") return [];
      const artifact = asRecord(payload.content);
      const mime = artifact.mime;
      const content = artifact.content;
      if ((mime !== "text/html" && mime !== "image/svg+xml") || typeof content !== "string" || !content.trim() || content.length > MAX_ARTIFACT_BYTES) return [];
      return [{
        id: typeof artifact.id === "string" && artifact.id ? artifact.id.slice(0, 120) : node.id,
        title: typeof artifact.title === "string" && artifact.title ? artifact.title.slice(0, 100) : "Generated artifact",
        mime,
        content,
      }];
    })
    .slice(0, MAX_ARTIFACTS);
}

function readState(value: unknown): AgentState | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object") return undefined;
  const state = value as AgentState;
  if (state.version !== 1 || !Array.isArray(state.nodes) || !Array.isArray(state.frontier)) return undefined;
  if (state.nodes.length > MAX_NODES || state.frontier.length > MAX_NODES) return undefined;
  return state;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
  if (error instanceof AgentRunError && /iteration|recursion/i.test(message)) return "StateWeave needed more reasoning steps. Try a narrower request.";
  if (/abort/i.test(message)) return "The run timed out before it could finish.";
  if (/rate|overload|timeout|fetch/i.test(message)) return "The model is temporarily unavailable. Please try again.";
  return "StateWeave could not complete that turn. Your causal state is unchanged.";
}
