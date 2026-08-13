/**
 * R10.4 — the embedder is PINNED TO THE INDEX, not to the detected hardware tier.
 *
 * The embed model (and therefore the vector WIDTH) used to be a function of a
 * runtime hardware probe that degrades to the CPU tier on any hiccup. An index
 * built at 1024-dim was then queried at 768-dim, and the guard — which asked
 * "is *an* embedder available?" rather than "is it *this index's* embedder?" —
 * happily passed, so every retrieval-shaped request threw EmbedderMismatchError
 * and fell through to upstream. Silent dead weight, one wasted embed per query.
 *
 * These tests hold the property the guard actually needs: an index recorded with
 * one embedder is never queried with a different-width one.
 *
 * R10.6 extends the same property to the BUILD side (`planBuildEmbedder`): the
 * degraded probe there did not error, it silently re-embedded the entire index at
 * the narrower width. The build must keep the index's embedder while it is still
 * available, and when it genuinely cannot, it must SAY so.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  embedderSignature,
  ensureProjectIndexed,
  parseEmbedderSignature,
  planBuildEmbedder,
  planQueryEmbedder,
  resolvePersistedEmbedder,
  writeManifest,
} from "../../../src/cli/auto-index.js";
import { embedDimFor, embedModelFor } from "../../../src/inference/index.js";
import { HardwareTier } from "../../../src/interfaces/inference.js";
import {
  collectionDir,
  EmbedderMismatchError,
  knowledgeDir,
  openKnowledgeBase,
} from "../../../src/knowledge/index.js";
import { useTempDirs } from "../../helpers/tmp.js";

/** The two catalog embedders the drift happens between. */
const WIDE = embedModelFor(HardwareTier.PMid, "text"); // bge-m3, 1024-dim
const NARROW = embedModelFor(HardwareTier.PCpu, "text"); // nomic-embed-text, 768-dim

const NOW = "2026-08-13T00:00:00Z";

/** Deterministic embedder of a fixed width — stands in for a real Ollama model. */
const fakeEmbedOfWidth =
  (dim: number) =>
  (texts: readonly string[]): Promise<number[][]> =>
    Promise.resolve(
      texts.map((t) => {
        const v = new Array<number>(dim).fill(0);
        for (let i = 0; i < t.length; i += 1) {
          const slot = t.charCodeAt(i) % dim;
          v[slot] = (v[slot] ?? 0) + 1;
        }
        return v;
      }),
    );

const available =
  (...models: string[]) =>
  (model: string): Promise<boolean> =>
    Promise.resolve(models.includes(model));

let projectDir: string;
const newTempDir = useTempDirs("golem-r104-");

beforeEach(async () => {
  projectDir = await newTempDir();
});

/**
 * Build a REAL on-disk index (FileVectorDriver + meta.json) at `dim`, recorded
 * under `tier`'s embedder signature — the exact artifacts the proxy reads back.
 */
async function buildIndexAt(dim: number, tier: HardwareTier): Promise<void> {
  await writeFile(
    path.join(projectDir, "runbook.md"),
    "# Runbook\n\nRotate the signing key before every release.\n",
  );
  const kb = openKnowledgeBase({ projectDir, embed: fakeEmbedOfWidth(dim) });
  const report = await kb.ingest(projectDir, projectDir);
  expect(report.chunksIndexed).toBeGreaterThan(0);
  await writeManifest(
    projectDir,
    projectDir,
    embedderSignature("semantic", tier),
    [projectDir],
    NOW,
  );
}

describe("embedDimFor", () => {
  it("knows the two catalog embedders' widths, and admits ignorance otherwise", () => {
    expect(embedDimFor(NARROW)).toBe(768);
    expect(embedDimFor(WIDE)).toBe(1024);
    expect(embedDimFor(`${WIDE}:latest`)).toBe(1024);
    expect(embedDimFor("some-model-nobody-tabulated")).toBeNull();
  });

  it("gives the two tiers genuinely different widths (the whole premise)", () => {
    expect(embedDimFor(NARROW)).not.toBe(embedDimFor(WIDE));
  });
});

describe("parseEmbedderSignature", () => {
  it("round-trips the model out of a semantic signature", () => {
    expect(parseEmbedderSignature(embedderSignature("semantic", HardwareTier.PMid))).toStrictEqual({
      mode: "semantic",
      model: WIDE,
    });
  });

  it("reports lexical without a model, and unknown signatures as null", () => {
    expect(parseEmbedderSignature(embedderSignature("lexical", HardwareTier.PMid))).toStrictEqual({
      mode: "lexical",
      model: null,
    });
    expect(parseEmbedderSignature("something-else:v9")).toBeNull();
  });
});

describe("resolvePersistedEmbedder", () => {
  it("returns null when the project has no index", async () => {
    expect(await resolvePersistedEmbedder(projectDir, projectDir)).toBeNull();
  });

  it("records model AND the width the index actually stores", async () => {
    await buildIndexAt(1024, HardwareTier.PMid);
    expect(await resolvePersistedEmbedder(projectDir, projectDir)).toStrictEqual({
      mode: "semantic",
      model: WIDE,
      dim: 1024,
    });
  });

  it("persists the embedder record into the manifest itself", async () => {
    await buildIndexAt(1024, HardwareTier.PMid);
    const raw = await readFile(
      path.join(collectionDir(knowledgeDir(projectDir), projectDir), "manifest.json"),
      "utf8",
    );
    expect(JSON.parse(raw).embedder).toStrictEqual({ mode: "semantic", model: WIDE, dim: 1024 });
  });

  // BACK-COMPAT: a manifest written before R10.4 has only `signature`. The model
  // is still recoverable from it, and the width from the driver's meta.json,
  // which every index this driver ever wrote already has.
  it("reads a pre-R10.4 manifest (signature only, no embedder record)", async () => {
    await buildIndexAt(1024, HardwareTier.PMid);
    const file = path.join(collectionDir(knowledgeDir(projectDir), projectDir), "manifest.json");
    const legacy = JSON.parse(await readFile(file, "utf8"));
    delete legacy.embedder;
    expect(legacy.embedder).toBeUndefined();
    await writeFile(file, `${JSON.stringify(legacy)}\n`, "utf8");

    expect(await resolvePersistedEmbedder(projectDir, projectDir)).toStrictEqual({
      mode: "semantic",
      model: WIDE,
      dim: 1024,
    });
  });
});

describe("planQueryEmbedder — identity, not availability", () => {
  it("uses the current embedder when it IS the one that built the index", async () => {
    await buildIndexAt(1024, HardwareTier.PMid);
    const plan = await planQueryEmbedder(
      await resolvePersistedEmbedder(projectDir, projectDir),
      WIDE,
      available(WIDE),
    );
    expect(plan).toStrictEqual({ action: "use-current", model: WIDE });
  });

  /**
   * THE REGRESSION. Tier degraded to CPU under a 1024-dim index. The narrow
   * model is available — which is exactly what fooled the old guard — but it is
   * the wrong one, so the index's own embedder must be used instead.
   */
  it("pins to the index's embedder when the tier degrades under it", async () => {
    await buildIndexAt(1024, HardwareTier.PMid);
    const plan = await planQueryEmbedder(
      await resolvePersistedEmbedder(projectDir, projectDir),
      NARROW,
      available(NARROW, WIDE),
    );
    expect(plan).toStrictEqual({ action: "pin", model: WIDE, currentModel: NARROW });
  });

  it("never returns use-current for a different-width embedder, either direction", async () => {
    for (const [built, tier, current] of [
      [1024, HardwareTier.PMid, NARROW],
      [768, HardwareTier.PCpu, WIDE],
    ] as const) {
      projectDir = await newTempDir();
      await buildIndexAt(built, tier);
      const persisted = await resolvePersistedEmbedder(projectDir, projectDir);
      for (const probe of [available(NARROW, WIDE), available(current), available()]) {
        const plan = await planQueryEmbedder(persisted, current, probe);
        expect(plan.action).not.toBe("use-current");
      }
    }
  });

  it("disables ONCE, naming BOTH models, when the index's embedder is gone", async () => {
    await buildIndexAt(1024, HardwareTier.PMid);
    const plan = await planQueryEmbedder(
      await resolvePersistedEmbedder(projectDir, projectDir),
      NARROW,
      available(NARROW), // only the wrong model is pulled
    );
    expect(plan.action).toBe("disable");
    if (plan.action !== "disable") throw new Error("unreachable");
    expect(plan.reason).toContain(WIDE);
    expect(plan.reason).toContain(NARROW);
    expect(plan.reason).toContain("1024-dim");
    expect(plan.reason).toContain("768-dim");
  });

  it("disables when the recorded embedder cannot produce the stored width", async () => {
    // Index really holds 1024-dim vectors but is labelled with the 768-dim model.
    await buildIndexAt(1024, HardwareTier.PCpu);
    const plan = await planQueryEmbedder(
      await resolvePersistedEmbedder(projectDir, projectDir),
      NARROW,
      available(NARROW, WIDE),
    );
    expect(plan.action).toBe("disable");
    if (plan.action !== "disable") throw new Error("unreachable");
    expect(plan.reason).toContain("1024-dim");
  });

  it("falls back to the lexical embedder for a lexical index or no index at all", async () => {
    expect(await planQueryEmbedder(null, WIDE, available(WIDE))).toStrictEqual({
      action: "lexical",
    });
    expect(
      await planQueryEmbedder({ mode: "lexical", model: null, dim: 512 }, WIDE, available(WIDE)),
    ).toStrictEqual({ action: "lexical" });
  });

  it("does not probe the tier's model — only the one it intends to use", async () => {
    await buildIndexAt(1024, HardwareTier.PMid);
    const probed: string[] = [];
    const probe = (m: string): Promise<boolean> => {
      probed.push(m);
      return Promise.resolve(true);
    };
    await planQueryEmbedder(await resolvePersistedEmbedder(projectDir, projectDir), NARROW, probe);
    expect(probed).toStrictEqual([WIDE]);
  });
});

describe("planBuildEmbedder — a degraded tier cannot silently narrow an index (R10.6)", () => {
  it("uses the current embedder when it IS the one that built the index", async () => {
    await buildIndexAt(1024, HardwareTier.PMid);
    expect(
      await planBuildEmbedder(
        await resolvePersistedEmbedder(projectDir, projectDir),
        WIDE,
        available(WIDE),
      ),
    ).toStrictEqual({ action: "use-current", model: WIDE });
  });

  /**
   * THE REGRESSION. The capability probe hiccuped, so the tier fell back to CPU
   * and its 768-dim embedder — which IS pulled, so the old "is a model
   * available?" test passed and the whole 1024-dim index was re-embedded narrow.
   * The index's own embedder is still there, so it wins.
   */
  it("pins to the index's embedder rather than re-embedding it narrower", async () => {
    await buildIndexAt(1024, HardwareTier.PMid);
    const plan = await planBuildEmbedder(
      await resolvePersistedEmbedder(projectDir, projectDir),
      NARROW,
      available(NARROW, WIDE),
    );
    expect(plan.action).toBe("pin");
    if (plan.action !== "pin") throw new Error("unreachable");
    expect(plan.model).toBe(WIDE);
    expect(plan.currentModel).toBe(NARROW);
    for (const part of [WIDE, NARROW, "1024-dim", "768-dim"]) expect(plan.notice).toContain(part);
  });

  it("survives ONE flaky probe answer — a 1.5 s timeout must not cost a re-embed", async () => {
    await buildIndexAt(1024, HardwareTier.PMid);
    let asked = 0;
    const flaky = (model: string): Promise<boolean> => {
      asked += 1;
      // First answer about the index's own embedder is a false negative.
      return Promise.resolve(model === WIDE ? asked > 2 : true);
    };
    const plan = await planBuildEmbedder(
      await resolvePersistedEmbedder(projectDir, projectDir),
      NARROW,
      flaky,
    );
    expect(plan.action).toBe("pin");
  });

  it("narrows only when the index's embedder is really gone — and says so", async () => {
    await buildIndexAt(1024, HardwareTier.PMid);
    const plan = await planBuildEmbedder(
      await resolvePersistedEmbedder(projectDir, projectDir),
      NARROW,
      available(NARROW), // the wide model is no longer pulled
    );
    expect(plan.action).toBe("reembed");
    if (plan.action !== "reembed") throw new Error("unreachable");
    expect(plan.model).toBe(NARROW);
    expect(plan.previous).toBe(WIDE);
    for (const part of [WIDE, NARROW, "1024-dim", "768-dim", "ENTIRE"])
      expect(plan.notice).toContain(part);
  });

  it("still WIDENS an index when the machine gained the wider embedder", async () => {
    await buildIndexAt(768, HardwareTier.PCpu);
    const plan = await planBuildEmbedder(
      await resolvePersistedEmbedder(projectDir, projectDir),
      WIDE,
      available(NARROW, WIDE),
    );
    expect(plan.action).toBe("reembed");
    if (plan.action !== "reembed") throw new Error("unreachable");
    expect(plan.model).toBe(WIDE);
    expect(plan.notice).toContain("ENTIRE");
  });

  it("leaves the no-index and lexical-index paths exactly as they were", async () => {
    expect(await planBuildEmbedder(null, WIDE, available(WIDE))).toStrictEqual({
      action: "use-current",
      model: WIDE,
    });
    expect(await planBuildEmbedder(null, WIDE, available())).toStrictEqual({ action: "lexical" });
    // A lexical index gaining a semantic embedder is the advertised upgrade.
    expect(
      await planBuildEmbedder({ mode: "lexical", model: null, dim: 512 }, WIDE, available(WIDE)),
    ).toStrictEqual({ action: "use-current", model: WIDE });
  });

  it("never drops a semantic index to lexical without a notice", async () => {
    await buildIndexAt(1024, HardwareTier.PMid);
    const persisted = await resolvePersistedEmbedder(projectDir, projectDir);
    for (const current of [WIDE, NARROW]) {
      const plan = await planBuildEmbedder(persisted, current, available()); // Ollama gone
      expect(plan.action).toBe("lexical");
      if (plan.action !== "lexical") throw new Error("unreachable");
      expect(plan.notice).toContain(WIDE);
      expect(plan.notice).toContain("lexical");
    }
  });
});

describe("ensureProjectIndexed honours the build plan (R10.6)", () => {
  /** The KB reopened over the SAME on-disk index, at the pinned width. */
  const kbAt = (dim: number): ReturnType<typeof openKnowledgeBase> =>
    openKnowledgeBase({ projectDir, embed: fakeEmbedOfWidth(dim) });

  const readSignature = async (): Promise<string> =>
    JSON.parse(
      await readFile(
        path.join(collectionDir(knowledgeDir(projectDir), projectDir), "manifest.json"),
        "utf8",
      ),
    ).signature;

  it("a pinned build does NOT re-embed, and leaves the recorded embedder alone", async () => {
    await buildIndexAt(1024, HardwareTier.PMid);
    const logs: string[] = [];
    const result = await ensureProjectIndexed({
      projectDir,
      projectId: projectDir,
      knowledge: kbAt(1024),
      embedMode: "semantic",
      embedModel: WIDE, // what planBuildEmbedder pinned
      tier: HardwareTier.PCpu, // ...while the probe says CPU
      watchPaths: [],
      now: NOW,
      log: (m) => logs.push(m),
    });
    expect(result.action).not.toBe("reindexed");
    expect(await readSignature()).toBe(embedderSignature("semantic", HardwareTier.PMid));
    expect(logs.join("\n")).not.toContain("embedder changed");
  });

  /**
   * The counterfactual: the pre-R10.6 behaviour, where the signature came from
   * the degraded TIER. The whole index is thrown away and re-embedded — which is
   * sometimes unavoidable, so the requirement is that the user is TOLD.
   */
  it("a tier-driven rebuild announces the re-embed, naming both embedders", async () => {
    await buildIndexAt(1024, HardwareTier.PMid);
    const logs: string[] = [];
    const result = await ensureProjectIndexed({
      projectDir,
      projectId: projectDir,
      knowledge: kbAt(768),
      embedMode: "semantic",
      embedModel: NARROW,
      tier: HardwareTier.PCpu,
      watchPaths: [],
      now: NOW,
      log: (m) => logs.push(m),
    });
    expect(result.action).toBe("reindexed");
    const said = logs.join("\n");
    for (const part of [WIDE, NARROW, "1024-dim", "768-dim", "ENTIRE"])
      expect(said).toContain(part);
  });

  it("without an embedModel it still behaves exactly as it did before", async () => {
    await buildIndexAt(1024, HardwareTier.PMid);
    const result = await ensureProjectIndexed({
      projectDir,
      projectId: projectDir,
      knowledge: kbAt(1024),
      embedMode: "semantic",
      tier: HardwareTier.PMid,
      watchPaths: [],
      now: NOW,
    });
    expect(result.action).not.toBe("reindexed");
    expect(await readSignature()).toBe(embedderSignature("semantic", HardwareTier.PMid));
  });
});

describe("the failure the plan prevents", () => {
  it("querying a 1024-dim index with a 768-dim embedder still throws", async () => {
    await buildIndexAt(1024, HardwareTier.PMid);
    // Same on-disk index, reopened with the WRONG-width embedder — i.e. what the
    // old availability guard let the proxy do on every single request.
    const wrong = openKnowledgeBase({ projectDir, embed: fakeEmbedOfWidth(768) });
    await expect(
      wrong.search("signing key", projectDir, 3, new Set(["knowledge"])),
    ).rejects.toThrow(EmbedderMismatchError);
  });

  it("querying with the pinned embedder returns hits instead", async () => {
    await buildIndexAt(1024, HardwareTier.PMid);
    const plan = await planQueryEmbedder(
      await resolvePersistedEmbedder(projectDir, projectDir),
      NARROW,
      available(NARROW, WIDE),
    );
    expect(plan.action).toBe("pin");
    if (plan.action !== "pin") throw new Error("unreachable");
    // Pinning means embedding at the index's width, so the same query works.
    const pinned = openKnowledgeBase({
      projectDir,
      embed: fakeEmbedOfWidth(embedDimFor(plan.model) ?? 0),
    });
    const hits = await pinned.search("signing key", projectDir, 3, new Set(["knowledge"]));
    expect(hits.length).toBeGreaterThan(0);
  });
});
