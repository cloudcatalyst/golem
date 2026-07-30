/**
 * The managed-tool registry (spec Decision 53).
 *
 * Golem integrates external tools by **spawning or detecting** them, never by
 * shipping their bytes. Three integrations arrived at that shape independently
 * (Headroom, Ollama, Caveman) before it was written down; this file is the
 * written-down version, and it is data — one row per tool, no behaviour.
 *
 * A row answers the questions that were previously only answerable by grepping
 * the process table: what tier is it, is it installed, is it turned on, what
 * happens when it is missing, and — the one that actually caused confusion —
 * does "enabled" mean "running"? (For Headroom it does not; see `gate`.)
 *
 * **Admission bar.** A tool belongs here only if all four hold:
 *   1. it does something Golem should not reimplement;
 *   2. it has a stable, pinnable invocation contract;
 *   3. its absence degrades to a no-op, never an error path;
 *   4. Golem ships none of its bytes.
 *
 * The Caveman *speech skill* deliberately fails (1) — see its row.
 */

/**
 * Where a tool sits on the dependency ladder (Decision 53).
 *
 * `tier-1` is not represented here: those are Golem's own npm `dependencies`,
 * which are not managed tools. `unpdf` and `web-tree-sitter` are `tier-2`
 * because they are optional and absence-tolerant, even though npm may install
 * them for you.
 */
export type ExtTier =
  /** Spawned or resolved on demand at an exact pin; user provides it; off by default. */
  | "tier-2"
  /** A peer that acts on the same surface independently; Golem detects and defers. */
  | "tier-3a"
  /** Golem re-implemented the idea as its own data/code, citing the source, copying nothing. */
  | "tier-3b";

/** How Golem relates to the tool — determines what "manage" can even mean. */
export type ExtShape =
  /** Golem invokes it (subprocess or HTTP service). Full wrap is possible. */
  | "callable"
  /** It acts on the same surface independently. Coordinate; never drive. */
  | "peer"
  /** It runs inside Golem's own process, inside the redaction path. */
  | "in-process";

/** How presence is detected — all spawn-free (see detect.ts). */
export type ExtDetect =
  /** An executable on `PATH` (Windows `PATHEXT`-aware). */
  | { readonly kind: "command"; readonly command: string }
  /** An optional npm module that must merely resolve. */
  | { readonly kind: "module"; readonly specifier: string }
  /** Golem's own bundled data — always present by construction (tier-3b). */
  | { readonly kind: "bundled" };

export interface ExtManifest {
  /** Stable id used by the CLI and the JSON output. */
  readonly id: string;
  /** Human title as its own project spells it. */
  readonly title: string;
  /** One line: what it does for Golem. */
  readonly what: string;
  readonly tier: ExtTier;
  readonly shape: ExtShape;
  /** Upstream home, so a row is traceable to a real project. */
  readonly upstream: string;
  /** Upstream licence, recorded because Golem redistributes nothing. */
  readonly licence: string;
  /** Exact version Golem targets, where it pins one. */
  readonly pin?: string;
  readonly detect: ExtDetect;
  /** Other registry ids that must also be present (e.g. Headroom needs uv). */
  readonly requires?: readonly string[];
  /** How a human installs it. Golem does NOT run this (read-only surface). */
  readonly install: string;
  /** `section.key` in settings that turns it on, when one exists. */
  readonly enabledBy?: string;
  /** Repo path of the single file that quarantines its imports/invocation. */
  readonly adapter?: string;
  /** What happens when it is absent. Must always be a no-op, never an error. */
  readonly degrade: string;
  /**
   * Why "enabled" may still mean "not running". Present only where a further
   * runtime gate exists — this is the field that answers the question the
   * process table had to answer before.
   */
  readonly gate?: string;
}

/**
 * The registry. Every fact here is checked against this repo, not assumed:
 * pins from `src/compression/index.ts`, settings keys from
 * `src/config/schema.ts`, adapters from the paths named.
 */
export const EXT_MANIFESTS: readonly ExtManifest[] = [
  {
    id: "uv",
    title: "uv",
    what: "Python launcher Golem uses to run the Headroom sidecars at an exact pin, with no global install.",
    tier: "tier-2",
    shape: "callable",
    upstream: "https://github.com/astral-sh/uv",
    licence: "MIT OR Apache-2.0",
    detect: { kind: "command", command: "uv" },
    install: "https://docs.astral.sh/uv/getting-started/installation/",
    degrade:
      "Both Headroom sidecars are unavailable; the semantic stage and MEMORY federation stay off.",
  },
  {
    id: "headroom",
    title: "Headroom (compression sidecar)",
    what: "ML-heavy compression stages Golem does not implement itself.",
    tier: "tier-2",
    shape: "callable",
    upstream: "https://github.com/headroomlabs-ai/headroom",
    licence: "see upstream",
    pin: "headroom-ai==0.30.0",
    detect: { kind: "command", command: "uv" },
    requires: ["uv"],
    install: "No install step — `uv run --with headroom-ai==<pin>` fetches it on first use.",
    enabledBy: "compression.headroom_sidecar",
    adapter: "src/compression/headroom-adapter.ts",
    degrade: "The lossy semantic stage is skipped; lossless/CCR compression is unaffected.",
    gate:
      "Enabled does NOT mean running. The sidecar is spawned lazily by the lossy semantic stage, " +
      "and that stage is gated off on caching upstreams (Decision 31) unless " +
      "`compression.force_semantic_on_caching` is set — so against Anthropic with stock settings it " +
      "never starts.",
  },
  {
    id: "headroom-memory",
    title: "Headroom (memory sidecar)",
    what: "MEMORY-scope federated search via Headroom's optional `[memory]` extra (R3.6/C4).",
    tier: "tier-2",
    shape: "callable",
    upstream: "https://github.com/headroomlabs-ai/headroom",
    licence: "see upstream",
    pin: "headroom-ai[memory]==0.30.0",
    detect: { kind: "command", command: "uv" },
    requires: ["uv"],
    install:
      "No install step — `uv run --with 'headroom-ai[memory]==<pin>'` fetches it on first use.",
    enabledBy: "knowledge.memory_federation_enabled",
    adapter: "src/compression/headroom-adapter.ts",
    degrade: "`search` covers the wiki and knowledge scopes only; no MEMORY scope.",
    gate:
      "A separate opt-in process from the compression sidecar, and heavier (it pulls torch " +
      "transitively) — the two are independent.",
  },
  {
    id: "ollama",
    title: "Ollama",
    what: "Local/LAN model runtime behind the `coder` drafter, the judge, task multiplexing, and prompt translation.",
    tier: "tier-2",
    shape: "callable",
    upstream: "https://github.com/ollama/ollama",
    licence: "MIT",
    detect: { kind: "command", command: "ollama" },
    install:
      "https://ollama.com/download — or point Golem at a LAN box with `golem local url <url>`.",
    enabledBy: "inference.local_coder_enabled",
    adapter: "src/inference/",
    degrade:
      "Local drafting/judging is unavailable; every request goes upstream. `golem devices` reports it.",
    gate:
      "Detection is PATH-only. A LAN endpoint set via `golem local url` needs no local binary — " +
      "`golem local status` is the authority on which endpoint is in use.",
  },
  {
    id: "unpdf",
    title: "unpdf",
    what: "PDF text-layer extraction ahead of chunking, so `.pdf` files are ingestable.",
    tier: "tier-2",
    shape: "in-process",
    upstream: "https://github.com/unjs/unpdf",
    licence: "MIT",
    pin: "^1.6.2",
    detect: { kind: "module", specifier: "unpdf" },
    install:
      "npm install unpdf (also listed in Golem's optionalDependencies, so npm usually has it already)",
    adapter: "src/knowledge/extractors.ts",
    degrade:
      "`.pdf` files are counted in `filesSkipped` and ingest continues; WebFetch of a PDF falls open.",
  },
  {
    id: "web-tree-sitter",
    title: "web-tree-sitter",
    what: "Syntax-aware code chunking (WASM grammars) instead of the heuristic chunker.",
    tier: "tier-2",
    shape: "in-process",
    upstream: "https://github.com/tree-sitter/tree-sitter",
    licence: "MIT",
    detect: { kind: "module", specifier: "web-tree-sitter" },
    install:
      "npm install web-tree-sitter plus the grammar packages you want (devDependencies here; never shipped).",
    enabledBy: "knowledge.syntax_aware_chunking",
    adapter: "src/knowledge/tree-sitter-chunker.ts",
    degrade: "Chunking falls back to the heuristic `chunkFile`, which is always available.",
  },
  {
    id: "rtk",
    title: "RTK",
    what: "Rewrites Bash commands to filtered equivalents, cutting shell output before it reaches the model.",
    tier: "tier-3a",
    shape: "peer",
    upstream: "https://github.com/rtk-ai/rtk",
    licence: "Apache-2.0",
    detect: { kind: "command", command: "rtk" },
    install: "brew install rtk (or see upstream), then `rtk init -g`. Golem never installs it.",
    degrade:
      "Bash output is handled by Golem's own PostToolUse CCR swap, as it is today. Nothing is lost.",
    gate:
      "A peer, not a dependency: RTK installs its own PreToolUse hook and Golem does not drive it. " +
      "Golem's job is to avoid double-compacting and to attribute savings separately.",
  },
  {
    id: "caveman",
    title: "Caveman (speech skill)",
    what: "A prompt-delivered brevity skill for Claude Code — the idea Golem's own brevity dial implements in-flight.",
    tier: "tier-3a",
    shape: "peer",
    upstream: "https://github.com/JuliusBrussee/caveman",
    licence: "MIT",
    detect: { kind: "command", command: "caveman" },
    install:
      "Not recommended alongside Golem — see `degrade`. Installing it makes Golem's brevity dial stand down.",
    degrade:
      "Golem's own brevity dial covers it, from the proxy, for every client, with zero dependencies.",
    gate:
      "Deliberately fails admission criterion 1 (verification-notes §87): its own README puts input " +
      "tokens saved at 0% and it adds ~1-1.5k input tokens per turn, its installer targets one agent's " +
      "skill directory, and there is no API to call — the skill IS a prompt. Golem detects it only so " +
      "the two do not stack (`hasExistingBrevityDirective`).",
  },
  {
    id: "brevity-profiles",
    title: "Brevity profiles (bundled)",
    what: "Golem's own output-brevity directive text, inspired by Caveman and written from scratch.",
    tier: "tier-3b",
    shape: "in-process",
    upstream: "https://github.com/JuliusBrussee/caveman",
    licence: "MIT (attribution; no text copied — Decision 52)",
    detect: { kind: "bundled" },
    install: "Built in — nothing to install.",
    enabledBy: "brevity.level",
    adapter: "src/pipeline/brevity.ts",
    degrade: "n/a — bundled data, always present.",
    gate:
      "Present in the registry to record the tier-3b precedent: the idea was re-implemented as Golem's " +
      "own data with attribution rather than by wrapping the upstream package.",
  },
] as const;

/** Look up one manifest by id. */
export function extManifest(id: string): ExtManifest | undefined {
  return EXT_MANIFESTS.find((m) => m.id === id);
}
