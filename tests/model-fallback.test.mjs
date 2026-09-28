import assert from "node:assert/strict";
import test from "node:test";
import { ModelFallback, fallbackReason } from "../app/api/chat/model-fallback.ts";

const output = (text) => ({ text, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
const stream = (...events) => async function* () { for (const event of events) yield event; };
const failingStream = (events, error) => async function* () { for (const event of events) yield event; throw error; };
const model = ({ complete, events }) => ({ complete, stream: events });
const input = { prompt: "hello" };

async function collect(iterable) {
  const rows = [];
  for await (const row of iterable) rows.push(row);
  return rows;
}

test("keeps the primary model when it succeeds", async () => {
  let fallbackCalls = 0;
  const wrapped = new ModelFallback({
    primary: model({ complete: async () => output("primary"), events: stream({ type: "metadata", metadata: { model: "glm-5.3-flash" } }, { type: "token", token: "primary" }) }),
    fallback: model({ complete: async () => { fallbackCalls += 1; return output("backup"); }, events: async function* () { fallbackCalls += 1; yield { type: "token", token: "backup" }; } }),
    primaryModel: "glm-5.3-flash",
    fallbackModel: "glm-5.2",
  });
  assert.equal((await wrapped.complete(input)).text, "primary");
  assert.deepEqual(await collect(wrapped.stream(input)), [{ type: "metadata", metadata: { model: "glm-5.3-flash" } }, { type: "token", token: "primary" }]);
  assert.equal(fallbackCalls, 0);
});

test("falls back once when the primary completion is temporarily unavailable", async () => {
  const seen = [];
  const wrapped = new ModelFallback({
    primary: model({ complete: async () => { throw new Error("Anthropic request failed (503): model temporarily unavailable"); }, events: stream() }),
    fallback: model({ complete: async () => output("backup"), events: stream() }),
    primaryModel: "glm-5.3-flash",
    fallbackModel: "glm-5.2",
    onFallback: (event) => seen.push(event),
  });
  assert.equal((await wrapped.complete(input)).text, "backup");
  assert.deepEqual(seen, [{ fromModel: "glm-5.3-flash", toModel: "glm-5.2", reason: "unavailable" }]);
});

test("does not hide rejected credentials or client errors", async () => {
  let fallbackCalls = 0;
  const wrapped = new ModelFallback({
    primary: model({ complete: async () => { throw new Error("Anthropic request failed (401): invalid key"); }, events: stream() }),
    fallback: model({ complete: async () => { fallbackCalls += 1; return output("backup"); }, events: stream() }),
    primaryModel: "glm-5.3-flash",
    fallbackModel: "glm-5.2",
  });
  await assert.rejects(wrapped.complete(input), /401/);
  assert.equal(fallbackCalls, 0);
});

test("discards uncommitted primary metadata and visibly falls back before text", async () => {
  const wrapped = new ModelFallback({
    primary: model({ complete: async () => output("unused"), events: failingStream([{ type: "metadata", metadata: { model: "glm-5.3-flash" } }], new Error("fetch failed")) }),
    fallback: model({ complete: async () => output("unused"), events: stream({ type: "metadata", metadata: { model: "glm-5.2" } }, { type: "token", token: "backup" }) }),
    primaryModel: "glm-5.3-flash",
    fallbackModel: "glm-5.2",
  });
  const rows = await collect(wrapped.stream(input));
  assert.deepEqual(rows, [
    { type: "metadata", metadata: { provider: "stateweave", event: "model_fallback", fromModel: "glm-5.3-flash", toModel: "glm-5.2", reason: "network" } },
    { type: "metadata", metadata: { model: "glm-5.2" } },
    { type: "token", token: "backup" },
  ]);
});

test("never restarts a stream after visible primary text", async () => {
  let fallbackStarted = false;
  const wrapped = new ModelFallback({
    primary: model({ complete: async () => output("unused"), events: failingStream([{ type: "token", token: "partial" }], new Error("Anthropic request failed (503): overloaded")) }),
    fallback: model({ complete: async () => output("unused"), events: async function* () { fallbackStarted = true; yield { type: "token", token: "backup" }; } }),
    primaryModel: "glm-5.3-flash",
    fallbackModel: "glm-5.2",
  });
  const rows = [];
  await assert.rejects(async () => { for await (const row of wrapped.stream(input)) rows.push(row); }, /503/);
  assert.deepEqual(rows, [{ type: "token", token: "partial" }]);
  assert.equal(fallbackStarted, false);
});

test("uses the fallback for an empty primary stream", async () => {
  const wrapped = new ModelFallback({
    primary: model({ complete: async () => output(""), events: stream({ type: "metadata", metadata: { stopReason: "max_tokens" } }) }),
    fallback: model({ complete: async () => output("backup"), events: stream({ type: "token", token: "backup" }) }),
    primaryModel: "glm-5.3-flash",
    fallbackModel: "glm-5.2",
  });
  const rows = await collect(wrapped.stream(input));
  assert.equal(rows[0].metadata.reason, "empty_response");
  assert.equal(rows[1].token, "backup");
});

test("never falls back after cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(fallbackReason(new DOMException("aborted", "AbortError"), controller.signal), undefined);
});
