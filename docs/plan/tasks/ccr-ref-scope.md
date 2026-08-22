---
task: ccr-ref-scope
title: "`expand` cannot find a ref issued minutes earlier — the CCR store is per-project-root, and a worktree is a different root"
state: done
owner: agent
size: M
design: No memo. The store is `src/compression/ccr-store.ts` over `LocalDirBlobStore`, rooted at `<projectRoot>/.golem/ccr` by `src/compression/native-lossless.ts:343`. The error text is `src/mcp/server.ts:128`. The offload marker is written by the PostToolUse hook (`src/hooks/post-tool-use.ts`); `.claude/rules/golem-ccr-refs.md` is the promise it makes.
gate: A ref a hook issued is retrievable by `expand` for as long as the marker implies, or the marker does not promise it. No path where Golem prints `hash=<64-hex>` and "stored losslessly" over content that cannot be fetched back.
depends_on: []
touches: [src/compression/ccr-store.ts, src/compression/native-lossless.ts, src/hooks/post-tool-use.ts, src/mcp/server.ts, src/knowledge/file-driver.ts, docs/wiki]
created: 2026-08-22
updated: 2026-08-21T23:22:11.749Z
---

## The report

2026-08-22, from an agent running R12.7: `expand` returned **"Unknown or expired
CCR ref"** for three WebFetch refs, *minutes* after they were issued, while the
marker that replaced the output promised the full original was stored
losslessly. It worked around the failure with `curl` and `sed` — i.e. it re-paid
for content Golem said it had.

This is worse than a missing feature. The rule file
(`.claude/rules/golem-ccr-refs.md`) tells every agent "nothing is lost", and
agents make retrieval decisions on that basis.

## "Expired" is probably the wrong word — start by disproving it

Read the code before reproducing: **neither `CcrStore` nor `LocalDirBlobStore`
implements eviction, pruning, or a TTL.** Grep for `prune|evict|ttl|maxEntries`
in both and confirm. The message says "Unknown or expired" and
`ccr-store.ts`'s own header says a missing *or corrupt* envelope maps to
`UnknownRefError` — so the same error covers three very different causes, and
the word "expired" sends the reader down a path that may not exist. Fixing that
conflation is part of this task.

## The leading hypothesis: two roots, one ref

The store is rooted per project: `join(projectRoot, ".golem", "ccr")`. The agent
that hit this was running **in a git worktree** (`isolation: "worktree"`, under
`.claude/worktrees/agent-<id>/`). So:

- its `PostToolUse` hook ran with the worktree as cwd and wrote the blob to
  `<worktree>/.golem/ccr`;
- the `expand` MCP tool is served by the MCP server started for the **main**
  project and resolves `<main-repo>/.golem/ccr`;
- same ref id, different directory, so: unknown.

That predicts exactly what was seen — fresh refs, instant failure, no eviction
involved. **Verify it** (issue a ref inside a worktree, expand from the main
session) rather than assume it; if it reproduces, the bug is scope resolution,
not retention.

Note the precedent: R11.2 hit the sibling problem for the vector index and fixed
it at the class rather than the instance — `canonicalProjectId` in
`src/knowledge/file-driver.ts` maps one project directory to exactly ONE
collection however its path is spelled. A worktree is the case that identity
function has to have an opinion about, and whatever this task decides should
agree with it.

## The decision this forces

Is a worktree the same project as its main checkout, for CCR purposes?

- **Same** → refs are shared, an agent in a worktree writes where the main MCP
  server reads, and expansion works across both. Resolve the root through the
  git common directory rather than cwd.
- **Different** → then the marker must not promise retrievability to a reader in
  another root, and the MCP server needs a way to be told which root it is
  answering for.

"Same" is the answer that matches the user's mental model and the rule file's
promise; go there unless something in the redaction or storage contract argues
otherwise. Say which, in the wiki page, either way.

## Second half: the error must distinguish its causes

`UnknownRefError` currently covers *never stored*, *stored in another root*,
*corrupt envelope* and (hypothetically) *evicted*. A caller cannot act on that,
and neither could the agent that hit it. Split the message so it names what was
checked and where it looked — "no envelope at `<path>`" is actionable; "unknown
or expired" is not. This is the same lesson as R11.7: a record that cannot answer
"what happened" makes the next person infer.

## Out of scope

Adding eviction or a retention policy — if the store genuinely never prunes,
that is a separate (and possibly wanted) discussion about disk, not this bug.
Changing the marker's format. Redaction behaviour.

## Gate detail

A reproduction first, named in the commit. Then: a ref issued by a hook in a
worktree is expandable from the session that spawned it, and an error that cannot
be satisfied says which root it searched. Plus a regression test at the seam that
broke — not only at the unit that works.

## Outcome

shipped
