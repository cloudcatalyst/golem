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
import type { KnowledgeBase } from "../interfaces/knowledge.js";
import { runHostGateHook } from "./host-gate.js";
import { runPermissionRequestHook } from "./permission-request.js";
import { type PostToolUseOptions, runPostToolUseHook } from "./post-tool-use.js";
import { runPreToolUseHook } from "./pre-tool-use.js";
import { runNotificationHook, runUserPromptSubmitHook } from "./session-hooks.js";
import { runWebFetchPost, runWebFetchPre, type WebFetchHookOptions } from "./web-fetch.js";

const stdio = () => ({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });

/** Extra wiring the CLI injects (KB builder for the web-fetch capture hook). */
export interface HookCommandOptions extends PostToolUseOptions {
  /** Builds a KB for a project dir — cli passes buildKnowledgeStack; avoids a hooks→cli import. */
  readonly buildKnowledge?: (projectDir: string) => Promise<KnowledgeBase | null>;
  /** Web-cache freshness window (hours); from config. */
  readonly webCacheTtlHours?: number;
  /** Conditional-revalidation fetcher for cached URLs (cli injects defaultRevalidate). */
  readonly revalidate?: WebFetchHookOptions["revalidate"];
  /** Per-project gate for `revalidate` (cli reads `knowledge.webcache_revalidate`). */
  readonly revalidateEnabled?: WebFetchHookOptions["revalidateEnabled"];
  /** Raw-page fetcher (cli injects fetchRawPage) — Decision 42. */
  readonly fetchRaw?: WebFetchHookOptions["fetchRaw"];
  /** Per-project gate for `fetchRaw` (cli reads `knowledge.webcache_fetch_raw`). */
  readonly fetchRawEnabled?: WebFetchHookOptions["fetchRawEnabled"];
}

/** Build the `hook` command group with the `post-tool-use` sub-command. */
export function buildHookCommand(options: HookCommandOptions = {}): Command {
  const hook = new Command("hook").description("Golem Claude Code hook handlers");

  hook
    .command("notification")
    .description("Notification handler: record that the session is waiting on the human")
    .action(async () => {
      try {
        process.exitCode = await runNotificationHook(stdio(), new Date().toISOString());
      } catch {
        process.exitCode = 0; // fail-safe
      }
    });

  hook
    .command("prompt-submit")
    .description("UserPromptSubmit handler: clear the blocked flag once the human responds")
    .action(async () => {
      try {
        process.exitCode = await runUserPromptSubmitHook(stdio(), new Date().toISOString());
      } catch {
        process.exitCode = 0; // fail-safe
      }
    });

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

  hook
    .command("pre-tool-use")
    .description(
      "PreToolUse handler: R5.4 autonomy gate (allow/ask per the project's autonomy level)",
    )
    .action(async () => {
      try {
        process.exitCode = await runPreToolUseHook(stdio());
      } catch {
        process.exitCode = 0; // fail-safe → native prompt, never auto-allow
      }
    });

  hook
    .command("host-gate")
    .description(
      "PreToolUse handler for a HOSTED session (R13.3): refuses destructive/outward outright",
    )
    .option("--session <id>", "the hosted session id, for attributable log lines")
    .action(async (opts: { session?: string }) => {
      try {
        process.exitCode = await runHostGateHook(
          stdio(),
          opts.session !== undefined ? { sessionId: opts.session } : {},
        );
      } catch {
        // Fail-CLOSED, unlike the guest hooks: there is no human permission flow
        // to fall back to in a hosted session. runHostGateHook already emits a
        // deny envelope on its own error path; this is the last resort.
        process.stdout.write(
          `${JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason:
                "Refused by the Golem session host: the host gate crashed, so the call was denied rather than run unsupervised.",
            },
          })}
`,
        );
        process.exitCode = 0;
      }
    });

  hook
    .command("permission-request")
    .description(
      "PermissionRequest handler: R12.12 — deny destructive/outward before a dialog can open",
    )
    .action(async () => {
      try {
        process.exitCode = await runPermissionRequestHook(stdio());
      } catch {
        process.exitCode = 0; // fail-safe → native prompt, never auto-allow
      }
    });

  const webFetchOpts = (): WebFetchHookOptions => ({
    ...(options.buildKnowledge !== undefined ? { buildKnowledge: options.buildKnowledge } : {}),
    ...(options.webCacheTtlHours !== undefined ? { ttlHours: options.webCacheTtlHours } : {}),
    ...(options.redact !== undefined ? { redact: options.redact } : {}),
    ...(options.revalidate !== undefined ? { revalidate: options.revalidate } : {}),
    ...(options.revalidateEnabled !== undefined
      ? { revalidateEnabled: options.revalidateEnabled }
      : {}),
    ...(options.fetchRaw !== undefined ? { fetchRaw: options.fetchRaw } : {}),
    ...(options.fetchRawEnabled !== undefined ? { fetchRawEnabled: options.fetchRawEnabled } : {}),
  });

  hook
    .command("web-fetch-pre")
    .description("PreToolUse(WebFetch): serve a fresh cached URL from the KB, skipping the fetch")
    .action(async () => {
      try {
        process.exitCode = await runWebFetchPre(stdio(), webFetchOpts());
      } catch {
        process.exitCode = 0; // fail-open
      }
    });

  hook
    .command("web-fetch-post")
    .description("PostToolUse(WebFetch): capture the fetched page into the KB + web cache")
    .action(async () => {
      try {
        process.exitCode = await runWebFetchPost(stdio(), webFetchOpts());
      } catch {
        process.exitCode = 0; // fail-safe
      }
    });

  return hook;
}
