/**
 * The managed-package registry (spec Decision 53).
 *
 * Golem integrates external packages by **spawning or detecting** them, never by
 * shipping their bytes. Three integrations arrived at that shape independently
 * (Headroom, Ollama, Caveman) before it was written down; this file is the
 * written-down version, and it is data — one row per package, no behaviour.
 *
 * **Admission bar.** A package belongs here only if all four hold:
 *   1. it does something Golem should not reimplement;
 *   2. it has a stable, pinnable invocation contract;
 *   3. its absence degrades to a no-op, never an error path;
 *   4. Golem ships none of its bytes.
 *
 * The Caveman *speech skill* deliberately fails (1) — see its row.
 *
 * Pins are IMPORTED, never re-typed. `pins.js` is deliberately a narrow module
 * rather than the compression barrel, so this data file does not drag the CCR
 * store and sidecar adapter into its module graph.
 */

import { HEADROOM_SIDECAR_PYPI_PIN } from "../compression/pins.js";

/**
 * Where a package sits on the dependency ladder (Decision 53).
 *
 * `tier-1` is not represented here: those are Golem's own npm `dependencies`,
 * which are not managed packages. `unpdf` and `web-tree-sitter` are `tier-2`
 * because they are optional and absence-tolerant, even though npm may install
 * them for you.
 */
export type PkgTier =
  /** Spawned or resolved on demand at an exact pin; user provides it; off by default. */
  | "tier-2"
  /** A peer that acts on the same surface independently; Golem detects and defers. */
  | "tier-3a"
  /** Golem re-implemented the idea as its own data/code, citing the source, copying nothing. */
  | "tier-3b";

/** How Golem relates to the package — determines what "manage" can even mean. */
export type PkgShape =
  /** Golem invokes it (subprocess or HTTP service). Full wrap is possible. */
  | "callable"
  /** It acts on the same surface independently. Coordinate; never drive. */
  | "peer"
  /** It runs inside Golem's own process, inside the redaction path. */
  | "in-process";

/** How presence is detected — all spawn-free (see detect.ts). */
export type PkgDetect =
  /** An executable on `PATH` (Windows `PATHEXT`-aware). */
  | { readonly kind: "command"; readonly command: string }
  /** An optional npm module that must merely resolve. */
  | { readonly kind: "module"; readonly specifier: string }
  /**
   * A Claude Code plugin installed under the user's plugin cache
   * (`~/.claude/plugins/cache/<marketplace>/<name>/`). Used for plugins
   * that are installed via `claude plugin install` (e.g. Caveman) rather
   * than as standalone binaries on PATH.
   */
  | { readonly kind: "plugin"; readonly name: string; readonly marketplace?: string }
  /** Golem's own bundled data — always present by construction (tier-3b). */
  | { readonly kind: "bundled" };

/**
 * One step of an upstream installer, as an argument ARRAY — never a shell string
 * (CLAUDE.md). `command` is a bare name resolved through `commandOnPath`, so a
 * Windows `.cmd` shim is found and invoked correctly.
 */
export interface PkgInstallStep {
  readonly command: string;
  readonly args: readonly string[];
  /** Shown in the consent preview, so a human approves a REASON, not a command line. */
  readonly why: string;
  /**
   * Output substrings that mean "already done" rather than "failed". An
   * installer step has to be re-runnable, and "the marketplace already exists"
   * is success on a second run.
   */
  readonly tolerate?: readonly string[];
}

/** Who governs the version a row installs (R8.14). */
export type PkgPinPolicy =
  /** The `pin` in this manifest is the whole truth; `upgrade` re-converges on it. */
  | "manifest"
  /** Governed by an upgrade playbook (Headroom / T-C4). `upgrade` is REFUSED here. */
  | "playbook"
  /** The upstream installer exposes no version selector; it tracks its own ref. */
  | "upstream-unpinned";

/**
 * The write half of the registry (R8.14, Decision 53(e)): recipes that invoke
 * **the upstream's own installer**. Golem ships none of the tool's bytes, so
 * every step is a spawn of something the user already has (`claude`, `npm`).
 *
 * A row WITHOUT an `installer` has no automated path at all — its `install`
 * string stays the documented human route, and `golem pkg install` refuses and
 * quotes it. That is the default, not a gap.
 */
export interface PkgInstaller {
  /** Whose installer this is, named in the consent preview ("claude plugin", "npm"). */
  readonly upstream: string;
  readonly install: readonly PkgInstallStep[];
  readonly remove?: readonly PkgInstallStep[];
  /**
   * `"reinstall"` re-runs `install`, which converges on the manifest pin and
   * therefore *cannot* move it — that is how a `"manifest"`-pinned row satisfies
   * "upgrade must not move a pin outside its playbook". Explicit steps are for
   * rows the upstream versions itself (`upstream-unpinned`). Absent → the
   * upstream offers no upgrade contract and `upgrade` is refused.
   */
  readonly upgrade?: readonly PkgInstallStep[] | "reinstall";
  /** Anything a human should know BEFORE consenting. Surfaced in the preview. */
  readonly caveat?: string;
}

export interface PkgManifest {
  /** Stable id used by the CLI and the JSON output. */
  readonly id: string;
  /** Human title as its own project spells it. */
  readonly title: string;
  /** One line: what it does for Golem. */
  readonly what: string;
  readonly tier: PkgTier;
  readonly shape: PkgShape;
  /** Upstream home, so a row is traceable to a real project. */
  readonly upstream: string;
  /** Upstream licence, recorded because Golem redistributes nothing. */
  readonly licence: string;
  /** Exact version Golem targets, where it pins one. */
  readonly pin?: string;
  /** Who governs `pin`. Required wherever a pin exists (R8.14 drift guard). */
  readonly pinPolicy?: PkgPinPolicy;
  readonly detect: PkgDetect;
  /** Other registry ids that must also be present (e.g. Headroom needs uv). */
  readonly requires?: readonly string[];
  /**
   * How a human installs it. Golem never *runs* this string; an automated path,
   * where one exists, is `installer` — an argument array.
   */
  readonly install: string;
  /**
   * Argument-array recipes behind `golem pkg install|remove|upgrade` (R8.14).
   * Absent means "no automated path", never "install by some other route".
   */
  readonly installer?: PkgInstaller;
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
export const PKG_MANIFESTS: readonly PkgManifest[] = [
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
    pin: `headroom-ai==${HEADROOM_SIDECAR_PYPI_PIN}`,
    pinPolicy: "playbook",
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
    pin: `headroom-ai[memory]==${HEADROOM_SIDECAR_PYPI_PIN}`,
    pinPolicy: "playbook",
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
    enabledBy: "inference.default_target",
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
    pin: "1.6.2",
    pinPolicy: "manifest",
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
    what:
      "Syntax-aware code chunking (WASM grammars) instead of the heuristic chunker, and " +
      "the symbol extraction behind the R8.5 repo map (`code` tool) and the oversized-Read skeleton.",
    tier: "tier-2",
    shape: "in-process",
    upstream: "https://github.com/tree-sitter/tree-sitter",
    licence: "MIT",
    detect: { kind: "module", specifier: "web-tree-sitter" },
    install:
      "npm install web-tree-sitter plus the grammar packages you want (devDependencies here; never shipped).",
    // Two independent consumers, two flags. `enabledBy` names the default-ON one
    // (R8.5's map), because reporting `[off]` while the map is happily parsing with
    // it would be exactly the kind of "claims a state it isn't in" this surface
    // exists to avoid; the chunker's own opt-in is called out in `gate`.
    enabledBy: "knowledge.repo_map_enabled",
    adapter: "src/knowledge/tree-sitter-chunker.ts",
    degrade:
      "Chunking falls back to the heuristic `chunkFile`, which is always available; the " +
      "`code` tool reports no map, and a swapped Read keeps its plain head/tail digest.",
    gate:
      "Used by two features with separate switches: the R8.5 repo map / oversized-Read " +
      "skeleton (`knowledge.repo_map_enabled`, `knowledge.read_skeleton_enabled` — both " +
      "default ON, shown here) and R3.3 syntax-aware chunking " +
      "(`knowledge.syntax_aware_chunking`, default off). Either can be on without the other.",
  },
  {
    id: "typescript-language-server",
    title: "typescript-language-server",
    what:
      "Answers the R8.6 `code` tool's LSP modes — diagnostics / definition / references / hover — " +
      "so an agent stops grepping to find out what refers to what.",
    tier: "tier-2",
    shape: "callable",
    upstream: "https://github.com/typescript-language-server/typescript-language-server",
    licence: "Apache-2.0",
    pin: "typescript-language-server@6.0.0",
    pinPolicy: "manifest",
    detect: { kind: "command", command: "typescript-language-server" },
    install:
      "`golem pkg install typescript-language-server` — or by hand: " +
      "`npm i -g typescript-language-server@6.0.0 typescript@5.9.3`. Golem spawns the server, " +
      "and (R8.14) can ask npm to fetch it; it never carries its bytes. " +
      "Any other server (gopls, rust-analyzer, pyright) is a `knowledge.lsp_servers` row, not a release.",
    installer: {
      upstream: "npm (global prefix)",
      install: [
        {
          command: "npm",
          args: ["install", "--global", "typescript-language-server@6.0.0", "typescript@5.9.3"],
          why:
            "npm fetches the language server and the TypeScript it needs to answer, both at the " +
            "exact versions recorded here.",
        },
      ],
      remove: [
        {
          command: "npm",
          args: ["uninstall", "--global", "typescript-language-server"],
          why:
            "Removes the server only. `typescript` stays: other tools on this machine use it, " +
            "and uninstalling a shared toolchain package is not this command's business.",
          tolerate: ["up to date", "removed 0 packages"],
        },
      ],
      // Re-run install: it converges on the pin above and can never move past
      // it. Moving the pin is an edit to this file plus review, not a CLI act.
      upgrade: "reinstall",
      caveat:
        "A global npm install writes to a prefix other projects share, and needs whatever rights " +
        "your npm prefix needs.",
    },
    enabledBy: "knowledge.lsp_enabled",
    adapter: "src/pkg/lsp/",
    degrade:
      "The `code` tool's LSP modes report `available: false` with the reason and the session " +
      "continues; `map` mode is unaffected.",
    gate:
      "Enabled does NOT mean running. The server is spawned lazily on the first LSP-mode call, " +
      "pooled, and evicted after an idle period — so `golem pkg status` can say [on] while no " +
      "process exists. It is also per-file-type: a row only answers for the extensions it claims.",
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
    pinPolicy: "upstream-unpinned",
    detect: { kind: "plugin", name: "caveman", marketplace: "caveman" },
    install:
      "`golem pkg install caveman` — or manually: `claude plugin marketplace add JuliusBrussee/caveman && claude plugin install caveman@caveman`.",
    installer: {
      upstream: "claude plugin",
      install: [
        {
          command: "claude",
          args: ["plugin", "marketplace", "add", "JuliusBrussee/caveman"],
          why: "Registers the upstream's own marketplace with Claude Code. Nothing is copied into Golem.",
          tolerate: ["already exists", "already added"],
        },
        {
          command: "claude",
          args: ["plugin", "install", "caveman@caveman", "--yes"],
          why: "Claude Code's own plugin installer fetches the skill from that marketplace.",
          tolerate: ["already installed"],
        },
      ],
      remove: [
        {
          command: "claude",
          args: ["plugin", "uninstall", "caveman@caveman", "--yes"],
          why: "Claude Code's own uninstaller. The marketplace registration is left in place.",
          tolerate: ["not installed", "not found"],
        },
      ],
      // Explicit steps rather than "reinstall": `claude plugin install` has no
      // version selector (verification-notes §133), so there is no pin here to
      // protect — the upstream tracks its own ref and `update` is its contract.
      upgrade: [
        {
          command: "claude",
          args: ["plugin", "update", "caveman@caveman", "--yes"],
          why: "Moves the plugin to whatever the marketplace ref now points at.",
        },
      ],
      caveat:
        "This row deliberately fails admission criterion 1 (see `gate`): Golem's own brevity dial " +
        "already covers it, from the proxy, for every client. Installing it is supported because " +
        "the two must not stack silently — not because Golem recommends it. Restart Claude Code " +
        "afterwards for the skill to load.",
    },
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
export function pkgManifest(id: string): PkgManifest | undefined {
  return PKG_MANIFESTS.find((m) => m.id === id);
}
