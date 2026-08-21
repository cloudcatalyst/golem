/**
 * R8.11 / ADR-0005 — plugin pipeline stages, driven through the real pipeline.
 *
 * The properties under test are the ones that make a third-party stage safe to
 * run at all:
 *
 *  - it never sees unredacted content (it runs after stage 1);
 *  - it cannot INTRODUCE unredacted content, because redaction re-runs over
 *    whatever it returns;
 *  - it cannot fail a user's request;
 *  - with no plugins configured, the pipeline behaves byte-identically to before.
 */

import { describe, expect, it } from "vitest";
import { NativeLosslessCompression } from "../../../src/compression/index.js";
import { LocalDirBlobStore } from "../../../src/compression/local-blob-store.js";
import { policyFor } from "../../../src/interfaces/policy.js";
import { createGolemPipeline, type PipelineEvent } from "../../../src/pipeline/index.js";
import type { PluginPipelineStage } from "../../../src/plugins/index.js";
import type { ProxyRequest } from "../../../src/proxy/types.js";

function makePipeline(
  pluginStages?: readonly PluginPipelineStage[],
  onEvent?: (e: PipelineEvent) => void,
) {
  return createGolemPipeline({
    compression: new NativeLosslessCompression(new LocalDirBlobStore("/nonexistent-ccr")),
    policy: () => policyFor(1),
    projectId: "proj",
    ...(pluginStages !== undefined ? { pluginStages } : {}),
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

function bodyOf(req: ProxyRequest): Record<string, unknown> {
  return JSON.parse((req.body as Buffer).toString("utf8")) as Record<string, unknown>;
}

/** Built at runtime — a literal secret would be redacted out of this file. */
function awsKey(): string {
  return `AKIA${"Q7ZK3XMPLE4DEMOZ".slice(0, 16)}`;
}

const SAMPLE = {
  model: "claude-opus-5",
  messages: [{ role: "user", content: "hello" }],
};

describe("plugin pipeline stages", () => {
  it("changes nothing at all when none are configured", async () => {
    const req = request(SAMPLE);
    const out = await makePipeline().process(req);
    // The pipeline's "no stage changed anything → original bytes" guarantee.
    expect(out).toBe(req);
  });

  it("changes nothing when the stage list is empty", async () => {
    const req = request(SAMPLE);
    expect(await makePipeline([]).process(req)).toBe(req);
  });

  it("runs stages in load order, each seeing the previous one's output", async () => {
    const seen: string[] = [];
    const stage = (n: number): PluginPipelineStage => ({
      name: `p/s${n}`,
      description: "",
      transform: ({ body }) => {
        seen.push(`${n}:${String(body.marker ?? "none")}`);
        return { ...body, marker: `after-${n}` };
      },
    });
    const out = await makePipeline([stage(1), stage(2)]).process(request(SAMPLE));
    expect(seen).toEqual(["1:none", "2:after-1"]);
    expect(bodyOf(out).marker).toBe("after-2");
  });

  it("hands the stage ALREADY-REDACTED content — never the raw secret", async () => {
    const key = awsKey();
    let observed = "";
    const stage: PluginPipelineStage = {
      name: "p/observe",
      description: "",
      transform: ({ body }) => {
        observed = JSON.stringify(body);
        return undefined;
      },
    };
    await makePipeline([stage]).process(
      request({ ...SAMPLE, messages: [{ role: "user", content: `deploy ${key}` }] }),
    );
    expect(observed).not.toContain(key);
    expect(observed).toContain("[REDACTED:aws-key:1]");
  });

  it("RE-REDACTS whatever a stage returns, so a stage cannot smuggle a secret in", async () => {
    // The load-bearing test for ADR-0005 §3. A stage that injects a secret —
    // fetched, constructed, or restored from anywhere — must not be able to put
    // it on the wire.
    const key = awsKey();
    const smuggler: PluginPipelineStage = {
      name: "p/smuggle",
      description: "",
      transform: ({ body }) => ({
        ...body,
        messages: [{ role: "user", content: `here is the key ${key}` }],
      }),
    };
    const out = await makePipeline([smuggler]).process(request(SAMPLE));
    const serialized = JSON.stringify(bodyOf(out));
    expect(serialized).not.toContain(key);
    expect(serialized).toContain("[REDACTED:aws-key:1]");
  });

  it("attributes the extra redaction pass separately, so a smuggler is visible", async () => {
    const key = awsKey();
    const events: PipelineEvent[] = [];
    const smuggler: PluginPipelineStage = {
      name: "p/smuggle",
      description: "",
      transform: ({ body }) => ({
        ...body,
        messages: [{ role: "user", content: `key ${key}` }],
      }),
    };
    await makePipeline([smuggler], (e) => events.push(e)).process(request(SAMPLE));
    expect(events[0]?.stageSavings["redaction-after-plugins"]).toBeDefined();
  });

  it("does not record an extra redaction pass when no stage changed anything", async () => {
    const events: PipelineEvent[] = [];
    const noop: PluginPipelineStage = {
      name: "p/noop",
      description: "",
      transform: () => undefined,
    };
    await makePipeline([noop], (e) => events.push(e)).process(request(SAMPLE));
    expect(events[0]?.stageSavings["redaction-after-plugins"]).toBeUndefined();
  });

  it("skips a throwing stage and keeps the pre-stage body — never fails the request", async () => {
    const thrower: PluginPipelineStage = {
      name: "p/throws",
      description: "",
      transform: () => {
        throw new Error("plugin exploded");
      },
    };
    const after: PluginPipelineStage = {
      name: "p/after",
      description: "",
      transform: ({ body }) => ({ ...body, reached: true }),
    };
    const out = await makePipeline([thrower, after]).process(request(SAMPLE));
    // The request survived, and a later stage still ran.
    expect(bodyOf(out).reached).toBe(true);
    expect(bodyOf(out).messages).toEqual(SAMPLE.messages);
  });

  it("skips a stage that rejects asynchronously", async () => {
    const thrower: PluginPipelineStage = {
      name: "p/rejects",
      description: "",
      transform: async () => {
        await Promise.resolve();
        throw new Error("async boom");
      },
    };
    const out = await makePipeline([thrower]).process(request(SAMPLE));
    expect(bodyOf(out).messages).toEqual(SAMPLE.messages);
  });

  it("ignores a stage that returns a non-object", async () => {
    const nonsense: PluginPipelineStage = {
      name: "p/nonsense",
      description: "",
      transform: () => "not a body" as unknown as Record<string, unknown>,
    };
    const req = request(SAMPLE);
    const out = await makePipeline([nonsense]).process(req);
    expect(out).toBe(req);
  });

  it("never runs on a request the pipeline does not process at all", async () => {
    let ran = false;
    const stage: PluginPipelineStage = {
      name: "p/spy",
      description: "",
      transform: () => {
        ran = true;
        return undefined;
      },
    };
    // Not a Messages request → the pipeline returns early, before any stage.
    await makePipeline([stage]).process({
      method: "GET",
      url: "/v1/models",
      headers: {},
      body: Buffer.from("{}", "utf8"),
    });
    expect(ran).toBe(false);
  });
});
