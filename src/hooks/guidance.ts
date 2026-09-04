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

/** Committed project scope vs gitignored personal scope for a rule file. */
export type GuidanceScope = "project" | "user";

const RULES_SUBDIR = path.join(".claude", "rules");
/** Gitignore pattern that keeps personal (`--user`) golem rules out of git. */
export const PERSONAL_RULES_GITIGNORE = ".claude/rules/golem-*.local.md";
/** Managed-file banner (HTML comment: stripped from context, visible in-editor). */
const MANAGED_BANNER = (name: string) =>
  `<!-- Managed by Golem — remove with \`golem guidance disable ${name}\` -->`;

const CCR_REFS = [
  "## Golem: oversized tool outputs → CCR refs",
  "",
  "A PostToolUse hook replaces oversized tool output (Bash, Read, Grep, Glob,",
  "WebFetch) with head/tail excerpts + `hash=<64-hex>`. The full original is stored",
  "under `.golem/ccr` — nothing is lost.",
  "",
  "Expand via the `expand` MCP tool (`ref_id` = the hex id), `/golem-expand <id>`,",
  "or `/mcp__golem__expand <id>`. Only when the excerpt is genuinely not enough —",
  "the original re-enters context and costs back the tokens the swap saved. Prefer",
  "a narrower re-read or grep first.",
].join("\n");

const WIKI_KB_FIRST = [
  "## Golem: wiki-first (spec Decision 28)",
  "",
  "Apply proactively; no need to be asked. The committed wiki (`docs/wiki/` by",
  "default — `knowledge.wiki_dir` if it was moved) is the truth. The vector index —",
  "which also covers ingested trees, other `.md` docs and every WebFetch — is a",
  "derived cache over it. Skim `WIKI.md`'s Index once per session before searching.",
  "",
  "1. **Check the wiki first** — start from `WIKI.md`",
  "2. **No page?** → `search` MCP tool or `/golem-research` (exact wiki-title /",
  "   one-hop-wikilink match before vector; `fetch` for a hit's full text)",
  "3. **Still nothing?** Then WebFetch or external docs. An already-fetched URL is",
  "   served from cache — free and offline, as are `ingest` files and `golem note`",
  "4. **Keep what you find?** A raw capture is searchable but disconnected. Author",
  "   a wiki page with real `[[wikilinks]]` to related pages, citing the source, so",
  "   graph traversal finds it later. No prior approval needed (Decision 44) — git",
  "   makes every write reviewable. ADRs go in `docs/decisions/`, not the wiki.",
  "",
  "Redaction-before-storage still applies, and contradictions are surfaced to the",
  "human, never auto-resolved.",
].join("\n");

const LOCAL_ANSWER = [
  "## Golem: the proxy may answer simple questions locally (Decision 33)",
  "",
  "With `knowledge.local_answer_enabled` on (default), the proxy can answer a",
  "retrieval-shaped question from the project KB without calling the model —",
  "**extractive prose quoted from the wiki/spec/docs, never generated**. Replies",
  'carry the visible prefix "**Golem** Answered locally from the project knowledge',
  'base — verify independently."; treat them like any cited source. Single-turn',
  "only (never mid-conversation, never on tool-use turns) and confidence-gated, so",
  "it declines rather than guess.",
  "",
  "Coverage is the lever you control: a topic with no durable wiki/spec page",
  "declines and reaches the model normally — so a good local answer is made by",
  "writing a good page: keep the wiki current (see the wiki-first rule). A proxy",
  "behaviour, not something you invoke; set `knowledge.local_answer_enabled` false",
  "to turn it off.",
].join("\n");

const LOCAL_CODER = [
  "## Golem: draft code with the `coder` tool first",
  "",
  "Before writing non-trivial code, draft it with the `coder` MCP tool and refine",
  "that draft rather than writing from scratch. Proactively; no need to be asked.",
  "",
  "**Why, either way it is pointed.** With no worker target it runs on this",
  "machine's local model — drafting costs nothing. With `inference.worker_targets`",
  "set it runs on that target, possibly a paid vendor model, and the reason becomes",
  "division of labour: the draft is generated once and your tokens go on review,",
  "integration and the judgment it cannot make. `golem status` names the model each",
  "worker actually reaches — check rather than assume.",
  "",
  "**Non-trivial (draft it):** a new function, class or module, or more than a few",
  "lines of logic (≳240 chars of new code in `.ts`/`.js`/etc.). **Skip:** one-line",
  "edits, renames, config/JSON/Markdown, type-only `.d.ts`, lint/format fixes — the",
  "round trip won't pay off. In doubt, draft it.",
  "",
  "**Self-check:** before a substantial code Write/Edit you did NOT draft, either",
  "draft it now or say why you're skipping (too small, or the tool is unavailable —",
  "`golem status` shows what it would reach). Never skip silently.",
  "",
  "`coder` is engaged only by explicit acts — the tool, plus the optional `golem",
  "task run` / `golem prompt translate`. The slider is a compression dial and never",
  "auto-engages a model (Decision 31); use `coder` at every level.",
  "",
  "This project ENFORCES the practice while this rule is active: the PreToolUse",
  "gate denies the session's first non-trivial hand-written code Write/Edit and",
  "redirects here — one-shot, so if you already drafted, say so and proceed.",
  "`golem guidance disable coder-first` drops the guidance; `golem coder disable`",
  "the tool; `golem coder status` shows state and per-worker targets; `golem local",
  "url <url>` points the LOCAL backend at a LAN machine (only matters for a worker",
  "with no target of its own).",
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
  "## Golem: park at the usage limit (snooze)",
  "",
  "At or near a usage/session limit, park instead of stopping and losing your",
  "place. Call the `snooze` MCP tool with `until` (the window's reset time, which",
  "Golem reads from the rate-limit headers) AND `note=\"<where you're up to + next",
  'steps>"` — ONE call. The note is filed as a durable local task *before* the',
  "wait, so your place survives even if the session ends; no tokens are spent",
  "waiting. Then STOP. At the reset, snooze's completion resumes this conversation",
  "in-place — pick up from the noted task.",
  "",
  "Do NOT try `golem task add` first: enforcement denies almost every non-`snooze`",
  "call, `Bash` included, which is why `note` exists on the tool. `ToolSearch` and",
  "`expand` are the exceptions — `snooze` is a deferred tool, and denying the",
  "schema lookup made the one allowed call impossible (R9.23). Use them for that,",
  "nothing else.",
  "",
  "**Enforcing by default** (Decision 45): every other call is denied until you",
  "park — don't fight it. `snooze.enforce` false (or `GOLEM_SNOOZE_ENFORCE=false`)",
  "makes it advisory: one nudge per window. If the rate-limit feed goes cold (an",
  "account whose responses carry no limit headers), Golem warns once that the",
  "auto-park is **blind** rather than failing silently — watch Claude Code's own",
  "limit indicator and park manually. `golem status` shows utilization, freshness",
  "and `park advisory|enforced`.",
].join("\n");

const SUBAGENT_HEADROOM = [
  "## Golem: a subagent cannot park — spend the window before you spend the agent",
  "",
  "The usage-limit park is a **tool-call gate**. A subagent never reaches it: the",
  "limit is hit on a *model request*, so a child's turn fails upstream (`Agent",
  "terminated early due to an API error: You have hit your session limit`) before",
  "it can propose a call to be denied. It gets no turn, writes no note, and takes",
  "any uncommitted work with it. Observed 2026-08-22: two of three dispatched",
  'agents died exactly that way, one word after "All green. Committing."',
  "",
  "So the decision moves to the one part the parent *does* control:",
  "",
  "1. **The spawn is gated on headroom.** Golem refuses a spawn when the session",
  "   window cannot pay for it — a subagent has historically cost ~15–20% of a",
  "   window (~171k–186k tokens over 85–94 tool calls). The refusal states what it",
  "   measured; read the numbers rather than retrying. Do the work inline, or park",
  "   with `snooze` and spawn after the reset. `snooze.spawn_gate` false (env",
  "   `GOLEM_SNOOZE_SPAWN_GATE=false`) turns it off; `snooze.spawn_cost_fraction`",
  "   tunes the estimate. `golem status`'s Limits line says whether spawns are",
  "   `allowed`, `REFUSED` or `ungated`.",
  "2. **Tell every dispatched agent to commit early.** The survivors survived",
  "   *because* they had already committed. Put it in the prompt: commit working",
  "   increments on your own branch as you go. That is commit early, not merge",
  '   early — "one workstream per PR" still holds.',
  "3. **When a child dies, capture its place.** A death is reported in the task",
  "   notification. Turn that into a durable task naming what the child was doing",
  "   and where it got to. The record survives even though the process does not —",
  "   that is the honest version of resuming.",
  "",
  "A missing or stale rate-limit reading makes the gate **blind**: it warns once",
  "and lets a re-issued spawn through rather than assuming headroom. Treat that",
  "warning as the signal to check Claude Code's own limit indicator yourself.",
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

const LONG_RUN_VISIBILITY = [
  "## Golem: a long run must SHOW that it is running",
  "",
  "The harness shows a working indicator only while a turn is active. A detached",
  "background command is not the turn, so a multi-minute run leaves the session",
  "looking idle — the user cannot tell the difference between working and hung.",
  "",
  "1. **Use `golem verify` for the green-check gate** rather than hand-rolling a",
  "   shell loop. It prints its log path FIRST, emits one `golem-verify:` line per",
  "   check, builds the repo under test before checks that read `dist/`, and is",
  "   judged by exit code. A hand-rolled runner is how a log landed in the repo",
  "   root and how a generated file got rebuilt by a stale global install.",
  "2. **Stream anything over ~30s** — but watch for FAILURES and the final",
  "   verdict, not for every step. A notification per check costs a turn each",
  "   and buries the result; the status line already carries per-step progress",
  "   at 2s resolution for free. Filter to the lines you would act on.",
  "3. **Name the log path** in your own message, so the user can follow along",
  "   without asking you.",
  "",
  "While a `golem verify` run is in flight, `golem statusline` shows it live —",
  "the status line re-runs on a 2s timer, so it ticks even when the session is",
  "idle. That is the only surface that does.",
].join(String.fromCharCode(10));
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
    name: "coder-first",
    summary: "Draft non-trivial code with the `coder` tool first",
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
  {
    name: "long-run-visibility",
    summary: "Stream long runs (golem verify) instead of leaving a silent multi-minute gap",
    seededByDefault: true,
    snippet: LONG_RUN_VISIBILITY,
  },
  {
    name: "subagent-headroom",
    summary:
      "Explain why the park cannot reach a subagent: gate the spawn, commit early, capture deaths",
    seededByDefault: true,
    snippet: SUBAGENT_HEADROOM,
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
 * `coder-first` as "off" merely because the `coder` tool is not currently
 * routable — that is a separate condition with its own row.
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
 */
export async function guidanceEnabled(projectDir: string, name: string): Promise<boolean> {
  for (const scope of ["project", "user"] as const) {
    try {
      await readFile(guidanceRulePath(projectDir, name, scope), "utf8");
      return true;
    } catch {
      // not present in this scope
    }
  }
  return false;
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
