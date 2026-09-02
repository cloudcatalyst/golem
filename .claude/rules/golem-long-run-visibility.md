<!-- Managed by Golem — remove with `golem guidance disable long-run-visibility` -->

## Golem: a long run must SHOW that it is running

The harness shows a working indicator only while a turn is active. A detached
background command is not the turn, so a multi-minute run leaves the session
looking idle — the user cannot tell the difference between working and hung.

1. **Use `golem verify` for the green-check gate** rather than hand-rolling a
   shell loop. It prints its log path FIRST, emits one `golem-verify:` line per
   check, builds the repo under test before checks that read `dist/`, and is
   judged by exit code. A hand-rolled runner is how a log landed in the repo
   root and how a generated file got rebuilt by a stale global install.
2. **Stream anything over ~30s** — but watch for FAILURES and the final
   verdict, not for every step. A notification per check costs a turn each
   and buries the result; the status line already carries per-step progress
   at 2s resolution for free. Filter to the lines you would act on.
3. **Name the log path** in your own message, so the user can follow along
   without asking you.

While a `golem verify` run is in flight, `golem statusline` shows it live —
the status line re-runs on a 2s timer, so it ticks even when the session is
idle. That is the only surface that does.
