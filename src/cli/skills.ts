/**
 * WS-E E2 — the P0 skill files `golem init` installs.
 *
 * Directory-namespaced per verification-notes §11:
 * `.claude/skills/golem/<name>/SKILL.md` surfaces as `/golem/<name>`.
 * Each skill delegates to the frozen MCP tool names (plan §2.5); the
 * `/mcp__golem__*` prompt twins come from the MCP server directly.
 */

const slider = `---
description: Show or set the Golem token-savings slider (0 passthrough … 3 aggressive)
invocationMode: user
---

The user wants to view or change Golem's savings slider.

Arguments: $ARGUMENTS

- If the arguments contain a level (1-3), call the \`level\` MCP tool
  with that level, then confirm the change and briefly say what the new level does.
- If the level is 0, do NOT call the \`level\` tool — it rejects 0 by design, so
  that no tool call can turn redaction off. Warn that redaction is OFF at level 0
  (full bypass) and tell the user to run \`golem slider 0\` in their terminal.
- If no level was given, call \`stats\` and report the current slider level.
- If the Golem MCP tools are unavailable, tell the user the Golem MCP server is
  not connected and suggest running \`golem init\` and restarting Claude Code.
`;

const stats = `---
description: Show Golem token-savings statistics for this project
invocationMode: user
---

Call the \`stats\` MCP tool and present the results: current slider level,
tokens before/after, and per-stage savings. Keep it to a short table. If the
tool is unavailable, say the Golem MCP server is not connected and suggest
running \`golem init\` and restarting Claude Code.
`;

const expand = `---
description: Expand a Golem CCR reference back to its original content
invocationMode: user
---

The user wants to expand a compressed content reference (CCR).

Arguments: $ARGUMENTS

Extract the CCR reference id from the arguments (or from the marker in recent
context, e.g. \`hash=<sha256>\` / \`[golem:ccr ref=...]\`) and call the
\`expand\` MCP tool with it. Show the retrieved original content. If the
reference is unknown, report that and suggest \`golem stats\` to check the store.
`;

const bypass = `---
description: Send the next request(s) untouched — bypass Golem compression
invocationMode: user
---

The user wants to bypass Golem's compression pipeline.

Golem's proxy honors the \`x-golem-bypass\` header for pure passthrough, and
slider level 0 (passthrough) disables all transformation. Note: level 0 ALSO
disables redaction (secrets/PII reach the upstream raw), so prefer \`level 1\`
(redaction on, byte-faithful) unless a true full bypass is intended.

- For level 1 (the usual answer), call the \`level\` MCP tool with \`1\`.
- For a **true full bypass**, do NOT call the \`level\` tool — it rejects 0 by
  design, so that no tool call can turn redaction off. Tell the user redaction
  would be off and that they must run \`golem slider 0\` in their own terminal.

Then remind them to run \`/golem/slider 1\` (or their previous level) to
re-enable savings when done.
`;

const research = `---
description: Research a topic the wiki-first way — wiki, then local KB, then external web, then capture. Use this for ANY external/doc lookup or fact you need to verify.
invocationMode: user
---

The user wants to know about: $ARGUMENTS

This skill is the canonical path for looking anything up — a project fact, an
external doc, an API detail you'd otherwise search for on the web. Always climb
the ladder in order (spec Decision 28); each rung is cheaper/more trustworthy
than the next, and jumping to the network wastes tokens on something the KB
already has.

1. **Wiki.** Call \`wiki_read\` with the topic as \`title_or_path\` (try the page
   title first, e.g. "Prompt Caching"). If that misses, check the wiki's
   \`WIKI.md\` index (via \`fetch\` or \`search\`) for a close-but-not-identical
   title and \`wiki_read\` that instead.
2. **Local KB.** If no wiki page covers it, call \`search\` and \`fetch\` the best
   hit(s) — wiki pages rank above other results. The KB also indexes every
   previously-fetched web page (cached under \`.golem/webcache\`), so a doc you
   or a teammate already fetched is here, not on the network.
3. **External web — only after 1 and 2 miss.** Now, and only now, WebFetch the
   source. Re-run \`search\` before EACH new fetch (a related earlier fetch may
   already answer it). A previously-fetched URL is served from the cache
   automatically, so re-fetching is free and offline; the fetch is
   redacted + cached + indexed for next time.
4. **Answer**, citing the page(s)/source path(s)/URL(s) you used. If nothing
   turned up anywhere, say so plainly rather than guessing — never fall back to
   general knowledge silently.
5. **Capture what's worth keeping.** A fetched page is searchable but orphaned
   until it's a wiki page. If the finding is durable, propose a wiki
   source-note (run \`/golem/wiki-ingest <url>\`) with real \`[[wikilinks]]\`,
   citing the source. Author wiki pages freely (spec Decision 44) — no prior
   approval needed; every write is committed to git and reviewable.
`;

const wikiIngest = `---
description: Distill a URL into a new wiki source note (proposed, not auto-written)
invocationMode: user
---

The user wants to add this URL to the project's wiki: $ARGUMENTS

1. Fetch the URL (WebFetch's knowledge-base cache hook captures the raw
   content automatically — no separate ingest step needed for that).
2. Run \`golem wiki distill $ARGUMENTS\` via Bash. This checks for an
   existing local-model draft first and reuses it (Decision 29: prefer an
   existing draft over re-distilling); if none exists yet, it distills one
   now from the cache with the local model. Read the printed draft path with
   the Read tool — the draft is already wiki-shaped (frontmatter + body,
   \`type: source\`) at \`.golem/distill/<slug>.md\` (zone 1, local only, not
   in the wiki yet).
3. Review the draft: rewrite anything that isn't genuinely in your own
   words, quotes the page at length, or invents a candidate wikilink — the
   wiki stores distilled notes, not raw copies (see \`docs/wiki/WIKI.md\`'s
   write rules). If \`golem wiki distill\` isn't available (no local model
   configured), distill the note yourself instead.
4. Call \`wiki_upsert\` with \`rel_path: "sources/<slug>.md"\`, \`type: "source"\`,
   \`sources: ["$ARGUMENTS"]\`, and the reviewed body — author it directly (spec
   Decision 44); no prior approval needed, since the write is committed to git
   and reviewable. Surface any contradiction with an existing page rather than
   silently overwriting it.
`;

const develop = `---
description: Orchestrate building a feature or fix end-to-end — research the wiki/KB, draft code+tests with the coder tool, verify, iterate
invocationMode: auto
---

The user (or Claude's own judgment) has identified development work to do: $ARGUMENTS

1. **Research first.** Run the \`/golem/research\` skill (or its steps
   directly: \`wiki_read\` the likely page, else \`search\` + \`fetch\`) for the
   feature area so you understand existing patterns, prior decisions, and
   frozen interfaces before writing anything.
2. **Draft with \`coder\` first — but only when it pays.** Per this project's
   coder-first convention, call the \`coder\` MCP tool to draft non-trivial
   implementation and tests. The tool now **grounds** drafts in the local
   knowledge base automatically (relevant project/wiki hits are injected), so
   you usually don't need to hand-feed context — add \`context\` only for
   specifics search won't surface. For a genuinely non-trivial draft, pass
   \`refine: true\` to run a local judge→revise pass (it roughly doubles local
   latency, so it earns its keep only on real logic, not boilerplate). **Skip
   \`coder\` entirely** for trivial edits (a rename, a one-line fix, a tiny
   test tweak) — the round trip costs more than it saves.
3. **Review and finalize.** Treat the draft as a starting point, not a final
   answer — rewrite anything that doesn't fit this codebase's conventions
   (frozen interfaces, TS strict, zod at boundaries, no unneeded abstraction).
   Check the draft's \`grounding\`/\`refinement\` fields to see what it was based
   on and whether the local judge changed anything.
4. **Verify.** Run the project's check command (e.g. \`npm run check\` — lint
   + typecheck + test) via Bash. On failure, fix and re-run; use \`coder\`
   again for non-trivial fixes.
5. **Report** what changed and which files were touched. Don't commit unless
   asked.

Before a **wide or speculative** change (a refactor across several files, a
migration, a "let's see if this works"), take a checkpoint first: \`golem
checkpoint create --note "<the attempt>"\`. If it fails, propose discarding it
(\`/golem/checkpoint\`) instead of spending a repair cycle — the repair also
leaves its wreckage in context for every later turn.

If \`coder\`/\`research\` are unavailable, say the Golem MCP server isn't
connected and suggest \`golem init\` and restarting Claude Code.
`;

const plan = `---
description: Turn captured notes, open questions, and distill drafts into concrete tasks — together, plan-gated
invocationMode: user
---

The user wants a collaborative planning session. Optional focus topic: $ARGUMENTS

This closes the second-brain loop into tasks (spec Decision 36). Your job is to
surface candidate work from what Golem has already captured, discuss it with the
user, and — only with approval — record agreed tasks in the plan docs. You are a
co-pilot here: the human decides what becomes a task.

1. **Gather inputs (read-only — read, never write in this step).** If a focus
   topic was given, prioritize inputs matching it, but still skim the rest.
   - Recent \`golem note\` captures: run \`golem note list\` via Bash (add
     \`-n <count>\` for more than the default 20, or \`--json\` for exact
     timestamps to cite).
   - Open questions: read the pages under \`docs/wiki/questions/\` (list the dir,
     Read each; or \`wiki_read\` a page by title).
   - Pending distill drafts: list \`.golem/distill/\` and Read the drafts (these
     are captured ideas/sources already shaped into draft wiki pages, not yet
     promoted).
   - The ideas inbox: Read \`docs/plan/BACKLOG.md\`.
   - Existing open work: run \`golem task index --summary\` via Bash. Every open
     item is a committed task document under \`docs/plan/tasks/\` (spec Decision
     55); \`golem task show <id>\` prints one in full. Do this before proposing
     anything, so you don't re-propose something already scheduled or blocked.
2. **Surface candidates, grouped by source.** For each, give a one-line
   statement and cite exactly where it came from (a note timestamp, a
   \`questions/<slug>.md\` page, a \`distill:<slug>\` draft, or this conversation).
   Note anything already covered by an existing task or BACKLOG entry instead of
   re-proposing it.
3. **Discuss with the user.** Ask which candidates are worth turning into tasks,
   what's out of scope, and what's missing. Let the user drive prioritization.
4. **Propose concrete entries** for the agreed items:
   - New rows for \`docs/plan/BACKLOG.md\` (Date / Idea / Source / Status — see
     that file's own "How this file works" for the exact format) for ideas that
     are not yet work, or
   - A new **task document** under \`docs/plan/tasks/<id>.md\` for items the user
     wants scheduled now — follow \`docs/plan/tasks/README.md\` for the
     frontmatter and the house style (goal, design source, gate, out-of-scope),
     then set the BACKLOG row's Status to \`promoted\` with the task id, and run
     \`golem task index --write\` to refresh the roadmap index.
5. **Plan-gate every write.** Show the exact edit (file + the lines to
   add/change) and wait for explicit approval before touching any plan file.
   Never edit \`BACKLOG.md\`, a task document, or \`ROADMAP.md\` unprompted.
   Append rows; don't rewrite or delete another entry's wording. **Never
   hand-edit the roadmap's index table** — it is generated between the
   \`golem:task-index\` markers; change the task document and regenerate.
6. **The planning contract** (mirrors the \`/golem/research\` query contract):
   cite a source for every proposed task, clearly flag what is your inference
   versus what the user actually stated, and admit gaps rather than inventing
   work to fill the page.

If the Golem MCP tools or CLI are unavailable, say the Golem MCP server isn't
connected and suggest \`golem init\` and restarting Claude Code.
`;

const verify = `---
description: Run the full green-check gate before committing — lint, typecheck, tests, and wiki lint — judged by EXIT CODE, not tailed output
invocationMode: user
---

The user wants to confirm the working tree is green before committing (the
batch close-out bar in CLAUDE.md).

Run these via Bash from the repo root, and judge each by its **exit code**, not
by the tail of its output — a run can print errors and still be misread as
passing if you only skim the tail (that mistake has broken CI in this repo
before):

1. \`npm run check\` — Biome lint + \`tsc --noEmit\` (strict) + vitest. If a
   step is split out, run \`npm run lint\`, \`npx tsc --noEmit\`, and
   \`npx vitest run\` separately and check each exit code.
2. \`golem wiki check\` — wiki frontmatter/date/link lint (only if any
   \`docs/wiki/\` page changed).

Report a short PASS/FAIL table with each step's exit code. On any non-zero exit,
show the failing output and stop — do not suggest committing. Fix the cause (use
the \`coder\` MCP tool for non-trivial fixes) and re-run. The tree is green only
when every step exits 0.
`;

const ship = `---
description: Batch close-out — verify green, rebuild + restart the running services, tidy the planning docs, write the debrief, retire the batch brief, then commit + open a PR
invocationMode: user
---

The user wants to close out a batch of work (the CLAUDE.md "Batch close-out"
checklist). Invoking this skill authorizes committing and opening a PR for this
batch. Do these in order; stop and surface any failure rather than pressing on.

1. **Verify green.** Run the \`/golem/verify\` steps (\`npm run check\` +
   \`golem wiki check\`), judged by exit code. Do not proceed until green.
2. **Deploy locally** so the *running* processes pick up the change:
   \`npm run build\` → \`golem proxy restart\`. Tell the user any live
   \`golem mcp serve\` connection must be reconnected by Claude Code; and if
   \`vscode-extension/\` changed, run \`cd vscode-extension && npm run deploy:local\`
   then reload the window. Skip the parts nothing touched.
3. **Tidy the planning docs.** Close the task and refresh the generated index:
   \`golem task done <id> --note "<outcome>"\` → \`golem task index --write\` →
   add a **table row** to \`docs/plan/SHIPPED.md\` under the releases table
   (\`| title | date | outcome |\` — multi-sentence, covering what shipped and
   why it matters). Never hand-edit the roadmap's index table (it is generated
   between the \`golem:task-index\` markers). Then update any living-doc
   references (CLAUDE.md, IMPLEMENTATION_PLAN, spec) to point at git history /
   shipped artifacts.
4. **Write the debrief.** Run \`/golem/debrief\` to author the dated
   \`docs/wiki/debriefs/\` page (wiki writes are un-gated, Decision 44). The
   debrief is required — without it the knowledge base stays blind to the task.
   Include: verdict, problem, fix/approach, key lessons/numbers, sources, tags.
5. **Retire the batch brief.** Delete the completed batch brief from the tree —
   git history preserves it; completed briefs are never kept in the tree.
6. **Commit + PR.** Conventional commits on a branch (never commit to \`main\`),
   one workstream per PR, PR body lists affected interfaces. Use the \`gh\` CLI:
   \`gh pr create\`, then \`gh pr merge --squash\` to match the repo's \`(#N)\`
   history. Record any spec Decisions Log change in \`docs/golem-spec.md\`.
`;

const promote = `---
description: Review pending distill drafts and promote them into the wiki — the last leg of capture → distill → promote
invocationMode: user
---

The user wants to promote captured/distilled drafts into durable wiki pages.
Optional filter: $ARGUMENTS

1. **List pending drafts.** Run \`golem wiki promote --list\` via Bash — it shows
   each \`.golem/distill/\` draft with its provenance (source note ts / URL), the
   target page path (routed from the draft's \`type\` → zone), and age.
2. **Review each candidate.** Read the draft. Check it is genuinely in our own
   words (no long quotes), carries real \`[[wikilinks]]\` to related pages, and
   does not contradict an existing page — surface any contradiction to the user
   rather than auto-resolving it (WIKI.md write rule).
3. **Promote on approval.** For each draft the user wants kept, run
   \`golem wiki promote <id> --yes\` — it writes through append-and-refine
   \`upsertPage\` semantics (union-merge frontmatter, dated separator, never a
   wholesale rewrite) and removes the consumed draft.
4. **Report** which drafts were promoted, to which pages, and which were left or
   dropped. If there are no pending drafts, say so and suggest \`/golem/research\`
   or \`golem note\` to capture something first.
`;

const upstream = `---
description: Switch the upstream account/provider the correct way — golem account use (auto-restarts the proxy) + reconnect MCP, NOT the Claude Code model picker
invocationMode: user
---

The user wants to change which upstream account/provider Golem forwards to
(e.g. a different Anthropic account, or a Foundry/OpenRouter gateway).
Target: $ARGUMENTS

This is **not** the Claude Code model picker — that chooses a model within the
current account; Golem routes the whole request to a configured upstream. Do it
through Golem:

1. **List accounts.** Run \`golem account list\` via Bash — shows configured
   accounts, which is active, and whether each has a stored credential.
2. **Switch.** Run \`golem account use <id>\` (or \`golem account use none\` to
   revert to the top-level default). This **restarts the proxy automatically**
   so the switch takes effect — no separate \`golem proxy restart\` needed.
3. **Reconnect MCP.** Tell the user any live \`golem mcp serve\` connection must
   be reconnected by Claude Code for the change to reflect in the MCP tools.
4. **Confirm.** Report the now-active account and its upstream URL. If a provider
   has no stored credential, say so and give the fix
   (\`golem account login <id>\`) rather than leaving auth silently broken —
   there is no environment variable to export (spec Decision 47).
`;

const debrief = `---
description: Author the dated wiki debrief for the work just completed — a diff-aware summary with wikilinks and any Decisions touched
invocationMode: user
---

The user wants a debrief page for the work just finished (the CLAUDE.md
close-out step). Optional slug/topic: $ARGUMENTS

1. **Gather what changed.** Look at the branch diff (\`git diff --stat\` and the
   key hunks via Bash) and the task/batch id you worked. Describe what actually
   changed — don't invent scope.
2. **Draft the page.** A debrief is a wiki page: \`type: debrief\`, filename
   \`YYYY-MM-DD-<slug>.md\` under \`docs/wiki/debriefs/\`. Keep it to: what
   shipped, why (the problem), key decisions/tradeoffs, and residual follow-ups.
   Add real \`[[wikilinks]]\` to every related concept/page and cite the source
   files/decisions. Redaction-before-storage still applies.
3. **Write it.** Call \`wiki_upsert\` with
   \`rel_path: "debriefs/YYYY-MM-DD-<slug>.md"\` and \`type: "debrief"\` — author
   it directly (wiki writes are un-gated, Decision 44); every write is committed
   to git and reviewable.
4. **Record decisions.** If the work changed a spec Decision, note that in
   \`docs/golem-spec.md\`'s Decisions Log too (that stays authoritative).
5. **Verify links.** Run \`golem wiki check\` via Bash so the new page's
   wikilinks resolve.
`;

const park = `---
description: Graceful handoff at a usage limit — park the session until the window resets, filing where you're up to as a durable task in the same call
invocationMode: user
---

The user wants to stop deliberately (approaching a usage/session limit, or just
pausing) without losing their place — the manual counterpart to Golem's enforced
snooze gate.

1. **Park and document in ONE call.** Call the \`snooze\` MCP tool with \`until\`
   set to the window's reset time (Golem reads it from the rate-limit headers;
   \`golem status\` shows utilization + freshness on its Limits line) AND
   \`note="<one-line summary + the exact next steps>"\`. The note is filed as a
   durable local task *before* the wait starts — the safety net if the session ends
   before you resume — and the call then parks the session with a heartbeat,
   spending no model tokens while it waits.
2. **Then STOP and wait.** Do not keep working. When snooze completes at the
   reset, its notification resumes this conversation in place with context
   intact — pick up from the noted task.

Don't reach for \`golem task add\` via Bash: under enforcement (Decision 45) every
non-\`snooze\` tool call is denied, so \`note\` is how the task gets written.

If the rate-limit feed is cold (no limit headers), \`golem status\` warns the
auto-park is blind — pick the reset time from Claude Code's own limit indicator
and park manually.
`;

const triage = `---
description: Do this the local-first way — attempt or draft it with the local model before spending paid tokens, escalate only when the local pass isn't enough
invocationMode: user
---

The user wants a piece of work done as cheaply as possible: $ARGUMENTS

Golem's stance is local-first (spec Decision 31 and the coder-first rule): the
paid model's tokens are for judgment the local model can't make. Route the work:

1. **Classify it.** Is it retrieval-shaped (a fact/lookup), code-drafting, or
   genuinely-hard reasoning?
   - **Lookup?** Use \`/golem/research\` — the wiki/KB may answer it with no
     model call at all.
   - **Code/tests?** Draft with the \`coder\` MCP tool first (it grounds on the
     local KB automatically); pass \`refine: true\` for non-trivial logic. Then
     review and finish it yourself.
   - **A queued/standalone sub-task?** Run it locally with \`golem task run\`
     (bounded local multiplexing) and \`golem task escalate\` only when the local
     pass is insufficient.
2. **Escalate deliberately.** When you do spend paid tokens, fold the local pass
   in as grounding rather than starting over — review, integration, and the hard
   call are what Claude is for.
3. **Report** what was done locally vs escalated, so the token split is honest.

If no local model is available (\`golem devices\` shows none), say so and proceed
normally — the practice degrades, it doesn't block.
`;

const cacheHealth = `---
description: Report prompt-cache health — hit rate and likely cache-busting — so you can see savings you're silently losing
invocationMode: user
---

The user wants to know how well Anthropic prompt-caching is working. Caching is
where the real savings are on Anthropic traffic (compression is ~0% there,
Decision 23), and one changed byte in the cached prefix — an injected timestamp,
a reordered tool-definition block — silently turns a cache read into a full
re-bill.

1. **Read the current signal.** Call the \`stats\` MCP tool and run
   \`golem status\` via Bash, and surface whatever cache fields are present:
   cached-read vs cache-creation vs uncached input tokens, and a hit rate if
   available.
2. **Flag cache-busting.** If the hit rate is low or dropping, call it out and
   name the usual culprits to check: a timestamp/nonce in the system prompt or a
   tool arg, a reordered or newly-added tool/MCP-definition block (these sit in
   the cached prefix), or a mid-history rewrite.
3. **Be honest about coverage.** Full per-request cache-bust detection is a proxy
   feature still on the backlog (2026-07-24, "cache-hit observability") — if the
   telemetry doesn't yet expose a field, say so plainly. Never present a guess as
   a measured number.
`;

const contextHygiene = `---
description: Keep the working context clean — prefer narrow re-runs and CCR references over re-reading, and expand only what's actually needed
invocationMode: user
---

The user wants to reduce context bloat from accumulated tool output (logs, large
file reads, dead-end retries) — the "keep context clean" technique, which both
cuts tokens and tends to improve results.

Golem already does most of this automatically: a PostToolUse hook swaps oversized
Bash/Read/Grep/Glob/WebFetch outputs for a compact digest carrying a
\`hash=<id>\` marker, storing the original losslessly under \`.golem/ccr\` (the
CCR-refs rule). Your job is to use that discipline deliberately:

1. **Prefer narrow over expand.** When you only need part of a swapped output,
   re-run a tighter command (grep the file, limit the line range) instead of
   expanding the whole thing back into context.
2. **Expand only on demand.** When you genuinely need the full original, call the
   \`expand\` MCP tool with the \`ref_id\` from the marker (or \`/golem/expand <id>\`)
   — and only then. Each expand re-spends the tokens the swap saved.
3. **Don't re-read.** If a file/page is already in context or in the KB, use
   \`search\`/\`fetch\` for the relevant chunk rather than re-reading the whole
   thing.

This is a working habit, not a one-off command — Golem retains the originals, so
nothing is lost when you keep the live context lean.
`;

const freshEyes = `---
description: Fresh-eyes review — read the code as CODE ONLY (ignore comments/docs), judge the approach against best practices, then compare your independent reading with the comments/documentation to catch drift and disagreement
invocationMode: user
---

The user wants an unbiased review of a function, module, or wider codebase:
$ARGUMENTS (default: the current working diff — if the scope is unclear, ask
what to review before starting).

The point is to defeat anchoring: comments and docs tell you what the author
*intended*, which quietly biases you into agreeing. So form your own view from
the code alone first, then compare.

## Pass 1 — code only (do NOT read comments, docstrings, or docs yet)
Read only the executable code of the target — identifiers, types, control flow,
data flow, and the tests. Deliberately skip comments, docstrings, and the
README/wiki/spec. (On a large target you can have the local model produce a
code-only behavioural summary first via the \`coder\` MCP tool or \`golem task
run\` — cheap, and it keeps you honest — but do the judging yourself.)
From the code alone, write down:
1. **What it does** — the behaviour you infer, in your own words.
2. **The approach** — the design/pattern you see, rated against best practices:
   correctness, edge cases, error handling, complexity, naming, clarity,
   testability. Note anything you would do differently.
3. **Open questions** — what the code alone can't tell you (why a constant, why
   this ordering, an apparent foot-gun).

## Pass 2 — reveal comments + documentation, then compare
Now read the comments, docstrings, and related docs (use \`/golem/research\` for
the module: its wiki page, a spec Decision, a CLAUDE.md rule, a frozen-interface
contract). Diff your Pass-1 reading against what they claim, and sort every gap
into one of three buckets:

- **Code should change** — your fresh reading found a real problem (bug, missing
  edge case, a guarantee weaker than stated, needless complexity) the docs don't
  excuse. Cite file:line and the concrete failure scenario.
- **Comment/doc should change** — the code is fine but the prose is wrong, stale,
  or misleading: it claims a behaviour/guarantee the code doesn't provide, names
  renamed/removed things, or over/under-states. Flag this drift even when the
  code is correct — a wrong comment is a latent bug.
- **Agree / confirmed** — your independent reading matches the intent and the
  approach is sound. Say so briefly; a confirmation from fresh eyes is a result.

## Report
Group findings by those three buckets, most-important first, each with file:line,
what you independently concluded, what the docs claim, and the concrete change
you'd make. Be explicit about coverage: on a large target, say what you actually
read versus sampled — never imply whole-codebase coverage you didn't do (this
repo forbids silent caps). Respect the hard rules while judging: frozen
interfaces (\`src/interfaces/\`), redaction-first, byte-fidelity — a
"simplification" that breaks one of those is not an improvement.

This skill writes nothing. To act on findings: code fixes via \`/golem/develop\`,
doc/comment fixes inline, and durable drift worth tracking via \`/golem/plan\`
into the backlog. It complements \`/code-review\` (bug hunting) and \`/simplify\`
(cleanup) — fresh-eyes is specifically about whether the code and its
documentation agree.
`;

const checkpoint = `---
description: Snapshot the working tree before a risky attempt so a failed one can be DISCARDED instead of repaired — opt-in shadow git refs, never a commit on the branch
invocationMode: user
---

The user wants to take, inspect, or roll back to a change-ledger checkpoint
(R8.9): $ARGUMENTS

Why this exists: repairing a failed attempt costs a read-diagnose-edit cycle AND
leaves the wreckage in context for every later turn. Discarding is cheaper. So
before a risky attempt (a wide refactor, a migration, a "let's try it" edit
across many files), take a checkpoint — then throw the attempt away if it fails
instead of unpicking it.

Run these with Bash:

- \`golem checkpoint create --note "<what you are about to try>"\` — cheap, and a
  no-op when nothing changed since the last one. Take one BEFORE the attempt.
- \`golem checkpoint list\` — what exists, newest first.
- \`golem checkpoint show <id|latest>\` — exactly what a restore would overwrite
  and delete. Read this before proposing a restore.
- \`golem checkpoint restore <id|latest>\` — **destructive and human-gated.** It
  is classified destructive (ADR-0002), so it always prompts; never pass
  \`--yes\` on the user's behalf. Propose it, show the plan, let them accept.

What it will NOT do: commit on the user's branch, stage anything, move HEAD, push
anything, or touch gitignored files. Snapshots live under
\`refs/golem/ledger/*\` and a restore only writes worktree files — after taking
one, \`git diff refs/golem/ledger/<id>\` is an ordinary diff. It degrades to a
no-op with a reason where it cannot be safe: no git, no repo, a detached HEAD, or
a dirty index (report that reason rather than working around it).
`;

const firstPancake = `---
description: "First pancake" release review — assume release 1 was the throwaway pancake; keep the recipe (ingredients + method) that is proven, discard what was scaffolding, and shape the codebase for the first REAL release
invocationMode: user
---

The user wants to prepare a project for its first real release, using the
"first pancake" lens: the first pancake of any batch is never great, no matter
the ingredients, the recipe, or the pan temperature — but every pancake after it
is perfect. So the first release of a project is expected to be the throwaway
pancake. The ingredients are good and the method is valid; what's wrong is
execution, not fundamentals. Nobody needs to see or "eat" the first release, so
don't polish it — clean the pan and build pancake #2 (the first real
release) right.

Scope: $ARGUMENTS (default: the whole working tree / repo). If it's unclear
what "the project" is, confirm the target before starting.

This skill writes nothing by itself. Its job is a decision-edged review: sort
everything it examines into "keep" vs "scrap", and propose concrete actions. To
act on the fixes, use \`/golem/develop\`; to record durable follow-ups use
\`/golem/plan\`.

## Pass 1 — settle what the recipe actually is (the keep list)
Decide what belongs to a good pancake and will carry forward UNCHANGED. These are
the "ingredients" and "method": framework/stack and the core dependencies, the
architecture and its invariants, the data model / source of truth, the project's
identified strengths and any git history or docs that are genuinely good. For
each, say why it's proven rather than assumed, and name the guardrails that must
survive the cleanup (frozen interfaces, redaction-first, byte-fidelity, the hard
rules in CLAUDE.md). This list is the contract for everything below — nothing in
it gets "cleaned".

## Pass 2 — eat the first pancake critically (the discard list)
Assume release 1 is the burnt first pancake and look for the throwaway residue —
the code that was written to validate the approach, not to ship it. Examples to
hunt for, explicitly:
- Dead code, stale modules, and features that shipped "to see if it works" and
  were never used.
- Scaffolding, boilerplate, and proof-of-concept hacks (a hardcoded path, a
  TODO like "fix this later", a provisional API) that were enablers, not product.
- Half-integrated or abandoned seams (a half-wired integration, an API surface
  nobody calls, a config knob with no consumer).
- Code that over-folds on the first-pancake assumption itself: built to be torn
  out later, or brittle because it was thrown together to get a result.
Label each hit: KEEP, SCRAP, or REFACTOR, with file:line and the concrete reason
under the pancake lens. Be specific and honest about coverage — say what you
actually read versus sampled; never imply whole-repo coverage you didn't do.

## Pass 3 — clean the pan, then reset for pancake #2
Turn the SCRAP list into a concrete "prepare for first real release" plan, again
distinguishing what changes now versus what is held for later:
- What to delete (dead code, scaffolding, the throwaway prototype's residue).
- What to consolidate (two paths that do the same thing, an API that grew.
  organically and should be narrowed before it's a public contract).
- What to harden for the real release (error handling, edge cases, tests for the
  core invariants, docs that describe what actually exists) — because pancake #2
  is the one people will see.
- What NOT to touch in this pass (the requirement is "clean the pan", not
  "re-season it beyond recognition") — over-refactoring the good parts is how the
  second pancake burns. Each over-reach is itself a finding.

## Report
Present findings grouped by the three labels above (KEEP / SCRAP / REFACTOR),
most important first, each with file:line, your independent reason, and the
concrete action you'd take. End with a short "pan reset" summary: the delete /
consolidate / harden moves for pancake #2, and explicit holds for what stays. If
nothing of the first release should change, say so plainly rather than inventing
churn — a first release that is already buildable is a result.

This complements \`/code-review\` (bug hunting), \`/simplify\` (cleanup), and
\`/golem/fresh-eyes\` (code-vs-docs drift). First pancake is the strategic pass:
what to keep, what to scrap, and what to harden before the first RELEASE, rather
than a line-level audit. Respect the hard rules while judging — a "cleanup" that
breaks a frozen interface or weakens redaction is not an improvement.
`;

/** name -> SKILL.md content; installed under .claude/skills/golem/<name>/. */
export const P0_SKILLS: Readonly<Record<string, string>> = {
  slider,
  stats,
  expand,
  bypass,
  research,
  "wiki-ingest": wikiIngest,
  develop,
  plan,
  verify,
  ship,
  promote,
  upstream,
  debrief,
  park,
  triage,
  "cache-health": cacheHealth,
  "context-hygiene": contextHygiene,
  "fresh-eyes": freshEyes,
  checkpoint,
  "first-pancake": firstPancake,
};
