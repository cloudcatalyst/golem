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
import { classifyManaged, ownedDetail, rememberManaged } from "../cli/managed-files.js";
import { loadConfig } from "../config/index.js";

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
  "   can find it later. Author wiki pages freely — no prior approval needed",
  "   (spec Decision 44); every write is committed to git, so it's reviewable",
  "   and revertible. Redaction-before-storage still applies, and contradictions",
  "   are surfaced to the human, never auto-resolved.",
].join("\n");

const LOCAL_ANSWER = [
  "## Golem: the proxy may answer simple questions locally (spec Decision 33)",
  "",
  "When `knowledge.local_answer_enabled` is on (the default), Golem's proxy can",
  "answer a single-turn, retrieval-shaped question directly from the project",
  "knowledge base — **extractive prose quoted from the wiki/spec/docs, never",
  "generated** — without calling the model. Such replies carry the visible prefix",
  '"**Golem** Answered locally from the project knowledge base — verify',
  'independently."; treat them like any cited source and verify. It is',
  "single-turn only (never mid-conversation, never on tool-use turns) and",
  "confidence-gated, so it declines rather than guess.",
  "",
  "The lever you DO control is coverage: a topic with no durable wiki/spec page",
  "declines and the request reaches the model normally. So a good local answer is",
  "made by writing a good page — keep the wiki current (see the wiki-first rule).",
  "This is a proxy behaviour, not something you invoke; set",
  "`knowledge.local_answer_enabled` false to turn it off.",
].join("\n");

const LOCAL_CODER = [
  "## Golem: draft code with the `coder` tool first",
  "",
  "Before writing non-trivial code, draft it with the `coder` MCP tool, then",
  "review and refine that draft rather than writing from scratch. Do this",
  "proactively; you don't need to be asked.",
  "",
  "**Why depends on where `coder` is pointed, and both are legitimate.** With no",
  "worker target it runs on this machine's local model, so drafting costs nothing",
  "and spends none of the paid model's budget. With a target configured",
  "(`inference.worker_targets`) it runs on that target — possibly a vendor model",
  "you pay for — and the reason becomes division of labour rather than thrift:",
  "the draft is generated once, and your tokens go on review, integration, and",
  "the judgment the draft cannot make. `golem status` names the model each worker",
  "will actually reach; check it rather than assuming.",
  "",
  "**What counts as non-trivial (draft it):** any new function, class, or module,",
  "or a change adding more than a few lines of logic (rule of thumb: ≳240 chars of",
  "new code in a `.ts`/`.js`/etc. file). **Skip `coder` for:** one-line edits,",
  "renames, config/JSON/Markdown, type-only `.d.ts` changes, and mechanical fixes",
  "(lint/format) — the round trip won't pay off. When in doubt, draft it.",
  "",
  "**Self-check:** before a substantial code Write/Edit, if you did NOT draft it",
  "with `coder`, either do so now or state why you're skipping (too small, or the",
  "tool is unavailable — `golem status` shows whether it is on and what it would",
  "reach). Don't skip silently.",
  "",
  "`coder` is engaged only by explicit acts — the tool itself, and the optional",
  "`golem task run` / `golem prompt translate` (see `golem guidance`). The slider",
  "is a compression dial only and never auto-engages a model (Decision 31). Use",
  "`coder` at every level.",
  "",
  "This project ENFORCES the practice while this rule is active AND",
  "`inference.coder_enabled` is true (the default): the PreToolUse gate",
  "denies the first non-trivial hand-written code Write/Edit of a session and",
  "redirects you here (a one-shot reminder — if you already drafted with `coder`,",
  "say so and proceed). Disable the guidance with `golem guidance disable local-coder`;",
  "disable the tool itself with `golem coder disable`. `golem coder status` shows",
  "whether it is on and which target each worker uses; `golem local url <url>`",
  "points the LOCAL backend at a LAN machine, which matters only for a worker with",
  "no target of its own.",
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

const SNOOZE_HOLD = [
  "## Golem: park at the usage limit instead of losing work (snooze)",
  "",
  "When you're approaching — or have just hit — a usage/session limit, don't just",
  "stop and lose your place. Park the session so it resumes itself once the limit",
  "resets (spec proposal golem-snooze.md):",
  "",
  "1. **Park and document in ONE call.** Call the `snooze` MCP tool with `until` set",
  "   to the window's reset time (Golem reads it from the rate-limit headers) AND",
  '   `note="<where you\'re up to + next steps>"`. The note is filed as a durable',
  "   local task *before* the wait — the same thing `golem task add` writes — so your",
  "   place survives even if the session ends before the reset. The call parks the",
  "   session; no model tokens are spent while it waits.",
  "2. **Then STOP and wait.** Do not keep working. When snooze completes at the",
  "   reset, its completion notification resumes this conversation in-place with",
  "   your context intact — pick up from the noted task.",
  "",
  "Do NOT try to run `golem task add` first. Enforcement denies every non-`snooze`",
  "tool call, `Bash` included, so a separate documenting step cannot run — that is",
  "why `note` exists on the tool.",
  "",
  "Golem's proxy watches the session-window utilization; as it fills, the PreToolUse",
  "gate redirects you here. **By default this is enforcing** (spec Decision 45):",
  "every non-`snooze` tool call is denied until you park, so the only way forward is",
  "to call the `snooze` tool — don't fight it, park. Set `snooze.enforce` false (env",
  "`GOLEM_SNOOZE_ENFORCE=false`) for the advisory mode (a single one-shot nudge per",
  "window). If the rate-limit feed goes cold (e.g. an account whose responses don't",
  "carry the limit headers), Golem warns once that the auto-park is blind rather than",
  "failing silently — watch Claude Code's own limit indicator and park manually.",
  "Check `golem status` (the Limits line shows utilization, freshness, and",
  "`park advisory|enforced`).",
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
    name: "local-answer",
    summary: "Explain that the proxy may answer simple questions locally; keep the wiki current",
    seededByDefault: true,
    snippet: LOCAL_ANSWER,
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
  {
    name: "snooze-hold",
    summary: "Park at the usage limit (document → snooze → resume in-place) instead of losing work",
    seededByDefault: true,
    snippet: SNOOZE_HOLD,
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

/**
 * Whether a feature's rule file exists in ONE specific scope — the literal
 * on-disk fact, with no other conditions folded in.
 *
 * Use this (not {@link guidanceEnabled}) when reporting state to a user: a
 * settings UI must show which scope a rule is enabled at, and must not report
 * `local-coder` as "off" merely because `inference.coder_enabled` is false
 * — that is a separate toggle with its own row.
 */
export async function guidanceRuleExists(
  projectDir: string,
  name: string,
  scope: GuidanceScope,
): Promise<boolean> {
  try {
    await readFile(guidanceRulePath(projectDir, name, scope), "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a guidance feature is active for a project — i.e. its rule file is
 * present in either scope (presence *is* the toggle; `golem guidance
 * enable/disable` add/remove it). Used to gate enforcement on "if guided".
 *
 * For the `local-coder` feature, the rule file is necessary but not sufficient:
 * the `inference.coder_enabled` setting must also be true. When the local
 * coder is disabled via `golem config set inference.coder_enabled false`,
 * the guidance text is still present but enforcement is bypassed (the agent is
 * not told to draft with a tool that is not enabled).
 */
export async function guidanceEnabled(projectDir: string, name: string): Promise<boolean> {
  for (const scope of ["project", "user"] as const) {
    try {
      await readFile(guidanceRulePath(projectDir, name, scope), "utf8");
      if (name === "local-coder" && !(await localCoderEnabled(projectDir))) {
        return false;
      }
      return true;
    } catch {
      // not present in this scope
    }
  }
  return false;
}

/** Read the effective `inference.coder_enabled` setting; fail-open true. */
async function localCoderEnabled(projectDir: string): Promise<boolean> {
  try {
    const { settings } = await loadConfig({ projectDir });
    return settings.inference.coder_enabled;
  } catch {
    return true;
  }
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
  // R9.5: an edited rule is the user's. Golem reports that it has newer text
  // and leaves the file alone rather than overwriting their words.
  const disposition = await classifyManaged(projectDir, file, body, existing);
  if (disposition === "owned") {
    return {
      kind: "conflict",
      path: rel(projectDir, file),
      detail: ownedDetail(`${scope} guidance: ${feature.name}`),
    };
  }
  if (!dryRun) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body, "utf8");
    await rememberManaged(projectDir, file, body);
  }
  return {
    kind: existing === null ? "create" : "modify",
    path: rel(projectDir, file),
    detail:
      existing === null
        ? `${scope} guidance: ${feature.name}`
        : `${scope} guidance: ${feature.name} — refreshed (unmodified since Golem wrote it)`,
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
  const seeded = await alreadySeeded(projectDir);
  const actions: InitAction[] = [];
  for (const f of GUIDANCE_FEATURES.filter((g) => g.seededByDefault)) {
    // R9.5: the sentinel keeps its real job — a rule the user turned off with
    // `golem guidance disable` (i.e. deleted) is NOT re-created on a later init.
    // But "don't undo the user's choice" and "never refresh the text" used to be
    // the same mechanism, and only the first was ever intended. So once seeded,
    // a rule that is still PRESENT is refreshed (when unmodified) and one that is
    // ABSENT is left absent.
    if (seeded && !(await guidanceRuleExists(projectDir, f.name, "project"))) {
      actions.push({
        kind: "skip",
        path: rel(projectDir, guidanceRulePath(projectDir, f.name, "project")),
        detail: `${f.name} is disabled — not re-seeded`,
      });
      continue;
    }
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
