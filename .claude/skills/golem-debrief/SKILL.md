---
description: Author the dated wiki debrief for the work just completed — a diff-aware summary with wikilinks and any Decisions touched
invocationMode: user
---

The user wants a debrief page for the work just finished (the CLAUDE.md
close-out step). Optional slug/topic: $ARGUMENTS

1. **Gather what changed.** Look at the branch diff (`git diff --stat` and the
   key hunks via Bash) and the task/batch id you worked. Describe what actually
   changed — don't invent scope.
2. **Draft the page.** A debrief is a wiki page: `type: debrief`, filename
   `YYYY-MM-DD-<slug>.md` under `docs/wiki/debriefs/`. Keep it to: what
   shipped, why (the problem), key decisions/tradeoffs, and residual follow-ups.
   Add real `[[wikilinks]]` to every related concept/page and cite the source
   files/decisions. Redaction-before-storage still applies.
3. **Write it.** Call `wiki_upsert` with
   `rel_path: "debriefs/YYYY-MM-DD-<slug>.md"` and `type: "debrief"` — author
   it directly (wiki writes are un-gated, Decision 44); every write is committed
   to git and reviewable.
4. **Record decisions.** If the work changed a spec Decision, note that in
   `docs/golem-spec.md`'s Decisions Log too (that stays authoritative).
5. **Verify links.** Run `golem wiki check` via Bash so the new page's
   wikilinks resolve.
