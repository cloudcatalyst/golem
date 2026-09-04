/**
 * R13.7 — stage 0.9 (join injection) driven through the real `pipeline.process()`.
 *
 * The gate this file exists for is ADR-0007 invariant 6 and CLAUDE.md's hard
 * rule: **with nothing queued, the forwarded request is byte-identical.** The
 * rest asserts the shape that lands when something IS queued, and that it lands
 * exactly once — the two halves of §3b.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NativeLosslessCompression } from "../../../src/compression/index.js";
import { LocalDirBlobStore } from "../../../src/compression/local-blob-store.js";
import type { JoinQueueMessage } from "../../../src/interfaces/join-queue.js";
import type { LocalAnswerResult } from "../../../src/interfaces/local-answer.js";
import { type CompressionLevel, policyFor } from "../../../src/interfaces/policy.js";
import { createGolemPipeline, type PipelineEvent } from "../../../src/pipeline/index.js";
import type { ProxyRequest } from "../../../src/proxy/types.js";
import { FileJoinQueue } from "../../../src/session/join-queue.js";
import { LiveConversationRegistry } from "../../../src/session/live-conversations.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "golem-join-stage-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

const SAMPLE = {
  model: "claude-opus-5",
  system: "You are a helpful assistant.",
  messages: [
    { role: "user", content: "start the work" },
    { role: "assistant", content: "on it" },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
  ],
};

function request(body: unknown): ProxyRequest {
  return {
    method: "POST",
    url: "/v1/messages",
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body), "utf8"),
  };
}

function bodyOf(req: ProxyRequest): Record<string, unknown> {
  return JSON.parse((req.body as Buffer).toString("utf8"));
}

interface Harness {
  readonly pipeline: ReturnType<typeof createGolemPipeline>;
  readonly registry: LiveConversationRegistry;
  readonly queue: FileJoinQueue;
  readonly injected: JoinQueueMessage[];
  readonly events: PipelineEvent[];
}

function harness(
  options: { level?: CompressionLevel; withQueue?: boolean; localAnswer?: boolean } = {},
): Harness {
  const registry = new LiveConversationRegistry({});
  const queue = new FileJoinQueue({
    projectDir: dir,
    resolve: async (id) => registry.addressable(id),
  });
  const injected: JoinQueueMessage[] = [];
  const events: PipelineEvent[] = [];
  const pipeline = createGolemPipeline({
    compression: new NativeLosslessCompression(new LocalDirBlobStore(path.join(dir, "ccr"))),
    policy: () => policyFor(options.level ?? 1),
    projectId: dir,
    liveConversations: registry,
    onEvent: (event) => {
      events.push(event);
    },
    ...(options.withQueue === false ? {} : { joinQueue: queue }),
    onJoinInjected: (messages) => {
      injected.push(...messages);
    },
    ...(options.localAnswer === true
      ? {
          localAnswer: {
            service: {
              tryAnswer: async (): Promise<LocalAnswerResult> => ({
                answered: true,
                text: "an answer from the knowledge base",
                sources: [],
              }),
            },
          },
        }
      : {}),
  });
  return { pipeline, registry, queue, injected, events };
}

/** Register the conversation the way a real first request would, and return its key. */
async function addressable(h: Harness, body: Record<string, unknown> = SAMPLE): Promise<string> {
  await h.pipeline.process(request(body));
  const [conversation] = h.registry.list();
  return conversation?.conversationId ?? "";
}

describe("pipeline join-injection stage (R13.7, ADR-0007 §3b)", () => {
  it("leaves the request byte-IDENTICAL when the feature is off", async () => {
    const h = harness({ withQueue: false });
    const req = request(SAMPLE);
    const out = await h.pipeline.process(req);
    // Same object reference: the pipeline's "no stage changed anything" path.
    expect(out).toBe(req);
  });

  it("leaves the request byte-IDENTICAL when the feature is on but nothing is queued", async () => {
    const h = harness();
    const req = request(SAMPLE);
    const out = await h.pipeline.process(req);
    expect(out).toBe(req);
    expect(h.injected).toHaveLength(0);
  });

  it("appends the queued message as a new user turn, leaving every earlier message untouched", async () => {
    const h = harness();
    const conversationId = await addressable(h);
    await h.queue.enqueue({
      conversationId,
      deviceId: "phone-1",
      messageId: "m1",
      text: "also run the linter",
    });

    const out = await h.pipeline.process(request(SAMPLE));
    const body = bodyOf(out);
    const messages = body.messages as Record<string, unknown>[];

    expect(messages).toHaveLength(SAMPLE.messages.length + 1);
    // Byte-identical prefix: every message the client sent is unchanged.
    expect(messages.slice(0, 3)).toEqual(SAMPLE.messages);
    expect(body.system).toEqual(SAMPLE.system);

    const appended = messages[3] as { role: string; content: { text: string }[] };
    expect(appended.role).toBe("user");
    expect(appended.content[0]?.text).toContain("<golem-remote-message");
    expect(appended.content[0]?.text).toContain('device="phone-1"');
    expect(appended.content[0]?.text).toContain('id="m1"');
    expect(appended.content[0]?.text).toContain("also run the linter");
    // The model must be able to tell who is speaking (§3b).
    expect(appended.content[0]?.text).toContain("from their own paired device");
  });

  it("reports the delivery locally, and on the telemetry event", async () => {
    const h = harness();
    const conversationId = await addressable(h);
    await h.queue.enqueue({
      conversationId,
      deviceId: "phone-1",
      messageId: "m1",
      text: "hello from the sofa",
    });
    await h.pipeline.process(request(SAMPLE));

    expect(h.injected.map((m) => m.messageId)).toEqual(["m1"]);
    expect(h.events.at(-1)?.remoteMessagesInjected).toBe(1);
  });

  it("delivers EXACTLY ONCE — the same request replayed does not inject twice", async () => {
    const h = harness();
    const conversationId = await addressable(h);
    await h.queue.enqueue({
      conversationId,
      deviceId: "phone-1",
      messageId: "m1",
      text: "only once",
    });

    const first = await h.pipeline.process(request(SAMPLE));
    const retry = await h.pipeline.process(request(SAMPLE));

    expect((bodyOf(first).messages as unknown[]).length).toBe(SAMPLE.messages.length + 1);
    // The retry carries nothing extra, and is byte-identical to what came in.
    expect((bodyOf(retry).messages as unknown[]).length).toBe(SAMPLE.messages.length);
    expect(h.injected).toHaveLength(1);
  });

  it("delivers several queued messages in one turn, oldest first", async () => {
    const h = harness();
    const conversationId = await addressable(h);
    for (const [id, text] of [
      ["m1", "first thing"],
      ["m2", "second thing"],
    ] as const) {
      await h.queue.enqueue({ conversationId, deviceId: "phone-1", messageId: id, text });
    }
    const out = await h.pipeline.process(request(SAMPLE));
    const text = (bodyOf(out).messages as { content: { text: string }[] }[])[3]?.content[0]
      ?.text as string;
    expect(text.indexOf("first thing")).toBeLessThan(text.indexOf("second thing"));
    expect(h.injected.map((m) => m.messageId)).toEqual(["m1", "m2"]);
  });

  it("delivers NOTHING to an ambiguous conversation, and leaves the message queued", async () => {
    const h = harness();
    const conversationId = await addressable(h);
    await h.queue.enqueue({
      conversationId,
      deviceId: "phone-1",
      messageId: "m1",
      text: "who am I talking to",
    });

    // A second conversation opening with the SAME first message: the key can no
    // longer identify one of them (§99), so nothing may be delivered to it.
    const collision = {
      ...SAMPLE,
      messages: [SAMPLE.messages[0], { role: "assistant", content: "a different reply" }],
    };
    const out = await h.pipeline.process(request(collision));

    expect(h.registry.list()[0]?.ambiguous).toBe(true);
    expect((bodyOf(out).messages as unknown[]).length).toBe(2);
    expect(h.injected).toHaveLength(0);
    expect(await h.queue.pending(conversationId)).toHaveLength(1);
  });

  it("does not let a local answer swallow a message that was just delivered", async () => {
    const h = harness({ localAnswer: true });
    const single = { model: "claude-opus-5", messages: [{ role: "user", content: "what is X?" }] };
    const conversationId = await addressable(h, single);
    await h.queue.enqueue({
      conversationId,
      deviceId: "phone-1",
      messageId: "m1",
      text: "and also check the build",
    });

    const out = await h.pipeline.process(request(single));
    // Forwarded upstream carrying the message, NOT short-circuited by the KB.
    expect(out.respondDirectly).toBeUndefined();
    expect(JSON.stringify(bodyOf(out))).toContain("and also check the build");
  });
});
