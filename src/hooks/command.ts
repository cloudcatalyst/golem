/**
 * `golem hook post-tool-use` sub-command (WS-B task B2).
 *
 * The integrator wires this into the CLI (src/cli/main.ts is owned by another
 * agent — this module never edits it). See src/hooks/index.ts for the exact
 * one-liner.
 *
 * The command is a thin adapter over {@link runPostToolUseHook}: it feeds the
 * process's real stdin/stdout/stderr and forwards the returned exit code. Any
 * unexpected throw is swallowed to exit 0 so the hook can never break a
 * Claude Code session (fail-safe policy — see post-tool-use.ts).
 */

import process from "node:process";
import { Command } from "commander";
import { type PostToolUseOptions, runPostToolUseHook } from "./post-tool-use.js";

/** Build the `hook` command group with the `post-tool-use` sub-command. */
export function buildHookCommand(options: PostToolUseOptions = {}): Command {
  const hook = new Command("hook").description("Golem Claude Code hook handlers");

  hook
    .command("post-tool-use")
    .description("PostToolUse handler: swap oversized tool outputs for Golem CCR refs")
    .option("--max-inline-chars <n>", "override the inline-size threshold (characters)")
    .action(async (opts: { maxInlineChars?: string }) => {
      const runtime: PostToolUseOptions = { ...options };
      if (opts.maxInlineChars !== undefined) {
        const parsed = Number(opts.maxInlineChars);
        if (Number.isInteger(parsed) && parsed > 0) {
          (runtime as { maxInlineChars?: number }).maxInlineChars = parsed;
        }
      }
      let code = 0;
      try {
        code = await runPostToolUseHook(
          {
            stdin: process.stdin,
            stdout: process.stdout,
            stderr: process.stderr,
          },
          runtime,
        );
      } catch (err) {
        // Fail-safe: never break the session over a hook crash.
        process.stderr.write(
          `golem hook post-tool-use: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        code = 0;
      }
      process.exitCode = code;
    });

  return hook;
}
