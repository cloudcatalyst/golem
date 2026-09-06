---
title: The Click Was Never the Defect — Documenting the Release PR's Approval Beat
type: debrief
tags: [ci, release, github-actions, documentation, credentials, adr-0003]
sources: [docs/plan/tasks/release-pr-needs-approval.md, .github/workflows/release-prepare.yml, "docs/wiki/concepts/Release Pipeline.md", "https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow"]
created: 2026-09-06
updated: 2026-09-06
---

# The click was never the defect

`release-pr-needs-approval` was filed on 2026-09-04, cutting **v0.50.0**, as a
pipeline that *stalls*: the release PR opened with its required `CI gate` check
at `action_required`, **zero jobs**, `mergeStateStatus: BLOCKED`, and
`gh pr checks` answering *"no checks reported"*. It was confirmed again on
2026-09-06 cutting **v0.53.0**, identically, with the workaround written down.

The obvious reading is that automation broke and needs fixing. It is the wrong
reading, and the task doc had already said so in its last paragraph.

## What is actually happening

`release-prepare.yml` opens the PR with `gh pr create` as `GITHUB_TOKEN`, and
GitHub's anti-recursion rule is that *"events triggered by the `GITHUB_TOKEN`
will not create a new workflow run"*. The live docs (checked 2026-09-06) name
the exception that matters here: for `pull_request` opened/synchronize/reopened,
GitHub does **not** drop the run — it creates it and parks it in an
approval-required state for a write-access user, expressly "to prevent recursive
workflow runs while still allowing CI workflows to run on pull requests created
by automation".

`main` requires the `CI gate` check, so the release cannot merge until CI runs,
and CI will not run until someone clicks. That is the entire stall — one click,
by design, on GitHub's side, and not going away.

## The decision

Three options, and two of them cost more than the beat does:

| option | cost |
|---|---|
| Push the bump, let a human open the PR | trades one click for another, and loses the generated PR body |
| Open the PR with a **PAT** in a CI secret | a long-lived credential with `repo` scope in CI config — against ADR-0003, which says credentials live in a keychain |
| **Keep the approval, document it** | one click per release, in the same session as the merge |

The third won. Buying out a click with a long-lived `repo`-scoped credential is
a bad trade for a project whose own posture is that secrets live in the OS
keychain; and GitHub's framing is that this approval is a safety feature for
bot-opened PRs, not an obstacle to route around. A human confirming before
anything reaches npm and a public CDN path is defensible on its own.

## Key lessons

**The defect was the disagreement, not the behaviour.** The workflow's comments
described the flow as automatic while the flow required a click. When behaviour
and documentation disagree, the documentation is the one people believe, so the
documentation is what costs them the afternoon — twice, here. Nothing about the
pipeline changed in this task; only what it says about itself.

**A "stall" that is a deliberate safety feature should be recognised, not
debugged.** Every symptom of this one reads like a failure: a required check
neither passing nor failing, a run `completed` after 0 seconds, and a tool
reporting *no checks reported* on a PR that looks fine. The cheapest fix for a
misleading symptom is to name it in advance, in the place the operator is
already looking.

**Say it where they are, not where you wish they were.** The beat is now stated
three times, in the order an operator meets it: the header comment of
`release-prepare.yml` (for whoever edits the workflow), a new **job summary**
step on the prepare run (which prints the PR URL and the two `gh api` calls),
and the **PR body itself**, whose first section is what to click and whose merge
checklist now opens with *"the CI run on this PR has been approved"*. A note in
only one of those three would be missed by two thirds of the readers.

**The workflow cannot approve its own run.** `GITHUB_TOKEN` is the very token
GitHub is refusing to let start runs, so an auto-approve step would be asking
the blocked party to unblock itself. Naming the click is the most it can
honestly do — and *approving publishes nothing*, so an agent may safely do it;
only the merge is the user's.

## Implementation notes

The PR body is built in a **quoted** heredoc (`<<'EOBODY'`) so the backticks,
`$`-signs and `${{ }}`-looking text in it stay literal. The repository slug is
therefore not interpolated but substituted afterwards —
`BODY="${BODY//__REPO__/$GH_REPO}"` — which keeps the whole body inert without
having to escape anything inside it. Verified by parsing the YAML, extracting
the `run:` blocks, and executing them against a stub `gh` to read the rendered
body and job summary.

## Deliberately not done

- **No PAT, no GitHub App token.** See the table above.
- **No auto-approve step.** Cannot work with `GITHUB_TOKEN`; see above.
- `CLAUDE.md`'s "Branches and releases" section was left alone — two sibling
  agents were live in the same tree, and the gate is satisfied by the workflow
  and the wiki page.

Related: [[Release Pipeline]] §  The release PR needs one click before CI will
run; [[Portal Install Contract]].
