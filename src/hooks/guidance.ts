/**
 * Golem guidance as Claude Code project rules (reworked 2026-07-16, user
 * decision — supersedes the old CLAUDE.md marker-section approach).
 *
 * Each working practice is a named guidance feature written to a Claude Code
 * rules file — `.claude/rules/golem-<name>.md` (committed, project/team) or
 * `.claude/rules/golem-<name>.local.md` (gitignored, personal). Claude Code
 * auto-loads `.claude/rules/*.md` every session, so Golem never edits the user's
 * CLAUDE.md at all. Presence of a rule file is the toggle; `golem guidance
 * enable/disable` add and remove them.
 *
 * `golem init` SEEDS the default features once (guarded by a sentinel), then
 * leaves the rules user-owned — disabling a default sticks across re-inits.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InitAction } from "../cli/init.js";

/** Committed project scope vs gitignored personal scope for a rule file. */
export type GuidanceScope = "project" | "user";

const RULES_SUBDIR = path.join(".claude", "rules");
/** Gitignore pattern that keeps personal (`--user`) golem rules out of git. */
export const PERSONAL_RULES_GITIGNORE = ".claude/rules/golem-*.local.md";
/** Managed-file banner (HTML comment: stripped from context, visible in-editor). */
const MANAGED_BANNER = (name: string) =>
  `<!-- Managed by Golem — remove with \`golem guidance disable ${name}\` -->`;

const CCR_REFS = [
  "## Golem: oversized tool outputs are swapped for CCR refs",
  "",
  "A PostToolUse hook replaces oversized tool outputs (Bash, Read, Grep, Glob,",
  "WebFetch) with a compact digest: head/tail excerpts, byte/line counts, and a",
  "lossless reference marker like `Retrieve original: hash=<64-hex-id>`. The full",
  "original is stored locally under `.golem/ccr` — nothing is lost.",
  "",
  "When the excerpt is not enough, expand the reference:",
  "",
  "- call the `expand` MCP tool with `ref_id` set to the hex id, or",
  "- use `/golem/expand <id>` (or `/mcp__golem__expand <id>`).",
  "",
  "Expand only when needed — the full original re-enters context and costs the",
  "tokens the swap saved. Prefer re-running a narrower command (grep the file,",
  "limit the range) when you only need a small part.",
].join("\n");

const WIKI_KB_FIRST = [
  "## Golem: wiki-first knowledge (spec Decision 28)",
  "",
  "Apply this proactively — you do not need the user to ask. This project keeps a",
  "durable, committed wiki (default `docs/wiki/` — see its `WIKI.md` for the exact",
  "zones and write rules; the configured location may differ, check",
  "`knowledge.wiki_dir` if unsure). Wiki pages are the source of truth; Golem's",
  "local vector index — which also covers ingested source trees, this project's",
  "other `.md` docs, and every page fetched with WebFetch — is just a derived,",
  "rebuildable cache over them.",
  "",
  "At the start of a session, skim the wiki's own `WIKI.md` Index once — it's",
  "cheap and tells you what's already known before you duplicate a search. Then",
  "follow this ladder before reaching outside the project:",
  "",
  "1. **Check the wiki first.** Look for an existing page on the topic (start",
  "   from the wiki's `WIKI.md` index).",
  "2. **No page? Search next.** Call the `search` MCP tool (or `/golem/research`)",
  "   with your query — it tries an exact wiki-title / one-hop-wikilink match",
  "   before vector search, and wiki pages rank above other hits; use `fetch`",
  "   for a hit's full text.",
  "3. **Still nothing? Then WebFetch or external docs.** A previously-fetched",
  "   URL is served from the cache automatically (the fetch is skipped and the",
  "   cached content is returned), so re-fetching the same page is free and",
  "   offline — the same goes for files brought in with the `ingest` tool and",
  "   ideas captured with `golem note`.",
  "4. **Learned something worth keeping?** A raw capture (a fetched page, an",
  "   ingested file, a captured note) is searchable but disconnected — it has",
  "   no place in the graph until it's a wiki page. Propose adding or updating",
  "   a page rather than letting the capture evaporate or sit as an orphaned",
  "   chunk; cite the raw source and add real `[[wikilinks]]` to every related",
  "   page it belongs with, so graph traversal (not just similarity search)",
  "   can find it later. Wiki writes are plan-gated (propose, get approval,",
  "   then write).",
].join("\n");

const LOCAL_CODER = [
  "## Golem: prefer the local model for coding drafts",
  "",
  "By default, before writing non-trivial code, draft it with the `coder` MCP",
  "tool first — a local model — then review and refine the result yourself",
  "rather than writing from scratch. Do this proactively; you don't need to be",
  "asked. It leaves the paid model's tokens for the judgment calls the local",
  "model can't make: review, integration, and anything genuinely hard. The",
  "local model is engaged only by explicit acts — `coder` (drafting) and the",
  "optional `golem task run` / `golem prompt translate` (see `golem guidance`);",
  "the slider is a compression dial only and never auto-engages the model",
  "(Decision 31). Use `coder` at every level; skip it only when the task is too",
  "small for the round trip to pay off.",
].join("\n");

const PROMPT_TRANSLATION = [
  "## Golem: sharpen rough prompts with the local model",
  "",
  "When the user's instruction is terse or rough and a clearer prompt would",
  'help, run `golem prompt translate "<their note>"` and work from the clearer',
  "prompt it returns — a local model rewrites it, grounded in prompts the user",
  "has accepted before. ALWAYS show the suggestion first and NEVER silently rewrite",
  "the user's intent; if they like it they can `golem prompt accept` to teach the",
  "style.",
].join("\n");

const DURABLE_TASKS = [
  "## Golem: use durable tasks for interruptible work",
  "",
  "For work that may outlast a session or hit a credit limit, capture it as a",
  'durable task with `golem task add "<prompt>"` rather than holding it only in',
  "context — it survives restarts and can auto-resume. Service queued tasks",
  "locally with `golem task run` (a local model handles triage/drafts); when a",
  "task genuinely needs cloud quality, hand it up explicitly with",
  "`golem task escalate <id>` (never escalate silently). Inspect with",
  "`golem task list` / `golem task show <id>`.",
].join("\n");

/**
 * One named guidance practice. `seededByDefault` features are written to
 * `.claude/rules/` by `golem init`; the rest are opt-in via `golem guidance`.
 */
export interface GuidanceFeature {
  readonly name: string;
  readonly summary: string;
  readonly seededByDefault: boolean;
  readonly snippet: string;
}

export const GUIDANCE_FEATURES: readonly GuidanceFeature[] = [
  {
    name: "ccr-refs",
    summary: "Explain the oversized-output → CCR-ref swap and how to expand refs",
    seededByDefault: true,
    snippet: CCR_REFS,
  },
  {
    name: "wiki-kb-first",
    summary: "Check the wiki + local KB before searching the web (Decision 28 ladder)",
    seededByDefault: true,
    snippet: WIKI_KB_FIRST,
  },
  {
    name: "local-coder",
    summary: "Draft non-trivial code with the local `coder` model first",
    seededByDefault: true,
    snippet: LOCAL_CODER,
  },
  {
    name: "prompt-translation",
    summary: "Have Claude sharpen rough prompts via the local model before working",
    seededByDefault: false,
    snippet: PROMPT_TRANSLATION,
  },
  {
    name: "durable-tasks",
    summary: "Have Claude queue interruptible work as durable tasks + service/escalate",
    seededByDefault: false,
    snippet: DURABLE_TASKS,
  },
];

/** Look up a guidance feature by name, or null. */
export function guidanceFeature(name: string): GuidanceFeature | null {
  return GUIDANCE_FEATURES.find((g) => g.name === name) ?? null;
}

/** Back-compat: the prompt-translation snippet body. */
export function promptTranslationGuidanceSnippet(): string {
  return guidanceFeature("prompt-translation")?.snippet ?? "";
}

/** Path to a feature's rule file for the given scope. */
export function guidanceRulePath(projectDir: string, name: string, scope: GuidanceScope): string {
  const suffix = scope === "user" ? ".local.md" : ".md";
  return path.join(projectDir, RULES_SUBDIR, `golem-${name}${suffix}`);
}

/** The full rule-file body (managed banner + the feature snippet). */
export function guidanceRuleBody(feature: GuidanceFeature): string {
  return `${MANAGED_BANNER(feature.name)}\n\n${feature.snippet}\n`;
}

const rel = (projectDir: string, abs: string): string =>
  path.relative(projectDir, abs).split(path.sep).join("/");

/** Write a feature's rule file (idempotent: skip when already identical). */
export async function writeGuidanceRule(
  projectDir: string,
  feature: GuidanceFeature,
  scope: GuidanceScope,
  dryRun = false,
): Promise<InitAction> {
  const file = guidanceRulePath(projectDir, feature.name, scope);
  const body = guidanceRuleBody(feature);
  let existing: string | null = null;
  try {
    existing = await readFile(file, "utf8");
  } catch {
    existing = null;
  }
  if (existing === body) {
    return {
      kind: "skip",
      path: rel(projectDir, file),
      detail: `${feature.name} rule already present`,
    };
  }
  if (!dryRun) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body, "utf8");
  }
  return {
    kind: existing === null ? "create" : "modify",
    path: rel(projectDir, file),
    detail: `${scope} guidance: ${feature.name}`,
  };
}

/** Remove a feature's rule file (both scopes if `scope` omitted). No-op if absent. */
export async function removeGuidanceRule(
  projectDir: string,
  name: string,
  scope: GuidanceScope | "both" = "both",
  dryRun = false,
): Promise<InitAction> {
  const scopes: GuidanceScope[] = scope === "both" ? ["project", "user"] : [scope];
  const removed: string[] = [];
  for (const s of scopes) {
    const file = guidanceRulePath(projectDir, name, s);
    try {
      await readFile(file, "utf8");
      if (!dryRun) await rm(file, { force: true });
      removed.push(rel(projectDir, file));
    } catch {
      // not present in this scope
    }
  }
  if (removed.length === 0) {
    return {
      kind: "skip",
      path: rel(projectDir, guidanceRulePath(projectDir, name, "project")),
      detail: `${name} rule not present`,
    };
  }
  return { kind: "remove", path: removed.join(", "), detail: `removed guidance: ${name}` };
}

// --- seed-once sentinel (so disabling a default sticks across re-inits) ---

function guidanceStatePath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "guidance.json");
}

async function alreadySeeded(projectDir: string): Promise<boolean> {
  try {
    const j = JSON.parse(await readFile(guidanceStatePath(projectDir), "utf8")) as {
      seeded?: unknown;
    };
    return j.seeded === true;
  } catch {
    return false;
  }
}

/**
 * Seed the default guidance rule files, ONCE. On first init this writes the
 * `seededByDefault` features and records a sentinel; on later inits it is a
 * no-op, so a user's `golem guidance disable` of a default is never undone.
 */
export async function seedDefaultGuidance(
  projectDir: string,
  dryRun = false,
): Promise<InitAction[]> {
  if (await alreadySeeded(projectDir)) {
    return [
      { kind: "skip", path: ".claude/rules/", detail: "guidance already seeded (user-owned)" },
    ];
  }
  const actions: InitAction[] = [];
  for (const f of GUIDANCE_FEATURES.filter((g) => g.seededByDefault)) {
    actions.push(await writeGuidanceRule(projectDir, f, "project", dryRun));
  }
  if (!dryRun) {
    const state = guidanceStatePath(projectDir);
    await mkdir(path.dirname(state), { recursive: true });
    await writeFile(state, `${JSON.stringify({ seeded: true }, null, 2)}\n`, "utf8");
  }
  return actions;
}

/** Remove every Golem guidance rule (both scopes) + the seed sentinel (uninit). */
export async function removeAllGuidanceRules(
  projectDir: string,
  dryRun = false,
): Promise<InitAction[]> {
  const actions: InitAction[] = [];
  for (const f of GUIDANCE_FEATURES) {
    const action = await removeGuidanceRule(projectDir, f.name, "both", dryRun);
    if (action.kind !== "skip") actions.push(action);
  }
  try {
    await readFile(guidanceStatePath(projectDir), "utf8");
    if (!dryRun) await rm(guidanceStatePath(projectDir), { force: true });
  } catch {
    // no sentinel
  }
  return actions;
}
