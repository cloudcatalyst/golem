/**
 * R8.8 — the model catalog: lookup, pricing, context warnings, the models.dev
 * normalisation, the disk cache, and the merge precedence.
 *
 * The tests are written around the task's gate rather than around the happy
 * path: an id is never prettified (Decision 49), an unpriced/ambiguous model
 * yields `null` rather than a number, and a fetched catalog can never overwrite
 * a built-in price.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILTIN_MODEL_CATALOG,
  catalogAgeDays,
  contextWarning,
  fetchModelCatalog,
  loadModelCatalog,
  lookupModel,
  type ModelCatalog,
  type ModelCatalogEntry,
  mergeCatalogs,
  modelCatalogPath,
  normaliseModelsDevPayload,
  priceUsage,
  readModelCatalog,
  writeModelCatalog,
} from "../../../src/telemetry/index.js";
import { rmTemp } from "../../helpers/tmp.js";

const temps: string[] = [];

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "golem-model-catalog-"));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir !== undefined) await rm(dir, rmTemp);
  }
});

function catalog(entries: readonly ModelCatalogEntry[]): ModelCatalog {
  return { source: "test", asOf: "2026-07-01", entries };
}

describe("BUILTIN_MODEL_CATALOG", () => {
  it("cites a source, carries a date, and prices every entry it lists", () => {
    expect(BUILTIN_MODEL_CATALOG.source).toMatch(/^https:\/\//);
    expect(BUILTIN_MODEL_CATALOG.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(BUILTIN_MODEL_CATALOG.entries.length).toBeGreaterThan(0);
    for (const entry of BUILTIN_MODEL_CATALOG.entries) {
      expect(entry.inputUsdPerMTok).toBeGreaterThan(0);
      expect(entry.outputUsdPerMTok).toBeGreaterThan(0);
      expect(entry.contextTokens).toBeGreaterThan(0);
    }
  });

  it("holds ids verbatim — no display names anywhere (Decision 49)", () => {
    for (const entry of BUILTIN_MODEL_CATALOG.entries) {
      expect(entry.id).toMatch(/^[a-z0-9.:-]+$/);
      expect(entry.id).not.toMatch(/\s/);
    }
  });
});

describe("lookupModel", () => {
  const cat = catalog([
    { id: "claude-opus-5", provider: "anthropic", inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
    { id: "shared-model", provider: "anthropic", inputUsdPerMTok: 1, outputUsdPerMTok: 2 },
    { id: "shared-model", provider: "openrouter", inputUsdPerMTok: 9, outputUsdPerMTok: 9 },
  ]);

  it("matches an exact id", () => {
    const match = lookupModel(cat, "claude-opus-5");
    expect(match.how).toBe("exact");
    expect(match.entry?.inputUsdPerMTok).toBe(5);
  });

  it("falls back to the undated id for a dated snapshot, and says so", () => {
    const match = lookupModel(cat, "claude-opus-5-20260724");
    expect(match.how).toBe("dated-snapshot");
    expect(match.entry?.id).toBe("claude-opus-5");
  });

  it("reports an unknown id rather than guessing a neighbour", () => {
    expect(lookupModel(cat, "gpt-5.6-sol")).toEqual({ entry: null, how: "unknown" });
    // A near-miss is still a miss: no fuzzy matching, ever.
    expect(lookupModel(cat, "claude-opus-5-fast").how).toBe("unknown");
  });

  it("returns ambiguous — not a coin flip — when two providers share an id", () => {
    expect(lookupModel(cat, "shared-model")).toEqual({ entry: null, how: "ambiguous" });
  });

  it("resolves the ambiguity when the caller knows the provider", () => {
    const match = lookupModel(cat, "shared-model", { preferProvider: "openrouter" });
    expect(match.entry?.inputUsdPerMTok).toBe(9);
  });

  it("stays ambiguous when the preferred provider is not one of the candidates", () => {
    expect(lookupModel(cat, "shared-model", { preferProvider: "gemini" }).how).toBe("ambiguous");
  });

  it("labels a single-candidate hit under another provider as unconfirmed", () => {
    // Golem's upstream names (`custom`, `azure-foundry`) do not line up with a
    // public catalog's provider ids, and a gateway may bill its own markup — so
    // the one price the catalog holds is used and LABELLED, not silently trusted.
    const match = lookupModel(cat, "claude-opus-5", { preferProvider: "azure-foundry" });
    expect(match.how).toBe("provider-unconfirmed");
    expect(match.entry?.inputUsdPerMTok).toBe(5);
  });
});

describe("priceUsage", () => {
  const opus: ModelCatalogEntry = {
    id: "claude-opus-5",
    provider: "anthropic",
    inputUsdPerMTok: 5,
    outputUsdPerMTok: 25,
    cacheReadUsdPerMTok: 0.5,
    cacheWriteUsdPerMTok: 6.25,
  };

  it("prices each bucket at its own rate", () => {
    const usd = priceUsage(opus, {
      inputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(usd).toBeCloseTo(5 + 6.25 + 0.5 + 25, 10);
  });

  it("derives the cache rates from the input price when the catalog omits them", () => {
    const bare: ModelCatalogEntry = {
      id: "x",
      provider: "p",
      inputUsdPerMTok: 10,
      outputUsdPerMTok: 20,
    };
    const usd = priceUsage(bare, {
      inputTokens: 0,
      cacheCreationInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      outputTokens: 0,
    });
    // 1.25x and 0.1x — the R1.1 multipliers, not invented ones.
    expect(usd).toBeCloseTo(12.5 + 1, 10);
  });

  it("returns null for an unpriced entry rather than 0", () => {
    const unpriced: ModelCatalogEntry = { id: "x", provider: "p", contextTokens: 1000 };
    expect(
      priceUsage(unpriced, {
        inputTokens: 10_000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 10_000,
      }),
    ).toBeNull();
  });
});

describe("contextWarning", () => {
  const entry: ModelCatalogEntry = { id: "m", provider: "p", contextTokens: 200_000 };

  it("is ok below the threshold", () => {
    expect(contextWarning(entry, 100_000, 0.8)?.level).toBe("ok");
  });

  it("is approaching at the threshold", () => {
    expect(contextWarning(entry, 160_000, 0.8)?.level).toBe("approaching");
  });

  it("is over at or past the window", () => {
    expect(contextWarning(entry, 200_000, 0.8)?.level).toBe("over");
    const past = contextWarning(entry, 240_000, 0.8);
    expect(past?.level).toBe("over");
    expect(past?.usedFraction).toBeCloseTo(1.2, 10);
  });

  it("says nothing when the window is unknown", () => {
    expect(contextWarning({ id: "m", provider: "p" }, 1_000_000, 0.8)).toBeNull();
  });
});

describe("normaliseModelsDevPayload", () => {
  const payload = {
    anthropic: {
      id: "anthropic",
      models: {
        "claude-opus-5": {
          name: "Claude Opus 5",
          limit: { context: 1_000_000, output: 128_000 },
          cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
        },
        "no-price-model": { limit: { context: 4096 } },
      },
    },
    "provider-without-models": { id: "x" },
  };

  it("keeps only the numbers Golem reports, tagged with provider and source", () => {
    const cat = normaliseModelsDevPayload(payload, "https://example/api.json", "2026-07-31");
    expect(cat.source).toBe("https://example/api.json");
    expect(cat.asOf).toBe("2026-07-31");
    const opus = cat.entries.find((e) => e.id === "claude-opus-5");
    expect(opus).toEqual({
      id: "claude-opus-5",
      provider: "anthropic",
      inputUsdPerMTok: 5,
      outputUsdPerMTok: 25,
      cacheReadUsdPerMTok: 0.5,
      cacheWriteUsdPerMTok: 6.25,
      contextTokens: 1_000_000,
      maxOutputTokens: 128_000,
    });
  });

  it("keeps a model with a limit but no cost — absence is a fact, not a zero", () => {
    const cat = normaliseModelsDevPayload(payload, "s", "2026-07-31");
    const bare = cat.entries.find((e) => e.id === "no-price-model");
    expect(bare?.contextTokens).toBe(4096);
    expect(bare?.inputUsdPerMTok).toBeUndefined();
    expect("inputUsdPerMTok" in (bare ?? {})).toBe(false);
  });

  it("tolerates a provider with no models block", () => {
    const cat = normaliseModelsDevPayload(payload, "s", "2026-07-31");
    expect(cat.entries.some((e) => e.provider === "provider-without-models")).toBe(false);
  });

  it("throws a readable error on a payload that is not a provider map", () => {
    expect(() => normaliseModelsDevPayload([1, 2, 3], "https://example/x", "2026-07-31")).toThrow(
      /https:\/\/example\/x/,
    );
  });
});

describe("fetchModelCatalog", () => {
  it("normalises a 200 response", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ p: { models: { m: { cost: { input: 1, output: 2 } } } } }), {
        status: 200,
      })) as unknown as typeof fetch;
    const cat = await fetchModelCatalog("https://example/api.json", {
      fetchImpl,
      nowIso: "2026-07-31T00:00:00.000Z",
    });
    expect(cat.entries).toEqual([
      { id: "m", provider: "p", inputUsdPerMTok: 1, outputUsdPerMTok: 2 },
    ]);
  });

  it("throws with the status on a non-2xx", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(
      fetchModelCatalog("https://example/api.json", {
        fetchImpl,
        nowIso: "2026-07-31T00:00:00.000Z",
      }),
    ).rejects.toThrow(/503/);
  });
});

describe("the disk cache", () => {
  it("round-trips through .golem/state/model-catalog.json", async () => {
    const dir = await tempProject();
    const cat = catalog([{ id: "m", provider: "p", inputUsdPerMTok: 1 }]);
    await writeModelCatalog(dir, cat);
    expect(modelCatalogPath(dir)).toBe(path.join(dir, ".golem", "state", "model-catalog.json"));
    expect(await readModelCatalog(dir)).toEqual(cat);
  });

  it("reads back as null when absent", async () => {
    expect(await readModelCatalog(await tempProject())).toBeNull();
  });

  it("reads back as null on corrupt content rather than throwing", async () => {
    const dir = await tempProject();
    await writeModelCatalog(dir, catalog([]));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(modelCatalogPath(dir), "{not json", "utf8");
    expect(await readModelCatalog(dir)).toBeNull();
  });

  it("degrades to the built-in table when no cache exists", async () => {
    const loaded = await loadModelCatalog(await tempProject());
    expect(loaded).toEqual(BUILTIN_MODEL_CATALOG);
  });
});

describe("mergeCatalogs", () => {
  const builtin = catalog([
    { id: "claude-opus-5", provider: "anthropic", inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
  ]);

  it("never lets a fetched price overwrite a built-in one", () => {
    const fetched: ModelCatalog = {
      source: "https://models.dev/api.json",
      asOf: "2026-07-31",
      // The exact failure mode §106 recorded: a third party publishing $0.
      entries: [
        { id: "claude-opus-5", provider: "anthropic", inputUsdPerMTok: 0, outputUsdPerMTok: 0 },
      ],
    };
    const merged = mergeCatalogs(builtin, fetched);
    expect(merged.entries).toHaveLength(1);
    expect(merged.entries[0]?.inputUsdPerMTok).toBe(5);
  });

  it("fills gaps and cites both sources", () => {
    const fetched: ModelCatalog = {
      source: "https://models.dev/api.json",
      asOf: "2026-07-31",
      entries: [{ id: "gpt-5.6-sol", provider: "openai", inputUsdPerMTok: 3 }],
    };
    const merged = mergeCatalogs(builtin, fetched);
    expect(merged.entries).toHaveLength(2);
    expect(merged.source).toContain("models.dev");
    expect(merged.source).toContain(builtin.source);
    // The built-in date wins: it is the one the verified prices belong to.
    expect(merged.asOf).toBe(builtin.asOf);
  });

  it("is the identity when there is nothing fetched", () => {
    expect(mergeCatalogs(builtin, null)).toBe(builtin);
  });
});

describe("catalogAgeDays", () => {
  it("counts whole days from asOf", () => {
    const cat = catalog([]);
    expect(catalogAgeDays(cat, Date.parse("2026-07-11T00:00:00.000Z"))).toBe(10);
  });

  it("is null for an unparseable date rather than a wrong number", () => {
    expect(catalogAgeDays({ source: "s", asOf: "whenever", entries: [] }, Date.now())).toBeNull();
  });
});
