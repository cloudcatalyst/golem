---
description: Do this the local-first way — attempt or draft it with the local model before spending paid tokens, escalate only when the local pass isn't enough
invocationMode: user
---

The user wants a piece of work done as cheaply as possible: $ARGUMENTS

Golem's stance is local-first (spec Decision 31 and the coder-first rule): the
paid model's tokens are for judgment the local model can't make. Route the work:

1. **Classify it.** Is it retrieval-shaped (a fact/lookup), code-drafting, or
   genuinely-hard reasoning?
   - **Lookup?** Use `/golem/research` — the wiki/KB may answer it with no
     model call at all.
   - **Code/tests?** Draft with the `coder` MCP tool first (it grounds on the
     local KB automatically); pass `refine: true` for non-trivial logic. Then
     review and finish it yourself.
   - **A queued/standalone sub-task?** Run it locally with `golem task run`
     (bounded local multiplexing) and `golem task escalate` only when the local
     pass is insufficient.
2. **Escalate deliberately.** When you do spend paid tokens, fold the local pass
   in as grounding rather than starting over — review, integration, and the hard
   call are what Claude is for.
3. **Report** what was done locally vs escalated, so the token split is honest.

If no local model is available (the `devices` MCP tool reports none pulled), say
so and proceed normally — the practice degrades, it doesn't block.
