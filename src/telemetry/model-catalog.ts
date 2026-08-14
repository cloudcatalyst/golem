/**
 * R8.8 — the model catalog: price and context limits as Golem's own cached data.
 *
 * R6.4's `golem bench cost` reports Golem's measured contribution in TOKENS and
 * frames it against Anthropic's published per-developer baselines (§72). That is
 * honest but weaker than it needs to be: the telemetry already knows the billed
 * token split, so the only missing input for real money is a per-model price.
 * The second payoff is context limits — a "this request is near the window"
 * warning is impossible without a per-model number.
 *
 * **Tier 3b (spec Decision 53's ladder): Golem's own data, no runtime dependency,
 * cite the source, copy nothing.** Two layers, in this precedence order:
 *
 * 1. {@link BUILTIN_MODEL_CATALOG} — a small, dated table Golem enters itself from
 *    the vendor's public pricing page, covering the models this project's own
 *    traffic actually uses. Same pattern as `COST_DOC_BASELINES`: a cited
 *    constant with an `as_of`, not a dependency.
 * 2. An optional, explicitly-refreshed cache of a models.dev-shaped catalog
 *    (`golem models refresh`) for everything else. It is never fetched
 *    implicitly — a cost report must not make a network call — and it can never
 *    overwrite a built-in price (see {@link mergeCatalogs} for why).
 *
 * Three honesty rules the whole module exists to keep:
 *
 * - **A wrong price is worse than no price.** Every accessor returns
 *   `null`/`unknown` rather than a guess, and `golem bench cost` degrades to
 *   today's token-only report when the model is unpriced. models.dev's own web
 *   table renders several Anthropic models at "$0.00" (checked 2026-07-31,
 *   verification-notes §106) — pricing an Opus request at zero would be exactly
 *   the failure this project cannot afford, hence rule (1) beating rule (2).
 * - **Model ids print verbatim (spec Decision 49).** The catalog attaches price
 *   and context to an id; it never substitutes a friendly name, and an id that
 *   is not in the catalog renders as itself with no price.
 * - **No clock reads in the pure functions.** `nowIso`/`nowMs` are injected,
 *   matching the telemetry store's convention.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CACHE_READ_MULTIPLIER, CACHE_WRITE_MULTIPLIER } from "./usage-report.js";

/** One model's price and limits. Every field past the id is optional — absence is a fact. */
export interface ModelCatalogEntry {
  /** The model id VERBATIM, exactly as it appears on the wire (Decision 49). */
  readonly id: string;
  /** Which provider serves it (`anthropic`, `openai`, …). Disambiguates a shared id. */
  readonly provider: string;
  readonly inputUsdPerMTok?: number;
  readonly outputUsdPerMTok?: number;
  /** Explicit cache-read price; when absent, derived from input × 0.1 (R1.1). */
  readonly cacheReadUsdPerMTok?: number;
  /** Explicit cache-write price; when absent, derived from input × 1.25 (R1.1). */
  readonly cacheWriteUsdPerMTok?: number;
  readonly contextTokens?: number;
  readonly maxOutputTokens?: number;
  /**
   * Input modalities the model accepts, verbatim from models.dev's
   * `modalities.input` (`["text"]`, `["text","image"]`, …). R10.14 reads this to
   * decide whether images may be forwarded to an OpenAI-schema upstream.
   *
   * Absent means UNKNOWN, not "text only" — the two must not be conflated. A
   * model missing from the catalog keeps the pass-through behaviour, so an
   * upstream that cannot see says so itself rather than being silently blinded.
   */
  readonly inputModalities?: readonly string[];
  /** Caveat a reader needs (introductory pricing, tier restrictions). Shown verbatim. */
  readonly note?: string;
}

/**
 * Does this entry accept image input? `undefined` when the catalog does not say.
 *
 * Three-valued on purpose: a caller must be able to tell "no vision" from "no
 * idea", because the safe default differs between them (R10.14).
 */
export function acceptsImageInput(entry: ModelCatalogEntry): boolean | undefined {
  const modalities = entry.inputModalities;
  if (modalities === undefined || modalities.length === 0) return undefined;
  return modalities.includes("image");
}

export interface ModelCatalog {
  /** Where the numbers came from. Cited on every rendering. */
  readonly source: string;
  /** ISO date the figures were verified/fetched. Staleness is visible, not hidden. */
  readonly asOf: string;
  readonly entries: readonly ModelCatalogEntry[];
}

/**
 * Golem's own table, entered by hand from Anthropic's published pricing and
 * cross-checked against models.dev's JSON API on 2026-07-31
 * (verification-notes §106). Covers the models this repo's traffic runs on;
 * anything else needs the optional fetched catalog.
 *
 * Update `asOf` and the figures together when prices move. A stale entry is
 * detectable ({@link catalogAgeDays}); a silently-wrong one is not.
 */
/** Every Claude model in this table accepts text and images. Stated once. */
const CLAUDE_INPUT_MODALITIES: readonly string[] = ["text", "image"];

export const BUILTIN_MODEL_CATALOG: ModelCatalog = {
  source: "https://platform.claude.com/docs/en/pricing",
  asOf: "2026-07-31",
  entries: [
    {
      id: "claude-opus-5",
      provider: "anthropic",
      inputModalities: CLAUDE_INPUT_MODALITIES,
      inputUsdPerMTok: 5,
      outputUsdPerMTok: 25,
      cacheReadUsdPerMTok: 0.5,
      cacheWriteUsdPerMTok: 6.25,
      contextTokens: 1_000_000,
      maxOutputTokens: 128_000,
    },
    {
      id: "claude-opus-4-8",
      provider: "anthropic",
      inputModalities: CLAUDE_INPUT_MODALITIES,
      inputUsdPerMTok: 5,
      outputUsdPerMTok: 25,
      cacheReadUsdPerMTok: 0.5,
      cacheWriteUsdPerMTok: 6.25,
      contextTokens: 1_000_000,
      maxOutputTokens: 128_000,
    },
    {
      id: "claude-opus-4-7",
      provider: "anthropic",
      inputModalities: CLAUDE_INPUT_MODALITIES,
      inputUsdPerMTok: 5,
      outputUsdPerMTok: 25,
      cacheReadUsdPerMTok: 0.5,
      cacheWriteUsdPerMTok: 6.25,
      contextTokens: 1_000_000,
      maxOutputTokens: 128_000,
    },
    {
      id: "claude-sonnet-5",
      provider: "anthropic",
      inputModalities: CLAUDE_INPUT_MODALITIES,
      // The price in force today, not the list price — this feeds a cost report.
      inputUsdPerMTok: 2,
      outputUsdPerMTok: 10,
      cacheReadUsdPerMTok: 0.2,
      cacheWriteUsdPerMTok: 2.5,
      contextTokens: 1_000_000,
      maxOutputTokens: 128_000,
      note: "introductory pricing through 2026-08-31; list price $3/$15 per MTok",
    },
    {
      id: "claude-sonnet-4-6",
      provider: "anthropic",
      inputModalities: CLAUDE_INPUT_MODALITIES,
      inputUsdPerMTok: 3,
      outputUsdPerMTok: 15,
      cacheReadUsdPerMTok: 0.3,
      cacheWriteUsdPerMTok: 3.75,
      contextTokens: 1_000_000,
      maxOutputTokens: 128_000,
    },
    {
      id: "claude-haiku-4-5",
      provider: "anthropic",
      inputModalities: CLAUDE_INPUT_MODALITIES,
      inputUsdPerMTok: 1,
      outputUsdPerMTok: 5,
      cacheReadUsdPerMTok: 0.1,
      cacheWriteUsdPerMTok: 1.25,
      contextTokens: 200_000,
      maxOutputTokens: 64_000,
    },
    {
      id: "claude-fable-5",
      provider: "anthropic",
      inputModalities: CLAUDE_INPUT_MODALITIES,
      inputUsdPerMTok: 10,
      outputUsdPerMTok: 50,
      cacheReadUsdPerMTok: 1,
      cacheWriteUsdPerMTok: 12.5,
      contextTokens: 1_000_000,
      maxOutputTokens: 128_000,
    },
  ],
};

/**
 * The outcome of a lookup. `ambiguous` is deliberately distinct from `unknown`:
 * the same bare id can exist under several providers at different prices (an
 * `anthropic` id also served via `openrouter`, say), and picking one at random
 * would invent a number.
 */
export type ModelMatch =
  | {
      readonly entry: ModelCatalogEntry;
      readonly how: "exact" | "dated-snapshot" | "provider-unconfirmed";
    }
  | { readonly entry: null; readonly how: "unknown" | "ambiguous" };

/** `claude-opus-4-5-20251101` → `claude-opus-4-5`; null when there is no date suffix. */
function stripDateSnapshot(modelId: string): string | null {
  const match = /^(.+)-\d{8}$/.exec(modelId);
  return match?.[1] ?? null;
}

/**
 * Pick at most one candidate, and say how confident that pick is.
 *
 * `unconfirmed` is the case worth naming: the id resolves to exactly one entry,
 * but under a different provider than the one that actually served the request
 * (Golem's upstream names — `custom`, `azure-foundry` — do not line up with a
 * public catalog's provider ids, and a gateway may bill its own markup). The
 * price is still the only one the catalog holds, so it is used and LABELLED
 * rather than silently trusted or silently dropped.
 */
function selectOne(
  matches: readonly ModelCatalogEntry[],
  preferProvider: string | undefined,
): { entry: ModelCatalogEntry; confirmed: boolean } | "ambiguous" | null {
  if (matches.length === 0) return null;
  const first = matches[0];
  if (matches.length === 1 && first !== undefined) {
    return {
      entry: first,
      confirmed: preferProvider === undefined || first.provider === preferProvider,
    };
  }
  if (preferProvider !== undefined) {
    const preferred = matches.filter((entry) => entry.provider === preferProvider);
    const only = preferred[0];
    if (preferred.length === 1 && only !== undefined) return { entry: only, confirmed: true };
  }
  return "ambiguous";
}

/**
 * Can this model accept image input? `undefined` when the catalog cannot say —
 * the id is unknown, ambiguous, or carries no `modalities` (R10.14).
 *
 * `preferProvider` disambiguates a shared id: OpenRouter's `deepseek/…` and a
 * direct vendor's `…` can both be present with different capabilities.
 */
export function modelAcceptsImages(
  catalog: ModelCatalog,
  modelId: string,
  opts?: { readonly preferProvider?: string },
): boolean | undefined {
  const match = lookupModel(catalog, modelId, opts);
  return match.entry === null ? undefined : acceptsImageInput(match.entry);
}

/**
 * Find `modelId` in the catalog without ever transforming how it is displayed.
 *
 * Exact id first; then, and only then, the same id with a trailing `-YYYYMMDD`
 * snapshot suffix removed (a dated Anthropic alias prices identically to its
 * undated form, so the fallback is documented rather than guessed — and the
 * caller is told via `how: "dated-snapshot"` so a surface can say so).
 */
export function lookupModel(
  catalog: ModelCatalog,
  modelId: string,
  opts?: { readonly preferProvider?: string },
): ModelMatch {
  const prefer = opts?.preferProvider;
  const exact = selectOne(
    catalog.entries.filter((entry) => entry.id === modelId),
    prefer,
  );
  if (exact === "ambiguous") return { entry: null, how: "ambiguous" };
  if (exact !== null) {
    return { entry: exact.entry, how: exact.confirmed ? "exact" : "provider-unconfirmed" };
  }

  const base = stripDateSnapshot(modelId);
  if (base === null) return { entry: null, how: "unknown" };
  const dated = selectOne(
    catalog.entries.filter((entry) => entry.id === base),
    prefer,
  );
  if (dated === "ambiguous") return { entry: null, how: "ambiguous" };
  if (dated !== null) {
    return { entry: dated.entry, how: dated.confirmed ? "dated-snapshot" : "provider-unconfirmed" };
  }
  return { entry: null, how: "unknown" };
}

/** The billed token split from one `usage` block (R1.1 — see telemetry/types.ts). */
export interface UsageLike {
  readonly inputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly outputTokens: number;
}

/**
 * Money for one usage block, or **null** when the entry carries no price —
 * `golem bench cost` then reports the tokens and says the model is unpriced,
 * which is the R6.4 behaviour and is never wrong.
 *
 * Each bucket is priced at its own rate: uncached input at 1×, cache writes and
 * reads at the entry's explicit prices, falling back to the R1.1 multipliers
 * (1.25× / 0.1×) when the catalog does not state them. Output is independent of
 * caching, exactly as `effectiveInputTokens` documents.
 */
export function priceUsage(entry: ModelCatalogEntry, usage: UsageLike): number | null {
  const input = entry.inputUsdPerMTok;
  const output = entry.outputUsdPerMTok;
  if (input === undefined || output === undefined) return null;
  const cacheWrite = entry.cacheWriteUsdPerMTok ?? input * CACHE_WRITE_MULTIPLIER;
  const cacheRead = entry.cacheReadUsdPerMTok ?? input * CACHE_READ_MULTIPLIER;
  return (
    (usage.inputTokens * input +
      usage.cacheCreationInputTokens * cacheWrite +
      usage.cacheReadInputTokens * cacheRead +
      usage.outputTokens * output) /
    1_000_000
  );
}

export interface ContextWarning {
  readonly tokens: number;
  readonly contextTokens: number;
  /** `tokens / contextTokens`, uncapped — a value > 1 is the point of `over`. */
  readonly usedFraction: number;
  readonly level: "ok" | "approaching" | "over";
}

/**
 * Where a request sits against its model's window, or null when the catalog does
 * not know the window (no limit → no warning, never an invented one).
 */
export function contextWarning(
  entry: ModelCatalogEntry,
  tokens: number,
  warnFraction: number,
): ContextWarning | null {
  const contextTokens = entry.contextTokens;
  if (contextTokens === undefined || contextTokens <= 0) return null;
  const usedFraction = tokens / contextTokens;
  const level = usedFraction >= 1 ? "over" : usedFraction >= warnFraction ? "approaching" : "ok";
  return { tokens, contextTokens, usedFraction, level };
}

// ---------------------------------------------------------------------------
// The optional fetched catalog (models.dev shape).
// ---------------------------------------------------------------------------

/**
 * Deliberately permissive: the upstream is a third-party document, so unknown
 * keys are ignored and every field we read is optional. A provider whose shape
 * we cannot read contributes nothing rather than failing the whole refresh.
 */
const modelsDevModelSchema = z
  .object({
    limit: z
      .object({ context: z.number().optional(), output: z.number().optional() })
      .partial()
      .optional(),
    cost: z
      .object({
        input: z.number().optional(),
        output: z.number().optional(),
        cache_read: z.number().optional(),
        cache_write: z.number().optional(),
      })
      .partial()
      .optional(),
    // R10.14: `{"input":["text","image"],"output":["text"]}`. The capability
    // signal for whether images may be forwarded to this model at all.
    modalities: z
      .object({ input: z.array(z.string()).optional(), output: z.array(z.string()).optional() })
      .partial()
      .optional(),
  })
  .passthrough();

const modelsDevProviderSchema = z
  .object({ models: z.record(modelsDevModelSchema).optional() })
  .passthrough();

const modelsDevPayloadSchema = z.record(modelsDevProviderSchema);

/** Absent-or-non-finite → absent. A non-finite price is not a price. */
function usableNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

/**
 * Turn a models.dev-shaped payload into Golem's own entry shape, keeping only
 * the fields Golem reports. This is a derivation, not a copy: nothing of the
 * upstream document is stored beyond the numbers and the ids they belong to,
 * and `source` records where they came from.
 */
export function normaliseModelsDevPayload(
  raw: unknown,
  source: string,
  asOf: string,
): ModelCatalog {
  const parsed = modelsDevPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `model catalog at ${source} is not a { provider: { models: … } } object: ` +
        `${parsed.error.issues[0]?.message ?? "unrecognized shape"}`,
    );
  }
  const entries: ModelCatalogEntry[] = [];
  for (const [provider, providerBlock] of Object.entries(parsed.data)) {
    for (const [id, model] of Object.entries(providerBlock.models ?? {})) {
      const input = usableNumber(model.cost?.input);
      const output = usableNumber(model.cost?.output);
      const cacheRead = usableNumber(model.cost?.cache_read);
      const cacheWrite = usableNumber(model.cost?.cache_write);
      const context = usableNumber(model.limit?.context);
      const maxOutput = usableNumber(model.limit?.output);
      // Keep the list verbatim; an empty array carries no more than absence does.
      const inputModalities =
        model.modalities?.input !== undefined && model.modalities.input.length > 0
          ? model.modalities.input
          : undefined;
      // Spread-free optional keys: exactOptionalPropertyTypes wants them ABSENT.
      entries.push({
        id,
        provider,
        ...(input !== undefined ? { inputUsdPerMTok: input } : {}),
        ...(output !== undefined ? { outputUsdPerMTok: output } : {}),
        ...(cacheRead !== undefined ? { cacheReadUsdPerMTok: cacheRead } : {}),
        ...(cacheWrite !== undefined ? { cacheWriteUsdPerMTok: cacheWrite } : {}),
        ...(context !== undefined ? { contextTokens: context } : {}),
        ...(maxOutput !== undefined ? { maxOutputTokens: maxOutput } : {}),
        ...(inputModalities !== undefined ? { inputModalities } : {}),
      });
    }
  }
  return { source, asOf, entries };
}

/**
 * Fetch and normalise a catalog. Only ever called from an explicit act
 * (`golem models refresh`) — no report path fetches.
 */
export async function fetchModelCatalog(
  url: string,
  opts: {
    readonly fetchImpl?: typeof fetch;
    readonly nowIso: string;
    readonly timeoutMs?: number;
  },
): Promise<ModelCatalog> {
  const doFetch = opts.fetchImpl ?? fetch;
  const response = await doFetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
  if (!response.ok) {
    throw new Error(`model catalog fetch failed: HTTP ${response.status} from ${url}`);
  }
  return normaliseModelsDevPayload(await response.json(), url, opts.nowIso);
}

const cachedCatalogSchema = z.object({
  source: z.string(),
  asOf: z.string(),
  entries: z.array(
    z.object({
      id: z.string(),
      provider: z.string(),
      inputUsdPerMTok: z.number().optional(),
      outputUsdPerMTok: z.number().optional(),
      cacheReadUsdPerMTok: z.number().optional(),
      cacheWriteUsdPerMTok: z.number().optional(),
      contextTokens: z.number().optional(),
      maxOutputTokens: z.number().optional(),
      inputModalities: z.array(z.string()).optional(),
      note: z.string().optional(),
    }),
  ),
});

/** `.golem/state/model-catalog.json` for a project — a rebuildable cache, not state. */
export function modelCatalogPath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "model-catalog.json");
}

/** Persist the fetched catalog (atomic temp+rename), source and date included. */
export async function writeModelCatalog(projectDir: string, catalog: ModelCatalog): Promise<void> {
  const file = modelCatalogPath(projectDir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

/** Read the cached catalog, or null (missing / corrupt / schema drift). */
export async function readModelCatalog(projectDir: string): Promise<ModelCatalog | null> {
  let raw: string;
  try {
    raw = await readFile(modelCatalogPath(projectDir), "utf8");
  } catch {
    return null;
  }
  try {
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = cachedCatalogSchema.safeParse(JSON.parse(stripped));
    if (!parsed.success) return null;
    // Spread-free rebuild: under exactOptionalPropertyTypes an optional key must
    // be ABSENT, not present-and-undefined (same treatment as served-model.ts).
    const entries: ModelCatalogEntry[] = parsed.data.entries.map((entry) => ({
      id: entry.id,
      provider: entry.provider,
      ...(entry.inputUsdPerMTok !== undefined ? { inputUsdPerMTok: entry.inputUsdPerMTok } : {}),
      ...(entry.outputUsdPerMTok !== undefined ? { outputUsdPerMTok: entry.outputUsdPerMTok } : {}),
      ...(entry.cacheReadUsdPerMTok !== undefined
        ? { cacheReadUsdPerMTok: entry.cacheReadUsdPerMTok }
        : {}),
      ...(entry.cacheWriteUsdPerMTok !== undefined
        ? { cacheWriteUsdPerMTok: entry.cacheWriteUsdPerMTok }
        : {}),
      ...(entry.contextTokens !== undefined ? { contextTokens: entry.contextTokens } : {}),
      ...(entry.maxOutputTokens !== undefined ? { maxOutputTokens: entry.maxOutputTokens } : {}),
      ...(entry.inputModalities !== undefined ? { inputModalities: entry.inputModalities } : {}),
      ...(entry.note !== undefined ? { note: entry.note } : {}),
    }));
    return { source: parsed.data.source, asOf: parsed.data.asOf, entries };
  } catch {
    return null;
  }
}

/**
 * Built-in entries WIN over fetched ones on a (provider, id) collision.
 *
 * This is the whole reason the two layers exist in this order. A third-party
 * catalog is a convenience for models Golem has not priced itself; letting it
 * overwrite a verified price would put someone else's mistake into this
 * project's cost claims — and the web rendering of the very catalog used here
 * showed several Anthropic models at $0.00 on 2026-07-31 (§106).
 */
export function mergeCatalogs(builtin: ModelCatalog, fetched: ModelCatalog | null): ModelCatalog {
  if (fetched === null) return builtin;
  const seen = new Set(builtin.entries.map((entry) => `${entry.provider} ${entry.id}`));
  const entries = [...builtin.entries];
  for (const entry of fetched.entries) {
    const key = `${entry.provider} ${entry.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return {
    source: `${builtin.source} (built-in, authoritative) + ${fetched.source} (fetched ${fetched.asOf})`,
    asOf: builtin.asOf,
    entries,
  };
}

/** Whole days between `asOf` and `nowMs`, or null when `asOf` is unparseable. */
export function catalogAgeDays(catalog: ModelCatalog, nowMs: number): number | null {
  const asOfMs = Date.parse(catalog.asOf);
  if (Number.isNaN(asOfMs)) return null;
  return Math.floor((nowMs - asOfMs) / 86_400_000);
}

/**
 * The catalog a reporting surface should use: built-in ∪ cached-fetched, with the
 * built-in winning. Reads the cache but never fetches (Decision-53 tier 3b: no
 * runtime dependency on someone else's uptime).
 */
export async function loadModelCatalog(projectDir: string): Promise<ModelCatalog> {
  return mergeCatalogs(BUILTIN_MODEL_CATALOG, await readModelCatalog(projectDir));
}
