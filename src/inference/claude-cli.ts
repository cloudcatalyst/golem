/**
 * R9.15 — drafting on the user's own Claude Code subscription, legitimately.
 *
 * Asked whether `coder` could spend the quota the user already has rather than
 * pay-as-you-go API credit. Two routes exist; only one is honest.
 *
 * REJECTED: read Claude Code's OAuth credential out of its store, or replay the
 * `authorization` header Golem's proxy already sees, and originate new requests
 * with it. Forwarding the user's own requests is Golem's job. Minting requests
 * Claude Code never made, on the credential issued to it, is not — and spec 267
 * already says account switching must be user-initiated and transparent, never
 * covert evasion of limits. Golem never reads, copies or forwards a Claude Code
 * credential, here or anywhere.
 *
 * SHIPPED: spawn the official client headlessly and let it authenticate itself.
 * Official binary, official auth, official quota accounting, nothing extracted.
 * Decision 53's shape — external tools are spawned or detected, never shipped,
 * and never impersonated.
 *
 * The three properties this module owns:
 *
 * 1. The prompt travels on STDIN, never argv. The only variable argument is the
 *    model id, which is validated. Nothing a model wrote reaches a command line,
 *    which is also what makes the Windows `.cmd` path below safe.
 * 2. The environment is SCRUBBED. `ANTHROPIC_*` goes, so the child talks direct
 *    to Anthropic on its own OAuth rather than looping back through Golem's own
 *    proxy via `ANTHROPIC_BASE_URL` — which would both misroute the draft and
 *    invite re-entrancy. `GOLEM_*` goes so that a credential resolved for some
 *    other target cannot ride along.
 * 3. It is a TEXT CALL, not an agent: no session persistence, no MCP, no file or
 *    exec tools, and a temp working directory, so no `CLAUDE.md`, no hooks and
 *    no project state are discovered.
 */

import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { commandOnPath } from "../pkg/detect.js";

/** Minimal shape of `child_process.spawn`, so a test can inject one. */
export type SpawnLike = typeof spawn;

/** A spawned draft that failed in a way the caller should surface verbatim. */
export class ClaudeCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeCliError";
  }
}

export interface ClaudeCliOptions {
  /** Executable name or path; resolved on PATH (Windows `PATHEXT`-aware). */
  readonly command?: string;
  /** Where to run. Defaults to a fresh temp dir, so no project state is read. */
  readonly cwd?: string;
  /** Wall-clock cap for one draft. */
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly spawnImpl?: SpawnLike;
  /** Injectable for tests; defaults to the PATHEXT-aware resolver. */
  readonly resolveCommand?: (
    name: string,
    env: Readonly<Record<string, string | undefined>>,
  ) => string | null;
}

/**
 * Model ids we are willing to place on a command line. The prompt goes on stdin
 * precisely so argv carries nothing a model chose; the model id comes from
 * settings, but it is still the one variable argument, so it is checked.
 */
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * Whether an environment key is withheld from the child.
 *
 * `ANTHROPIC_*` sweeps up `ANTHROPIC_BASE_URL` (the loop back into Golem), the
 * Foundry pair, and `ANTHROPIC_API_KEY`. Dropping the last is deliberate: this
 * route exists to spend the SUBSCRIPTION, so leaving a key in scope would make
 * which quota gets billed depend on the user's shell.
 */
function isWithheldEnvKey(key: string): boolean {
  return key.startsWith("ANTHROPIC_") || key.startsWith("GOLEM_") || key === "ENABLE_TOOL_SEARCH";
}

/** `env` minus Golem's and Anthropic's wiring. */
export function scrubbedEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || isWithheldEnvKey(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * The fixed argument list. `--print` is headless mode; everything after it makes
 * this a text call rather than an agent session (see the module header).
 */
export function claudeCliArgs(model: string): string[] {
  return [
    "--print",
    "--model",
    model,
    "--output-format",
    "text",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--disallowed-tools",
    "Bash Edit Write Read Glob Grep WebFetch WebSearch Task",
  ];
}

/**
 * Spawn the CLI, write `prompt` to stdin, return stdout.
 *
 * On Windows a `.cmd`/`.bat` shim cannot be spawned directly (Node refuses since
 * the argument-injection fix), so it runs through `cmd.exe /c` — still as an
 * argument ARRAY, and still with the prompt on stdin, so there is no command
 * line for the prompt to escape from.
 */
export async function draftWithClaudeCli(
  prompt: string,
  model: string,
  options: ClaudeCliOptions = {},
): Promise<string> {
  if (!SAFE_MODEL.test(model)) {
    throw new ClaudeCliError(
      `refusing to spawn the Claude Code CLI with model "${model}": a model id may contain ` +
        "only letters, digits, dot, underscore, colon and dash.",
    );
  }
  const env = options.env ?? process.env;
  const resolveExe = options.resolveCommand ?? commandOnPath;
  const name = options.command ?? "claude";
  const exe = resolveExe(name, env);
  if (exe === null) {
    throw new ClaudeCliError(
      `the Claude Code CLI ("${name}") is not on PATH, so there is no session to draft in. ` +
        "Install Claude Code, or route this worker to another target.",
    );
  }

  const cwd = options.cwd ?? (await mkdtemp(path.join(os.tmpdir(), "golem-claude-cli-")));
  const spawnImpl = options.spawnImpl ?? spawn;
  const timeoutMs = options.timeoutMs ?? 180_000;
  const lower = exe.toLowerCase();
  const viaCmd = process.platform === "win32" && (lower.endsWith(".cmd") || lower.endsWith(".bat"));
  const file = viaCmd ? "cmd.exe" : exe;
  const argv = viaCmd ? ["/c", exe, ...claudeCliArgs(model)] : claudeCliArgs(model);

  return await new Promise<string>((settle, reject) => {
    const child = spawnImpl(file, argv, {
      cwd,
      env: scrubbedEnv(env),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(
        new ClaudeCliError(
          `the Claude Code CLI did not answer within ${timeoutMs}ms. A spawned draft is a whole ` +
            "session start; raise the timeout or route this worker elsewhere.",
        ),
      );
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ClaudeCliError(`could not spawn the Claude Code CLI: ${err.message}`));
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        // The TAIL of stderr, not the head: the useful line is the last one.
        const tail = stderr.trim().split("\n").slice(-4).join("\n");
        reject(
          new ClaudeCliError(
            `the Claude Code CLI exited ${code ?? "with no code"}${tail === "" ? "" : `: ${tail}`}`,
          ),
        );
        return;
      }
      if (stdout.trim() === "") {
        reject(new ClaudeCliError("the Claude Code CLI returned no text."));
        return;
      }
      settle(stdout.trim());
    });

    // The prompt NEVER becomes an argument. That is the whole safety property.
    child.stdin?.end(prompt);
  });
}

/**
 * The drafter the target dispatcher calls for a `claude-cli` target.
 *
 * Bound here rather than inside the dispatcher so policy (the guards, redaction,
 * audit) and mechanism (spawning a process) stay in separate modules — and so a
 * test can exercise the policy without a child process.
 */
export function createClaudeCliDrafter(
  options: ClaudeCliOptions = {},
): (input: { readonly prompt: string; readonly model: string }) => Promise<string> {
  return async ({ prompt, model }) => await draftWithClaudeCli(prompt, model, options);
}
