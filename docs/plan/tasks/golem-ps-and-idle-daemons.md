---
task: golem-ps-and-idle-daemons
title: "`golem ps` — Golem accounts for its own processes, and stops leaving idle ones behind"
state: done
owner: agent
size: M
discipline: code
design: "The daemon side already exists: `golem proxy start/stop/restart` with pidfiles, and `src/dashboard/lan.ts` / `src/cli/proxy-daemon.ts` know what was spawned. This adds the read model over them plus an idle policy. `golem status` is the precedent for the reporting shape."
gate: "(1) `golem ps` lists every Golem-owned process on this machine with pid, kind, project, age and RSS, and its output is correct across a proxy that is running, one that was killed without stopping (stale pidfile), and one started for a project directory that no longer exists. (2) `golem ps --prune` removes ONLY processes Golem can prove are its own and are not serving a live session — asserted by a test where a foreign `node.exe` and a live proxy are both present and both survive. (3) A project proxy idle beyond `proxy.idle_timeout` exits on its own, and the timeout being unset means never (today's behaviour), so nobody's long-running setup changes under them."
depends_on: []
touches: [src/cli/commands/proxy.ts, src/cli/proxy-daemon.ts, src/cli/commands/status-update.ts, src/config/schema.ts, tests/unit/cli/]
created: 2026-09-13
updated: 2026-09-13T10:57:16.838Z
---

## Why

The user opened Task Manager and found a wall of `node.exe` with no way to tell
which were Golem's. Measured on their machine, 2026-09-13:

| what | count | note |
|---|---|---|
| `golem statusline` | 7 | leaked by the pre-#194 stdin bug; 248 MB, oldest 3h43m |
| `golem proxy start` | 3 | one current; **two idle since 10 September** |
| `golem mcp serve` | 2 | both legitimate — one per live Claude Code session |

Of 30 `node.exe` totalling 1.31 GB, 12 were Golem's. Pruning by hand took the
machine to 20 processes and 0.89 GB.

Two of those three facts are already fixed or by design. The remaining problem is
that **nothing in Golem can answer "what are you running, and why"** — the user
had to ask an agent to run `Get-CimInstance` and correlate parent pids by hand.

## What to build

### 1. `golem ps`

One row per Golem-owned process: pid, kind (`proxy` · `mcp` · `statusline` ·
`dashboard`), the project directory it serves, age, RSS, and whether its pidfile
agrees with reality. `--json` for machines, like `golem status`.

Ownership must be PROVEN, not pattern-matched. A command line containing
`golem-run` is a good hint and a bad gate — the test in the brief's gate puts a
foreign `node.exe` in the way deliberately.

### 2. `golem ps --prune`

Removes what it can prove is Golem's AND is not serving a live session. The
dangerous case is the one this task was born from: an agent looked at a 13-hour-old
`mcp serve` and called it stale, and it turned out to belong to a second Claude
Code window that was still open. **Parentage is the evidence** — walk to the
owning `claude.exe`/`cmd.exe` and check it is alive. Never infer death from age.

### 3. An idle timeout for project proxies

`proxy.idle_timeout` (unset = never, which is today's behaviour) so a proxy
started for a project nobody has touched in three days exits on its own. Unset
by default: somebody's long-running setup must not change under them because we
tidied up.

## Labelling them in Task Manager — what is actually possible

Investigated 2026-09-13; record the answer so it is not re-derived:

- The image name is `node.exe` and cannot be changed without shipping a renamed
  Node binary. Not worth it.
- Node's `process.title` sets the **console window title** on Windows, not the
  image name. A detached daemon has no console, so Task Manager's Details tab
  shows nothing new. It does not solve this.
- A **Job Object** can group them but Task Manager does not surface job
  membership, so it buys nothing for the user's actual question.
- What DOES work today, with no code: Task Manager → Details → right-click the
  column headers → add **Command line**. Every Golem process then reads
  `...main.js statusline`, `main.js proxy start --dir <project>`.

So the deliverable is `golem ps`, not a Task Manager trick. Document the
Command-line column in the same wiki page.

## Out of scope

The statusline leak itself (fixed, PR #194) and the orphaned
`cygwin-console-helper.exe` / `conhost.exe` pairs — 40 of each on the user's
machine, oldest 73 hours, every one orphaned. **Those are Claude Code's Bash tool
leftovers, not Golem's**, and nothing in this repository can clean them up. Say
so in the wiki page so the next person measuring does not chase them.

## Verification bar

The standing one: `npx tsc --noEmit`, `npm run lint`, `npm run format:check`,
`npx vitest run`, plus `golem wiki check` if a wiki page changed.

## Outcome

shipped
