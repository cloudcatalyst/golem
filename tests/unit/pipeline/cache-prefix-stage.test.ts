/**
 * R8.1 — cache-prefix classification driven through `pipeline.process()`.
 *
 * Complements cache-prefix.test.ts (which unit-tests the classifier): here the
 * assertions are about the pipeline's contract — that the verdict reaches the
 * emitted event, that observation NEVER alters the forwarded bytes, and that a
 * conversation's chain survives requests the pipeline leaves unchanged.
 */

import { describe, expect, it } from "vitest";
import { NativeLosslessCompression } from "../../../src/compression/index.js";
import { LocalDirBlobStore } from "../../../src/compression/local-blob-store.js";
import { type CompressionLevel, policyFor } from "../../../src/interfaces/policy.js";
import { createGolemPipeline, type PipelineEvent } from "../../../src/pipeline/index.js";
import type { ProxyRequest } from "../../../src/proxy/types.js";

function makePipeline(level: CompressionLevel, onEvent?: (e: PipelineEvent) => void) {
  return createGolemPipeline({
    compression: new NativeLosslessCompression(new LocalDirBlobStore("/nonexistent-ccr")),
    policy: () => policyFor(level),
    projectId: "proj",
    ...(onEvent !== undefined ? { onEvent } : {}),
  });
}

function request(body: unknown): ProxyRequest {
  return {
    method: "POST",
    url: "/v1/messages",
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body), "utf8"),
  };
}

const TOOLS = [{ name: "search", description: "find things", input_schema: { type: "object" } }];

function convo(messages: unknown[], tools: unknown = TOOLS): Record<string, unknown> {
  return {
    model: "claude-opus-5",
    tools,
    system: "You are a helpful assistant.",
    messages,
  };
}

/**
 * A `tool_result` message carrying whitespace the lossless compaction stage will
 * strip.
 *
 * Needed because the pipeline emits **no event** when a request comes back
 * byte-identical (an established convention — see the semantic and
 * context-substitution stage tests), and no event means no verdict. Every test
 * below that expects a verdict therefore has to give the pipeline something real
 * to do. The coverage consequence of that convention is asserted explicitly at
 * the end of this file, and disclosed in the report `renderCacheReport` prints.
 */
function compactable(text: string): Record<string, unknown> {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t1", content: `${text}   \n\n\n\n` }],
  };
}

const TURN_1 = [compactable("first question")];
const TURN_2 = [...TURN_1, { role: "assistant", content: "an answer" }];
const TURN_3 = [...TURN_2, compactable("second question")];

describe("pipeline cache-prefix classification (R8.1)", () => {
  it("reports `first` then `append` as a conversation grows", async () => {
    const events: PipelineEvent[] = [];
    const pipeline = makePipeline(3, (e) => events.push(e));
    await pipeline.process(request(convo(TURN_1)));
    await pipeline.process(request(convo(TURN_2)));
    await pipeline.process(request(convo(TURN_3)));
    expect(events.map((e) => e.cachePrefix)).toEqual(["first", "append", "append"]);
    expect(events.every((e) => e.cacheBustComponent === undefined)).toBe(true);
  });

  it("reports a `bust` with its component when the tools block changes mid-conversation", async () => {
    const events: PipelineEvent[] = [];
    const pipeline = makePipeline(3, (e) => events.push(e));
    await pipeline.process(request(convo(TURN_1)));
    await pipeline.process(request(convo(TURN_2, [...TOOLS, { name: "added" }])));
    expect(events[1]?.cachePrefix).toBe("bust");
    expect(events[1]?.cacheBustComponent).toBe("tools");
  });

  it("blames `messages` when already-sent history is edited", async () => {
    const events: PipelineEvent[] = [];
    const pipeline = makePipeline(3, (e) => events.push(e));
    await pipeline.process(request(convo(TURN_2)));
    await pipeline.process(
      request(convo([TURN_1[0], { role: "assistant", content: "a DIFFERENT answer" }])),
    );
    expect(events[1]?.cachePrefix).toBe("bust");
    expect(events[1]?.cacheBustComponent).toBe("messages");
  });

  it("does not alter the forwarded bytes — observation is read-only", async () => {
    // Nothing to redact or compact: the request must come back byte-identical,
    // exactly as it did before R8.1 existed.
    const pipeline = makePipeline(1);
    const original = request(convo([{ role: "user", content: "clean" }]));
    const originalBytes = Buffer.from(original.body as Buffer);
    const out = await pipeline.process(original);
    expect(Buffer.compare(out.body as Buffer, originalBytes)).toBe(0);
  });

  it("keeps separate conversations separate", async () => {
    const events: PipelineEvent[] = [];
    const pipeline = makePipeline(3, (e) => events.push(e));
    await pipeline.process(request(convo(TURN_1)));
    await pipeline.process(request(convo([compactable("an unrelated thread")])));
    await pipeline.process(request(convo(TURN_2)));
    // first (A), first (B), append (A) — B must not look like an edit of A.
    expect(events.map((e) => e.cachePrefix)).toEqual(["first", "first", "append"]);
  });

  it("emits no verdict at compression `off` when nothing changed", async () => {
    const events: PipelineEvent[] = [];
    const pipeline = makePipeline("off", (e) => events.push(e));
    const req = request(convo(TURN_1));
    const out = await pipeline.process(req);
    // R11.1: the REASON changed even though the assertion did not. This used to
    // hold because level 0 was a full bypass where no stage ran at all. At `off`
    // redaction DOES run (see the policy contract) — it just has nothing to redact
    // in this fixture, so no stage changed anything and the pipeline takes its
    // byte-identical path, which emits no event at any level. The full bypass now
    // lives in `proxy.bypass_all`, where the proxy never calls process() at all
    // (tests/integration/proxy-bypass-shim.test.ts covers that path).
    expect(events).toHaveLength(0);
    expect(out).toBe(req);
  });

  it("emits no verdict for a byte-faithful request — the coverage limit, stated", async () => {
    // A request the pipeline leaves untouched takes the early-return path and
    // emits no event (the established convention, shared with the semantic and
    // context-substitution stages), so it carries no verdict. The observer's
    // chain is still advanced internally — that is what keeps the *next*
    // verdict correctly timed, and it is asserted directly in
    // cache-prefix.test.ts ("re-baselines after a bust").
    //
    // `renderCacheReport` discloses this rather than letting a thin sample look
    // like a clean bill of health.
    const events: PipelineEvent[] = [];
    const pipeline = makePipeline(3, (e) => events.push(e));
    await pipeline.process(request(convo([{ role: "user", content: "nothing to change" }])));
    expect(events).toHaveLength(0);
  });

  it("survives a non-JSON body without classifying anything", async () => {
    const events: PipelineEvent[] = [];
    const pipeline = makePipeline(3, (e) => events.push(e));
    const out = await pipeline.process({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json" },
      body: Buffer.from("not json at all", "utf8"),
    });
    expect(out.body?.toString("utf8")).toBe("not json at all");
    expect(events).toHaveLength(0);
  });
});
