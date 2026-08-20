/**
 * Auto-index the project into the knowledge base (mcp-serve auto-index +
 * semantic-upgrade + incremental freshness).
 *
 * A `manifest.json` beside each collection records the EMBEDDER SIGNATURE and a
 * per-file state map (`sourcePath → mtime/size`). On `golem mcp serve` startup:
 *   - no manifest        → first-run full index (populate search, no manual step),
 *   - signature changed  → clear + full rebuild (e.g. user pulled bge-m3),
 *   - signature matches   → INCREMENTAL sync: re-index only changed/new files and
 *     drop deleted files' chunks (so edits are reflected without a full rebuild),
 *   - nothing changed    → no-op.
 * Incremental needs a deletable driver + a single index root; otherwise a change
 * falls back to a full rebuild. Runs in the BACKGROUND — never blocks startup.
 *
 * R11.2 — two rules exist because that background run is GPU-expensive (measured:
 * ~10 minutes to re-embed 114 changed files with bge-m3):
 *   - the incremental sync CHECKPOINTS its manifest every
 *     {@link INDEX_CHECKPOINT_FILES} files, so a run killed with the session
 *     resumes where it stopped instead of re-embedding everything next time. The
 *     old code wrote the manifest only at the very end, so any session shorter
 *     than the sync recorded nothing and the next session repeated the identical
 *     work — a spike on every session start with no file actually changing;
 *   - an AUTOMATIC caller may cap the work with {@link EnsureIndexedOptions.maxAutoFiles};
 *     past the cap the sync DEFERS to an explicit `golem index` rather than
 *     silently starting a multi-minute embed at session start. A branch switch
 *     rewrites mtimes wholesale, so a huge changed-set is routine, not rare.
 */

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { embedDimFor, embedModelFor } from "../inference/index.js";
import type { HardwareTier } from "../interfaces/inference.js";
import type { KnowledgeBase } from "../interfaces/knowledge.js";
import {
  collectionDir,
  type FileState,
  knowledgeDir,
  readCollectionDim,
  scanFiles,
  supportsIncremental,
} from "../knowledge/index.js";
import type { EmbedMode } from "./build-knowledge.js";

/** Per-file change signal persisted in the manifest. */
interface PersistedFileState {
  /** mtime epoch ms. */
  readonly m: number;
  /** byte size. */
  readonly s: number;
}

/**
 * The embedder identity recorded alongside an index (R10.4). Redundant with
 * {@link IndexManifest.signature}, which already encodes the same model — this
 * is the PARSED, self-describing form, so a reader never has to know the
 * signature's grammar or consult the tier catalog to learn what built the index.
 */
interface PersistedEmbedderRecord {
  readonly mode: EmbedMode;
  /** Ollama model for a semantic index; null for the lexical hashing embedder. */
  readonly model: string | null;
  /** Vector width the index actually stores; null when not yet known. */
  readonly dim: number | null;
}

interface IndexManifest {
  readonly signature: string;
  readonly ts?: string;
  readonly paths?: readonly string[];
  readonly files?: Readonly<Record<string, PersistedFileState>>;
  /** R10.4 — added by writeManifest; absent on manifests written before it. */
  readonly embedder?: PersistedEmbedderRecord;
}

/**
 * A stable identity for the embedder that built an index. Changing embedder
 * (lexical hashing ↔ a specific Ollama model) changes vector space + dimension,
 * so a signature mismatch means the index must be rebuilt.
 */
export function embedderSignature(mode: EmbedMode, tier: HardwareTier): string {
  return embedderSignatureForModel(mode, embedModelFor(tier, "text"));
}

/**
 * The same identity, from the CONCRETE model rather than the tier that would
 * select it (R10.6).
 *
 * A build may deliberately embed with a model the current tier would NOT choose
 * — see {@link planBuildEmbedder} — and the signature has to name the model
 * actually used. A signature computed from the tier would describe an index that
 * was never written, and every later run would see a mismatch and rebuild.
 */
export function embedderSignatureForModel(mode: EmbedMode, model: string | null): string {
  return mode === "semantic" && model !== null ? `semantic:${model}` : "lexical:hash-v1-512";
}

/**
 * Split an {@link embedderSignature} back into mode + model. Returns null for an
 * unrecognized signature (a newer/older writer), which callers must treat as
 * "unknown", never as "matches".
 */
export function parseEmbedderSignature(
  signature: string,
): { mode: EmbedMode; model: string | null } | null {
  if (signature.startsWith("semantic:")) {
    const model = signature.slice("semantic:".length);
    return { mode: "semantic", model: model === "" ? null : model };
  }
  if (signature.startsWith("lexical:")) return { mode: "lexical", model: null };
  return null;
}

/** Paths to auto-index: configured `watch_paths` (relative → project-rooted), else the project root. */
export function resolveIndexPaths(projectDir: string, watchPaths: readonly string[]): string[] {
  if (watchPaths.length === 0) return [projectDir];
  return watchPaths.map((p) => (path.isAbsolute(p) ? p : path.join(projectDir, p)));
}

async function readManifest(dir: string): Promise<IndexManifest | null> {
  try {
    return JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as IndexManifest;
  } catch {
    return null;
  }
}

/**
 * Which embedder space an EXISTING project index was built in, read back from
 * its persisted manifest signature (see {@link embedderSignature}). A query MUST
 * be embedded in this same space or it silently scores 0 against every chunk
 * (guarded by `assertEmbedderSpaceMatch`), so query-side callers (the proxy's
 * local-answer KB) use this to pick a matching embedder rather than a blind
 * "is Ollama up?" probe. Returns `null` when there is no index yet, or the
 * manifest is missing/unreadable/unrecognized.
 */
export async function resolvePersistedEmbedMode(
  projectDir: string,
  projectId: string,
): Promise<EmbedMode | null> {
  return (await resolvePersistedEmbedder(projectDir, projectId))?.mode ?? null;
}

/**
 * The full embedder identity an EXISTING project index was built with (R10.4).
 *
 * The embedder is otherwise chosen by the DETECTED HARDWARE TIER, and
 * `detectCapability` degrades to the CPU tier on any probe failure — so a
 * transient hiccup, a briefly-down Ollama, or a loaded machine silently swaps
 * the embedding model, and therefore the vector WIDTH, under an index that
 * cannot accept it. The index's embedder is the fact that matters; the tier is
 * only an implementation detail of having once picked one. Query-side callers
 * compare against THIS rather than probing "can I run an embedder?" — an
 * availability answer that is true for the wrong model too.
 *
 * Sources, most authoritative first:
 *  - `manifest.embedder` — written since R10.4, self-describing;
 *  - `manifest.signature` — the model an older manifest encodes;
 *  - the driver's `meta.json` `dim` — the width the index ACTUALLY stores,
 *    present for every index this driver has ever written, which is what makes
 *    a pre-R10.4 index checkable at all rather than merely "unknown".
 *
 * Returns null when there is no index yet, or the manifest is
 * missing/unreadable/unrecognized.
 */
export async function resolvePersistedEmbedder(
  projectDir: string,
  projectId: string,
): Promise<PersistedEmbedderRecord | null> {
  const base = knowledgeDir(projectDir);
  const manifest = await readManifest(collectionDir(base, projectId));
  if (manifest === null) return null;
  const parsed =
    typeof manifest.signature === "string" ? parseEmbedderSignature(manifest.signature) : null;
  const mode = manifest.embedder?.mode ?? parsed?.mode;
  if (mode === undefined) return null;
  const model = manifest.embedder?.model ?? parsed?.model ?? null;
  // Prefer the width the index really stores over anything recorded about it.
  const dim = (await readCollectionDim(base, projectId)) ?? manifest.embedder?.dim ?? null;
  return { mode, model, dim };
}

/**
 * What a query-side caller should do about the semantic embedder, given what
 * built the index (R10.4). See {@link planQueryEmbedder}.
 */
export type QueryEmbedderPlan =
  /** No semantic index (or none at all) — use the pure-TS lexical embedder. */
  | { readonly action: "lexical" }
  /** The current tier's embedder IS the one that built the index. */
  | { readonly action: "use-current"; readonly model: string }
  /** The tier drifted; query with the index's own embedder instead. */
  | { readonly action: "pin"; readonly model: string; readonly currentModel: string }
  /** Cannot query this index correctly — decline ONCE, up front. */
  | { readonly action: "disable"; readonly reason: string };

/** Human-readable `"model" (768-dim)`, dropping the width when unknown. */
function describeEmbedder(model: string, dim: number | null): string {
  const width = dim ?? embedDimFor(model);
  return width === null ? `"${model}"` : `"${model}" (${width}-dim)`;
}

/** An {@link embedderSignature} rendered for a human; the raw string if unparsable. */
function describeSignature(signature: string): string {
  const parsed = parseEmbedderSignature(signature);
  if (parsed === null) return signature;
  return parsed.model === null ? "lexical (built-in)" : describeEmbedder(parsed.model, null);
}

/**
 * Decide which embedder to query an existing index with — by EMBEDDER IDENTITY,
 * not embedder availability (R10.4).
 *
 * The old guard asked "can I run *an* embedder?", which is answered `true` by
 * the wrong model just as readily as the right one: when a degraded hardware
 * probe re-pointed the tier at a 768-dim embedder, the tier-1 model was indeed
 * available, the guard passed, and every single query then threw
 * `EmbedderMismatchError` against the 1024-dim index — failing open into a
 * feature that was silently doing an embed call per request and discarding it.
 *
 * So the index's recorded embedder wins over the current tier's: a tier
 * downgrade must NOT be allowed to change the embedder of an index that already
 * exists. Either we query with what built it, or we decline once, naming both
 * models — never an error per query.
 *
 * `isAvailable` is the Ollama probe (`ollamaHasModel`); it is consulted for the
 * model we actually intend to use, not for whichever one the tier suggests.
 */
export async function planQueryEmbedder(
  persisted: PersistedEmbedderRecord | null,
  currentModel: string,
  isAvailable: (model: string) => Promise<boolean>,
): Promise<QueryEmbedderPlan> {
  if (persisted === null || persisted.mode !== "semantic") return { action: "lexical" };

  // The embedder the index says built it. A manifest too old to name one leaves
  // only the current model as a candidate — still width-checked below, which is
  // the check that actually protects the query.
  const target = persisted.model ?? currentModel;
  const targetDim = embedDimFor(target);

  // The index's stored width is ground truth (the driver's meta.json). If the
  // recorded embedder cannot produce it, the record is not trustworthy and no
  // catalog model is known to fit — decline rather than guess.
  if (persisted.dim !== null && targetDim !== null && targetDim !== persisted.dim) {
    return {
      action: "disable",
      reason:
        `the index stores ${persisted.dim}-dim vectors, but its recorded embedder ` +
        `${describeEmbedder(target, targetDim)} produces ${targetDim}-dim ones — ` +
        "rebuild it with `golem index`",
    };
  }

  if (!(await isAvailable(target))) {
    const alsoTried =
      target === currentModel
        ? ""
        : ` — the current hardware tier would use ${describeEmbedder(currentModel, null)}, ` +
          "which cannot query it";
    return {
      action: "disable",
      reason:
        `the index was built with the semantic embed model ${describeEmbedder(target, persisted.dim)}, ` +
        `which isn't available now${alsoTried}. Start Ollama and pull ${target}, or run ` +
        "`golem index` to rebuild the index with the embedder this machine has",
    };
  }

  return target === currentModel
    ? { action: "use-current", model: target }
    : { action: "pin", model: target, currentModel };
}

/**
 * What the BUILD side should embed with (R10.6) — the counterpart of
 * {@link QueryEmbedderPlan}, and deliberately the same vocabulary.
 */
export type BuildEmbedderPlan =
  /** No semantic embedder to use — build with the pure-TS lexical embedder. */
  | { readonly action: "lexical"; readonly notice?: string }
  /** The current tier's embedder is the right one (no index yet, or it matches). */
  | { readonly action: "use-current"; readonly model: string }
  /** Keep the EXISTING index's embedder; the tier's would narrow it. */
  | {
      readonly action: "pin";
      readonly model: string;
      readonly currentModel: string;
      readonly notice: string;
    }
  /** The index WILL be re-embedded into a different vector space — say so. */
  | {
      readonly action: "reembed";
      readonly model: string;
      readonly previous: string;
      readonly notice: string;
    };

/**
 * Decide which embedder to BUILD an index with (R10.6), given what built the
 * one already on disk. The build-side counterpart of {@link planQueryEmbedder}.
 *
 * The build side used to pick purely by detected hardware tier, and
 * `detectCapability` degrades to the CPU tier on ANY probe failure. Nothing
 * errored — a changed embedder changes the signature, which rebuilds the index,
 * so the result stayed self-consistent — but a transient hiccup silently
 * re-embedded the WHOLE index at the degraded width (768 in place of 1024),
 * which is expensive, invisible, and quietly worse at retrieval until something
 * rebuilt it again.
 *
 * The rule: **a build never narrows an existing index's vectors while the
 * embedder that built it is still available.** Narrowing is the harmful
 * direction — it is pure loss (a full re-embed AND weaker retrieval), and it is
 * exactly what a degraded probe asks for. Widening is not blocked: an index
 * built on the CPU tier that finds itself on a machine with the wider embedder
 * is the advertised semantic upgrade, and it is announced like any other
 * re-embed. Widths come from {@link embedDimFor}; when either is unknown the
 * change counts as narrowing, because an unrecognized model is not evidence
 * that re-embedding is safe.
 *
 * Refusing outright was the other candidate and is deliberately NOT what this
 * does: the caller would be left holding a knowledge base whose embedder does
 * not match the index on disk, which turns into an `EmbedderMismatchError` on
 * every search — a probe failure must degrade, never become an error path.
 *
 * `isAvailable` is the Ollama probe (`ollamaHasModel`), consulted for the model
 * we actually intend to use rather than whichever one the tier suggests.
 */
export async function planBuildEmbedder(
  persisted: PersistedEmbedderRecord | null,
  currentModel: string,
  isAvailable: (model: string) => Promise<boolean>,
): Promise<BuildEmbedderPlan> {
  const previous = persisted !== null && persisted.mode === "semantic" ? persisted.model : null;

  // Each model is probed at most once. While a semantic index is at stake, a
  // `false` is retried once before we believe it: `ollamaHasModel` is a 1.5 s
  // HTTP timeout against a local server, and a false negative here costs a full
  // re-embed of every chunk — the precise expense this plan exists to avoid.
  const answers = new Map<string, boolean>();
  const available = async (model: string): Promise<boolean> => {
    const cached = answers.get(model);
    if (cached !== undefined) return cached;
    const ok = (await isAvailable(model)) || (previous !== null && (await isAvailable(model)));
    answers.set(model, ok);
    return ok;
  };
  const currentOk = await available(currentModel);

  // No semantic index to protect: the tier's choice is exactly right, and
  // lexical → semantic stays the advertised zero-setup upgrade.
  if (previous === null) {
    return currentOk ? { action: "use-current", model: currentModel } : { action: "lexical" };
  }

  const previousDim = persisted?.dim ?? embedDimFor(previous);
  const from = describeEmbedder(previous, previousDim);
  const restore =
    `Start Ollama and pull ${previous}, then run \`golem index\`, ` +
    "to rebuild it with the embedder it was built with";

  if (previous === currentModel) {
    if (currentOk) return { action: "use-current", model: currentModel };
    return {
      action: "lexical",
      notice:
        `${from} built this index and is not available here, so the index is being rebuilt ` +
        `with the built-in lexical embedder — weaker retrieval. ${restore}`,
    };
  }

  const currentDim = embedDimFor(currentModel);
  const to = describeEmbedder(currentModel, currentDim);
  const narrows = previousDim === null || currentDim === null || currentDim < previousDim;

  if (narrows && (await available(previous))) {
    return {
      action: "pin",
      model: previous,
      currentModel,
      notice:
        `building with ${from} — the embedder this index was built with. The detected ` +
        `hardware tier would use ${to}, which would re-embed the whole index into a ` +
        "narrower space; delete .golem/knowledge if that is what you want",
    };
  }
  if (currentOk) {
    return {
      action: "reembed",
      model: currentModel,
      previous,
      notice: narrows
        ? `re-embedding the ENTIRE index, ${from} → ${to}: ${from} built it but is not ` +
          `available here, so it cannot be kept in the space it was built in. ${restore}`
        : `re-embedding the ENTIRE index, ${from} → ${to}: this machine now supports the ` +
          "wider embedder",
    };
  }
  if (await available(previous)) {
    return {
      action: "pin",
      model: previous,
      currentModel,
      notice:
        `building with ${from} — the embedder this index was built with. The detected ` +
        `hardware tier would use ${to}, which is not available here`,
    };
  }
  return {
    action: "lexical",
    notice:
      `neither ${from}, which built this index, nor ${to}, which the detected hardware ` +
      "tier would use, is available here — the index is being rebuilt with the built-in " +
      `lexical embedder, which is weaker at retrieval. ${restore}`,
  };
}

/** Scan all roots into a `sourcePath → FileState` map (last-writer-wins across roots). */
async function scanAll(roots: readonly string[]): Promise<Map<string, FileState>> {
  const map = new Map<string, FileState>();
  for (const root of roots) {
    for (const f of await scanFiles(root)) map.set(f.sourcePath, f);
  }
  return map;
}

function toPersisted(states: Map<string, FileState>): Record<string, PersistedFileState> {
  const out: Record<string, PersistedFileState> = {};
  for (const [sp, f] of states) out[sp] = { m: f.mtimeMs, s: f.size };
  return out;
}

/** Record the manifest (embedder signature + file states) for a collection. */
export async function writeManifest(
  projectDir: string,
  projectId: string,
  signature: string,
  paths: readonly string[],
  now: string,
  files: Readonly<Record<string, PersistedFileState>> = {},
): Promise<void> {
  const base = knowledgeDir(projectDir);
  const dir = collectionDir(base, projectId);
  await mkdir(dir, { recursive: true });
  // R10.4: record the embedder as a FACT ABOUT THE INDEX, not something a
  // reader has to re-derive from the current machine's hardware tier. Width
  // comes from what the driver just persisted (authoritative — it is what a
  // query is dimension-checked against); the catalog table is only the fallback
  // for the ingest-less paths that write a manifest before any vector exists.
  const parsed = parseEmbedderSignature(signature);
  const embedder: PersistedEmbedderRecord | undefined =
    parsed === null
      ? undefined
      : {
          mode: parsed.mode,
          model: parsed.model,
          dim:
            (await readCollectionDim(base, projectId)) ??
            (parsed.model === null ? null : embedDimFor(parsed.model)),
        };
  const manifest: IndexManifest = {
    signature,
    ts: now,
    paths,
    files,
    ...(embedder !== undefined ? { embedder } : {}),
  };
  await writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
}

export interface EnsureIndexedOptions {
  readonly projectDir: string;
  readonly projectId: string;
  readonly knowledge: KnowledgeBase;
  readonly embedMode: EmbedMode;
  readonly tier: HardwareTier;
  /**
   * R10.6 — the embed model actually backing `knowledge`, for callers that chose
   * it by INDEX IDENTITY rather than by tier ({@link planBuildEmbedder}). The
   * manifest signature is taken from this when supplied: a pinned build embeds
   * with a model the tier would not pick, and a tier-derived signature would
   * then describe an index that was never written. Omit to keep the historical
   * tier-derived behaviour (`null` means the lexical hashing embedder).
   */
  readonly embedModel?: string | null;
  readonly watchPaths: readonly string[];
  /**
   * R11.2 — the most changed/deleted files this run may sync before it defers
   * (`0`/omitted = no cap). For AUTOMATIC callers only: `golem mcp serve` fires
   * this on every session start, where an unbounded sync is minutes of GPU the
   * user never asked for. Past the cap nothing is embedded and the manifest is
   * left alone, so the deferred work is still waiting for `golem index`.
   *
   * Deliberately NOT applied to the first-run/embedder-change full build: a
   * project with no index at all has no search, and that build is announced.
   */
  readonly maxAutoFiles?: number;
  /** Current time (ISO); injected so callers/tests control it. */
  readonly now: string;
  readonly log?: (msg: string) => void;
}

/** Outcome of an {@link ensureProjectIndexed} run (handy for logs/tests). */
export interface EnsureIndexedResult {
  readonly action: "skipped" | "indexed" | "reindexed" | "synced" | "deferred";
  readonly chunks: number;
  readonly files: number;
  /** Incremental only: files changed/added and removed. */
  readonly updated?: number;
  readonly removed?: number;
}

/**
 * How many files an incremental sync embeds between manifest checkpoints.
 *
 * Small enough that an interrupted run loses seconds of work, large enough that
 * the manifest write (one JSON of every tracked file's state) stays noise next
 * to embedding a batch.
 */
export const INDEX_CHECKPOINT_FILES = 20;

/** Full (re)index of every root, then persist the manifest with fresh file states. */
async function fullIndex(
  opts: EnsureIndexedOptions,
  roots: readonly string[],
  signature: string,
): Promise<{ chunks: number; files: number }> {
  let chunks = 0;
  let files = 0;
  for (const root of roots) {
    const report = await opts.knowledge.ingest(root, opts.projectId);
    chunks += report.chunksIndexed;
    files += report.filesSeen;
  }
  const states = await scanAll(roots);
  await writeManifest(
    opts.projectDir,
    opts.projectId,
    signature,
    roots,
    opts.now,
    toPersisted(states),
  );
  return { chunks, files };
}

/**
 * Ensure the project index matches the current embedder AND current files. Full
 * (re)build on first run / embedder change; otherwise an incremental sync of just
 * what changed; no-op when nothing changed.
 */
export async function ensureProjectIndexed(
  opts: EnsureIndexedOptions,
): Promise<EnsureIndexedResult> {
  const dir = collectionDir(knowledgeDir(opts.projectDir), opts.projectId);
  const signature =
    opts.embedModel === undefined
      ? embedderSignature(opts.embedMode, opts.tier)
      : embedderSignatureForModel(opts.embedMode, opts.embedModel);
  const manifest = await readManifest(dir);
  const roots = resolveIndexPaths(opts.projectDir, opts.watchPaths);
  const log = opts.log ?? (() => {});

  // First run or embedder change → full (re)build.
  if (manifest?.signature !== signature) {
    if (manifest !== null) {
      // R10.6: name what changed and what it costs. This is the one branch that
      // throws away every vector in the index, so it must never read as routine.
      log(
        `embedder changed: ${describeSignature(manifest.signature)} → ${describeSignature(signature)}` +
          " — re-embedding the ENTIRE index, not just changed files",
      );
      await rm(dir, { recursive: true, force: true });
    } else {
      log(`indexing project for search (${signature})`);
    }
    const { chunks, files } = await fullIndex(opts, roots, signature);
    log(`indexed ${chunks} chunks from ${files} file(s)`);
    return { action: manifest !== null ? "reindexed" : "indexed", chunks, files };
  }

  // Signature matches → incremental sync of changed/new/deleted files.
  const current = await scanAll(roots);
  const prev = manifest.files ?? {};
  const changed: string[] = [];
  for (const [sp, f] of current) {
    const p = prev[sp];
    if (p === undefined || p.m !== f.mtimeMs || p.s !== f.size) changed.push(f.abs);
  }
  const deleted = Object.keys(prev).filter((sp) => !current.has(sp));
  if (changed.length === 0 && deleted.length === 0) {
    return { action: "skipped", chunks: 0, files: 0 };
  }

  // R11.2: the cap is checked BEFORE the incremental/rebuild fork — the fallback
  // path is a full rebuild, which is the most expensive outcome of all, and an
  // automatic caller must never reach it by surprise.
  const cap = opts.maxAutoFiles ?? 0;
  if (cap > 0 && changed.length + deleted.length > cap) {
    log(
      `${changed.length} changed, ${deleted.length} removed — more than the auto-index cap ` +
        `(${cap}), so nothing was embedded. Run \`golem index\` to sync now, or raise ` +
        "`knowledge.auto_index_max_files`",
    );
    return {
      action: "deferred",
      chunks: 0,
      files: current.size,
      updated: changed.length,
      removed: 0,
    };
  }

  // Incremental needs a deletable driver + a single (directory) root so source
  // paths line up; otherwise fall back to a full rebuild.
  const singleDirRoot =
    roots.length === 1 &&
    roots[0] !== undefined &&
    (await stat(roots[0]).catch(() => null))?.isDirectory();
  if (!supportsIncremental(opts.knowledge) || singleDirRoot !== true || roots[0] === undefined) {
    log(`${changed.length + deleted.length} change(s) — rebuilding index`);
    await rm(dir, { recursive: true, force: true });
    const { chunks, files } = await fullIndex(opts, roots, signature);
    return { action: "reindexed", chunks, files };
  }

  const baseDir = roots[0];
  // R11.2: progress is persisted as it is EARNED. The map starts from the states
  // the last completed run recorded and advances one batch at a time, so the
  // manifest never claims a file whose chunks aren't in the store yet — and an
  // interrupted run (the session ends, the MCP server is replaced) leaves the
  // batches it did finish permanently done.
  const progress: Record<string, PersistedFileState> = { ...prev };
  const checkpoint = (): Promise<void> =>
    writeManifest(opts.projectDir, opts.projectId, signature, roots, opts.now, progress);
  const sourcePathByAbs = new Map<string, string>();
  for (const [sp, f] of current) sourcePathByAbs.set(f.abs, sp);

  // Deletions first: they cost no embedding, so checkpointing them is free and
  // they never have to be redone.
  const removed = await opts.knowledge.removeSourcePaths(opts.projectId, deleted);
  for (const sp of deleted) delete progress[sp];
  if (deleted.length > 0) await checkpoint();

  let chunks = 0;
  for (let i = 0; i < changed.length; i += INDEX_CHECKPOINT_FILES) {
    const batch = changed.slice(i, i + INDEX_CHECKPOINT_FILES);
    chunks += await opts.knowledge.reindexFiles(baseDir, opts.projectId, batch);
    for (const abs of batch) {
      const sp = sourcePathByAbs.get(abs);
      const f = sp === undefined ? undefined : current.get(sp);
      if (sp !== undefined && f !== undefined) progress[sp] = { m: f.mtimeMs, s: f.size };
    }
    await checkpoint();
    if (changed.length > INDEX_CHECKPOINT_FILES) {
      log(`synced ${i + batch.length}/${changed.length} changed file(s)`);
    }
  }

  await writeManifest(
    opts.projectDir,
    opts.projectId,
    signature,
    roots,
    opts.now,
    toPersisted(current),
  );
  log(`synced: ${changed.length} changed, ${deleted.length} removed`);
  return {
    action: "synced",
    chunks,
    files: current.size,
    updated: changed.length,
    removed,
  };
}
