import type { Model, ModelInput, ModelOutput, ModelToken } from "stateweave";

export type ModelFallbackReason = "empty_response" | "rate_limited" | "timeout" | "overloaded" | "unavailable" | "network" | "server_error";

export type ModelFallbackEvent = {
  fromModel: string;
  toModel: string;
  reason: ModelFallbackReason;
};

type ModelFallbackOptions = {
  primary: Model;
  fallback: Model;
  primaryModel: string;
  fallbackModel: string;
  onFallback?: (event: ModelFallbackEvent) => void;
};

export class ModelFallback implements Model {
  private readonly primary: Model;
  private readonly fallback: Model;
  private readonly primaryModel: string;
  private readonly fallbackModel: string;
  private readonly onFallback?: (event: ModelFallbackEvent) => void;

  constructor(options: ModelFallbackOptions) {
    this.primary = options.primary;
    this.fallback = options.fallback;
    this.primaryModel = options.primaryModel;
    this.fallbackModel = options.fallbackModel;
    this.onFallback = options.onFallback;
  }

  async complete(input: ModelInput): Promise<ModelOutput> {
    try {
      const output = await this.primary.complete(input);
      if (output.text.trim()) return output;
      if (input.signal?.aborted) input.signal.throwIfAborted();
      return this.fallbackComplete(input, "empty_response");
    } catch (error) {
      const reason = fallbackReason(error, input.signal);
      if (!reason) throw error;
      return this.fallbackComplete(input, reason);
    }
  }

  async *stream(input: ModelInput): AsyncIterable<ModelToken> {
    const pendingMetadata: ModelToken[] = [];
    let emittedText = false;
    try {
      for await (const event of this.primary.stream(input)) {
        if (!emittedText && event.type === "metadata") {
          pendingMetadata.push(event);
          continue;
        }
        if (!emittedText) {
          emittedText = true;
          for (const metadata of pendingMetadata) yield metadata;
        }
        yield event;
      }
      if (emittedText) return;
    } catch (error) {
      if (emittedText) throw error;
      const reason = fallbackReason(error, input.signal);
      if (!reason) throw error;
      yield* this.fallbackStream(input, reason);
      return;
    }
    if (input.signal?.aborted) input.signal.throwIfAborted();
    yield* this.fallbackStream(input, "empty_response");
  }

  private async fallbackComplete(input: ModelInput, reason: ModelFallbackReason): Promise<ModelOutput> {
    this.report(reason);
    return this.fallback.complete(input);
  }

  private async *fallbackStream(input: ModelInput, reason: ModelFallbackReason): AsyncIterable<ModelToken> {
    this.report(reason);
    yield {
      type: "metadata",
      metadata: {
        provider: "stateweave",
        event: "model_fallback",
        fromModel: this.primaryModel,
        toModel: this.fallbackModel,
        reason,
      },
    };
    yield* this.fallback.stream(input);
  }

  private report(reason: ModelFallbackReason): void {
    this.onFallback?.({ fromModel: this.primaryModel, toModel: this.fallbackModel, reason });
  }
}

export function fallbackReason(error: unknown, signal?: AbortSignal): ModelFallbackReason | undefined {
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) return undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (/\b429\b|rate.?limit|quota/i.test(message)) return "rate_limited";
  if (/timeout|timed out|deadline/i.test(message)) return "timeout";
  if (/overload|capacity/i.test(message)) return "overloaded";
  if (/not available|unavailable|no available model/i.test(message)) return "unavailable";
  if (/fetch|network|econn|enotfound|socket|und_err/i.test(message)) return "network";
  if (/\((408|409|425|500|502|503|504)\)/.test(message)) return "server_error";
  return undefined;
}
