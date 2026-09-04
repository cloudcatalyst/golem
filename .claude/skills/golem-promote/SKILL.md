---
description: Review pending distill drafts and promote them into the wiki — the last leg of capture → distill → promote
invocationMode: user
---

The user wants to promote captured/distilled drafts into durable wiki pages.
Optional filter: $ARGUMENTS

1. **List pending drafts.** Run `golem wiki promote --list` via Bash — it shows
   each `.golem/distill/` draft with its provenance (source note ts / URL), the
   target page path (routed from the draft's `type` → zone), and age.
2. **Review each candidate.** Read the draft. Check it is genuinely in our own
   words (no long quotes), carries real `[[wikilinks]]` to related pages, and
   does not contradict an existing page — surface any contradiction to the user
   rather than auto-resolving it (WIKI.md write rule).
3. **Promote on approval.** For each draft the user wants kept, run
   `golem wiki promote <id> --yes` — it writes through append-and-refine
   `upsertPage` semantics (union-merge frontmatter, dated separator, never a
   wholesale rewrite) and removes the consumed draft.
4. **Report** which drafts were promoted, to which pages, and which were left or
   dropped. If there are no pending drafts, say so and suggest `/golem-research`
   or `golem note` to capture something first.
