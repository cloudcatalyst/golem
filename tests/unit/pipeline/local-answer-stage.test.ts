/**
 * Pipeline "Stage 1.5" — the local-answer sub-mode (R2.3, spec Decision 24
 * sub-mode 2 / Decision 33). Driven directly through pipeline.process() with
 * a stub LocalAnswerService, asserting the eligibility gate, the
 * respondDirectly short-circuit, and the emitted avoidedUpstream* telemetry —
 * mirroring tests/unit/pipeline/context-substitution-stage.test.ts's pattern.
 */

import { describe, expect, it, vi } from "vitest";
import { LocalDirBlobStore, NativeLosslessCompression } from "../../../src/compression/index.js";
import type {
  LocalAnswerQuery,
  LocalAnswerResult,
  LocalAnswerService,
} from "../../../src/interfaces/local-answer.js";
import { policyFor } from "../../../src/interfaces/policy.js";
import { createGolemPipeline, type PipelineEvent } from "../../../src/pipeline/index.js";
import type { ProxyRequest } from "../../../src/proxy/types.js";

function messagesRequest(messages: unknown, extra: Record<string, unknown> = {}): ProxyRequest {
  return {
    method: "POST",
    url: "/v1/messages",
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ model: "claude-x", messages, ...extra }), "utf8"),
  };
}

function bodyOf(req: ProxyRequest): Record<string, unknown> {
  return JSON.parse((req.body as Buffer).toString("utf8"));
}

/** A stub service that answers confidently for one exact query string, else declines. */
function stubService(opts: {
  answersFor?: string;
  answerText?: string;
  calls?: LocalAnswerQuery[];
}): LocalAnswerService {
  return {
    tryAnswer(query: LocalAnswerQuery): Promise<LocalAnswerResult> {
      opts.calls?.push(query);
      if (opts.answersFor !== undefined && query.text === opts.answersFor) {
        return Promise.resolve({
          answered: true,
          text: opts.answerText ?? "the answer",
          sources: [{ sourcePath: "docs/wiki/x.md", score: 0.9 }],
        });
      }
      return Promise.resolve({ answered: false });
    },
  };
}

function makePipeline(
  service: LocalAnswerService | undefined,
  onEvent: (e: PipelineEvent) => void,
) {
  const compression = new NativeLosslessCompression(new LocalDirBlobStore("/nonexistent-ccr"));
  return createGolemPipeline({
    compression,
    policy: () => policyFor(1),
    projectId: "proj",
    onEvent,
    ...(service !== undefined ? { localAnswer: { service } } : {}),
  });
}

describe("pipeline local-answer stage (R2.3)", () => {
  it("short-circuits an eligible, confidently-answered request with respondDirectly", async () => {
    const events: PipelineEvent[] = [];
    const pipe = makePipeline(stubService({ answersFor: "how do I deploy?" }), (e) =>
      events.push(e),
    );

    const out = await pipe.process(
      messagesRequest([{ role: "user", content: "how do I deploy?" }]),
    );

    expect(out.respondDirectly).toBeDefined();
    const payload = JSON.parse(out.respondDirectly?.body.toString("utf8") ?? "{}");
    expect(payload.content).toEqual([{ type: "text", text: "the answer" }]);

    expect(events).toHaveLength(1);
    expect(events[0]?.avoidedUpstreamInputTokens).toBeGreaterThan(0);
    expect(events[0]?.avoidedUpstreamOutputTokens).toBeGreaterThan(0);
    expect(events[0]?.ccrRefsStored).toBe(0);
  });

  it("synthesizes an SSE response when the request asked to stream", async () => {
    const events: PipelineEvent[] = [];
    const pipe = makePipeline(stubService({ answersFor: "how do I deploy?" }), (e) =>
      events.push(e),
    );

    const out = await pipe.process(
      messagesRequest([{ role: "user", content: "how do I deploy?" }], { stream: true }),
    );

    expect(out.respondDirectly?.headers["content-type"]).toBe("text/event-stream");
  });

  it("falls through to the normal pipeline when the service declines (answered: false)", async () => {
    const events: PipelineEvent[] = [];
    const pipe = makePipeline(stubService({ answersFor: "something else entirely" }), (e) =>
      events.push(e),
    );

    const out = await pipe.process(
      messagesRequest([{ role: "user", content: "how do I deploy?" }]),
    );

    expect(out.respondDirectly).toBeUndefined();
    expect(bodyOf(out).messages).toEqual([{ role: "user", content: "how do I deploy?" }]);
  });

  it("never calls the service for an ineligible (multi-turn) request", async () => {
    const calls: LocalAnswerQuery[] = [];
    const events: PipelineEvent[] = [];
    const pipe = makePipeline(stubService({ answersFor: "how do I deploy?", calls }), (e) =>
      events.push(e),
    );

    const out = await pipe.process(
      messagesRequest([
        { role: "user", content: "how do I deploy?" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "how do I deploy?" },
      ]),
    );

    expect(calls).toHaveLength(0);
    expect(out.respondDirectly).toBeUndefined();
  });

  it("is a no-op when no localAnswer option is configured, even for an eligible request", async () => {
    const events: PipelineEvent[] = [];
    const pipe = makePipeline(undefined, (e) => events.push(e));

    const out = await pipe.process(
      messagesRequest([{ role: "user", content: "how do I deploy?" }]),
    );

    expect(out.respondDirectly).toBeUndefined();
  });

  it("runs independently of slider level — a confident answer short-circuits even at level 0", async () => {
    const compression = new NativeLosslessCompression(new LocalDirBlobStore("/nonexistent-ccr"));
    const events: PipelineEvent[] = [];
    const pipe = createGolemPipeline({
      compression,
      policy: () => policyFor("off"),
      projectId: "proj",
      onEvent: (e) => events.push(e),
      localAnswer: { service: stubService({ answersFor: "how do I deploy?" }) },
    });

    const out = await pipe.process(
      messagesRequest([{ role: "user", content: "how do I deploy?" }]),
    );

    expect(out.respondDirectly).toBeDefined();
  });

  it("attempts the query text unmodified when redaction is off (level 0) — the stage itself does no redacting", async () => {
    const calls: LocalAnswerQuery[] = [];
    const compression = new NativeLosslessCompression(new LocalDirBlobStore("/nonexistent-ccr"));
    const pipe = createGolemPipeline({
      compression,
      policy: () => policyFor("off"),
      projectId: "proj",
      localAnswer: { service: stubService({ calls }) },
    });

    await pipe.process(messagesRequest([{ role: "user", content: "plain question, no PII" }]));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe("plain question, no PII");
  });

  it("fails open when the service throws — falls through to upstream, never errors the request (verification-notes §64)", async () => {
    const throwing: LocalAnswerService = {
      tryAnswer(): Promise<LocalAnswerResult> {
        return Promise.reject(new Error("embed model 'nomic-embed-text' not found"));
      },
    };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const pipe = makePipeline(throwing, () => {});
      const out = await pipe.process(
        messagesRequest([{ role: "user", content: "how do I deploy?" }]),
      );

      // Fell through to the normal path rather than throwing.
      expect(out.respondDirectly).toBeUndefined();
      expect(bodyOf(out).messages).toEqual([{ role: "user", content: "how do I deploy?" }]);
      // And it was observable on stderr.
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("local-answer stage failed"));
    } finally {
      stderr.mockRestore();
    }
  });
});

/**
 * R10.23 — this stage runs a vector search, and therefore an embedder, INLINE on
 * a live request, and it is eligible on exactly the single-turn requests that
 * open a session. So a cold local model made the first turn of a session sit on
 * "waiting for API" with nothing in the log naming Golem as the cause. The stage
 * is an optimisation; it may not hold a user's turn open.
 */
describe("local-answer time budget (R10.23)", () => {
  it("abandons a local answer that outruns its budget and forwards upstream", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      // A service that never resolves — the cold-embedder case, taken to its limit.
      const hangs: LocalAnswerService = { tryAnswer: () => new Promise<never>(() => {}) };
      const pipe = makePipeline(hangs, () => {});

      const pending = pipe.process(
        messagesRequest([{ role: "user", content: "how do I deploy?" }]),
      );
      await vi.advanceTimersByTimeAsync(2_000);
      const out = await pending;

      // Fail-open: the request goes upstream exactly as if the KB had declined.
      expect(out.respondDirectly).toBeUndefined();
      expect(writes.join("")).toContain("local-answer stage exceeded");
    } finally {
      stderr.mockRestore();
      vi.useRealTimers();
    }
  });

  it("says so when the pipeline held a request, naming the stage that did it", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const hangs: LocalAnswerService = { tryAnswer: () => new Promise<never>(() => {}) };
      const pipe = makePipeline(hangs, () => {});
      const pending = pipe.process(
        messagesRequest([{ role: "user", content: "how do I deploy?" }]),
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await pending;

      const log = writes.join("");
      // Honest observability: the client showed "waiting for API" for time the
      // API was not responsible for, so the log must name the real cause.
      expect(log).toContain("pipeline held this request");
      expect(log).toContain("local-answer=");
    } finally {
      stderr.mockRestore();
      vi.useRealTimers();
    }
  });

  it("stays silent about timing on a fast request", async () => {
    const writes: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const pipe = makePipeline(stubService({ answersFor: "how do I deploy?" }), () => {});
      await pipe.process(messagesRequest([{ role: "user", content: "how do I deploy?" }]));
      expect(writes.join("")).not.toContain("pipeline held this request");
    } finally {
      stderr.mockRestore();
    }
  });
});
