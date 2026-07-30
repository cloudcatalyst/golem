/**
 * LE3 (PRE_R6_BATCH) — `golem task run` grounding wiring.
 *
 * Covers the risk-bearing branches of `buildTaskGrounding`: the best-effort
 * opt-out/degradation contract (returns undefined, never throws) and that the
 * enabled path builds a working callback that degrades to null over an empty KB.
 * `buildStack` is injected so the tests stay offline and deterministic (the real
 * builder probes Ollama + hardware). The grounding INJECTION itself is covered
 * by tests/unit/tasks/multiplex.test.ts ("injects grounding when provided").
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTaskGrounding } from "../../../src/cli/task-grounding.js";
import type { InferenceService } from "../../../src/interfaces/inference.js";
import type { KnowledgeBase } from "../../../src/interfaces/knowledge.js";
import { rmTemp } from "../../helpers/tmp.js";

const fakeInference = {
  chat: () => Promise.reject(new Error("unused in these tests")),
  embed: () => Promise.resolve([]),
  capabilities: () => 2,
} as unknown as InferenceService;

/** A KB that finds nothing — the enabled path must degrade to null, not throw. */
const emptyKnowledge = { search: () => Promise.resolve([]) } as unknown as KnowledgeBase;

/** Project-scope settings override the developer's real ~/.golem, keeping tests deterministic. */
async function writeSettings(dir: string, knowledge: Record<string, unknown>): Promise<void> {
  await mkdir(path.join(dir, ".golem"), { recursive: true });
  await writeFile(path.join(dir, ".golem", "settings.json"), JSON.stringify({ knowledge }), "utf8");
}

describe("buildTaskGrounding (LE3)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "golem-ground-"));
  });
  afterEach(async () => {
    await rm(dir, rmTemp);
  });

  it("returns undefined when knowledge is disabled (opt-out → service ungrounded)", async () => {
    await writeSettings(dir, { enabled: false });
    const ground = await buildTaskGrounding(dir, fakeInference, {
      buildStack: () => Promise.resolve({ knowledge: emptyKnowledge }),
    });
    expect(ground).toBeUndefined();
  });

  it("returns undefined (never throws) when the KB stack fails to build", async () => {
    await writeSettings(dir, { enabled: true, user_wiki_enabled: false, rerank_enabled: false });
    const ground = await buildTaskGrounding(dir, fakeInference, {
      buildStack: () => Promise.reject(new Error("ollama down")),
    });
    expect(ground).toBeUndefined();
  });

  it("returns a callback that yields null over an empty KB (wiring builds, degrades gracefully)", async () => {
    await writeSettings(dir, { enabled: true, user_wiki_enabled: false, rerank_enabled: false });
    const ground = await buildTaskGrounding(dir, fakeInference, {
      buildStack: () => Promise.resolve({ knowledge: emptyKnowledge }),
    });
    expect(typeof ground).toBe("function");
    expect(await ground?.("any prompt")).toBeNull();
  });
});
