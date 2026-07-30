/**
 * WS-C C3 — real embeddings wired via the WS-D InferenceService. A fake service
 * (deterministic lexical vectors) drives ingest→search through
 * openKnowledgeBase({ inference }), exercising the actual adapter path.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ChatResult,
  HardwareTier,
  type InferenceService,
  type Role,
  type Vector,
} from "../../../src/interfaces/inference.js";
import {
  InMemoryVectorDriver,
  inferenceEmbedFn,
  openKnowledgeBase,
} from "../../../src/knowledge/index.js";
import { rmTemp } from "../../helpers/tmp.js";

/** Fake InferenceService: deterministic lexical embeddings; chat unused here. */
class FakeInference implements InferenceService {
  readonly embedCalls: Array<{ kind: string; count: number }> = [];
  chat(role: Role): Promise<ChatResult> {
    return Promise.resolve({
      text: "",
      model: "fake",
      role,
      promptTokens: 0,
      completionTokens: 0,
      finishReason: "stop",
    });
  }
  embed(texts: readonly string[], kind: "text" | "code"): Promise<Vector[]> {
    this.embedCalls.push({ kind, count: texts.length });
    const dim = 128;
    return Promise.resolve(
      texts.map((t) => {
        const v = new Array<number>(dim).fill(0);
        for (const tok of t
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter(Boolean)) {
          let h = 0;
          for (let i = 0; i < tok.length; i += 1) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
          v[h % dim] = (v[h % dim] ?? 0) + 1;
        }
        return v;
      }),
    );
  }
  capabilities(): HardwareTier {
    return HardwareTier.PMid;
  }
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "golem-c3-"));
});
afterEach(async () => {
  await rm(dir, rmTemp);
});

describe("inferenceEmbedFn", () => {
  it("returns one mutable vector per input via the service", async () => {
    const embed = inferenceEmbedFn(new FakeInference());
    const vecs = await embed(["alpha", "beta"], "text");
    expect(vecs).toHaveLength(2);
    expect(Array.isArray(vecs[0])).toBe(true);
    expect(vecs[0]?.length).toBe(128);
  });
});

describe("openKnowledgeBase({ inference }) end to end", () => {
  it("ingests + searches using the InferenceService embedder", async () => {
    await writeFile(
      path.join(dir, "ops.md"),
      "# Runbook\n\nRun database migrations before every deployment.\n",
    );
    await writeFile(path.join(dir, "notes.md"), "# Notes\n\nThe cache warms on startup.\n");

    const inference = new FakeInference();
    const kb = openKnowledgeBase({
      projectDir: dir,
      driver: new InMemoryVectorDriver(),
      inference,
    });

    const report = await kb.ingest(dir, "proj");
    expect(report.chunksIndexed).toBeGreaterThanOrEqual(2);
    // The service was actually used to embed the chunks (kind "text").
    expect(inference.embedCalls.some((c) => c.kind === "text")).toBe(true);

    const hits = await kb.search("migrations", "proj", 3, new Set(["knowledge"]));
    expect(hits[0]?.chunk.sourcePath).toBe("ops.md");
    expect(hits[0]?.chunk.text).toContain("migrations");
  });

  it("explicit embed overrides inference", async () => {
    const inference = new FakeInference();
    const kb = openKnowledgeBase({
      projectDir: dir,
      driver: new InMemoryVectorDriver(),
      inference,
      embed: () => Promise.resolve([[1, 0, 0]]),
    });
    await kb.search("q", "proj", 1, new Set(["knowledge"]));
    // The explicit embed was used, so the service was never called.
    expect(inference.embedCalls).toHaveLength(0);
  });
});
