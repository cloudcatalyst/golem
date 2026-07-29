/**
 * Commander-free handlers for the commands Claude Code invokes constantly.
 *
 * `golem hook post-tool-use` and `golem hook pre-tool-use` run on EVERY tool call;
 * `golem statusline` renders on every prompt. Routed through commander they each
 * paid `./program.js`'s ~725ms module graph — far more, in aggregate, than the
 * panel's startup ever cost. Here they load only their own handler
 * (`hooks/pre-tool-use.js` ~127ms, `cli/statusline.js` ~142ms) and nothing else.
 *
 * **These MUST stay behaviourally identical to the commander versions.** Each one
 * mirrors its counterpart in `src/hooks/command.ts` / `program.ts` exactly: same
 * flags, same fail-safe swallowing, same exit code. Only events whose handlers take
 * **no CLI-injected dependencies** live here — `web-fetch-pre`/`web-fetch-post`
 * (which need `buildKnowledge` / `fetchRaw` / `revalidate`) and `session-start`
 * (which drives the proxy daemon) deliberately stay on the commander path.
 * `tests/unit/cli-fast-path.test.ts` guards that boundary.
 *
 * Everything is imported dynamically so that dispatching to one event never loads
 * another's dependencies.
 */

const stdio = () => ({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });

/**
 * Hook events handled here. Anything else — including a future event — falls
 * through to commander, which is the safe default.
 */
export const FAST_HOOK_EVENTS: readonly string[] = [
  "pre-tool-use",
  "post-tool-use",
  "prompt-submit",
  "notification",
];

/**
 * Does this argv have a fast path? Only exact, flag-compatible shapes qualify;
 * `--help` and anything unrecognised must reach commander so its output and error
 * messages stay authoritative.
 */
export function fastPathFor(argv: readonly string[]): "hook" | "statusline" | null {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) return null;
  const [first, second] = args;
  if (first === "statusline") {
    // Only the documented flag; anything else goes the long way.
    const rest = args.slice(1);
    return rest.every((a) => a === "--color") ? "statusline" : null;
  }
  if (first === "hook" && second !== undefined && FAST_HOOK_EVENTS.includes(second)) {
    const rest = args.slice(2);
    if (rest.length === 0) return "hook";
    // `post-tool-use --max-inline-chars <n>` is the only flag any of these take.
    if (second === "post-tool-use" && rest.length === 2 && rest[0] === "--max-inline-chars") {
      return "hook";
    }
    return null;
  }
  return null;
}

/** Run the fast path chosen by {@link fastPathFor}. */
export async function runFastPath(
  kind: "hook" | "statusline",
  argv: readonly string[],
): Promise<void> {
  if (kind === "statusline") return runStatusline(argv);
  return runHook(argv);
}

/** Mirrors the `statusline` action in program.ts. Must never throw or hang. */
async function runStatusline(argv: readonly string[]): Promise<void> {
  try {
    const forceColor = argv.slice(2).includes("--color");
    const raw = process.stdin.isTTY
      ? ""
      : await new Promise<string>((resolve) => {
          const chunks: Buffer[] = [];
          process.stdin.on("data", (c: Buffer) => chunks.push(c));
          process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          process.stdin.on("error", () => resolve(""));
        });
    const { collectGolemState, parseSessionInput, renderStatusLine } = await import(
      "./statusline.js"
    );
    const session = parseSessionInput(raw);
    const dir = session.cwd ?? process.cwd();
    const golem = await collectGolemState(dir);
    const color = forceColor || (process.stdout.isTTY === true && !process.env.NO_COLOR);
    process.stdout.write(`${renderStatusLine(session, golem, { color })}\n`);
  } catch {
    process.stdout.write("⬢ golem\n");
  }
}

/** Mirrors the matching sub-command in src/hooks/command.ts, event by event. */
async function runHook(argv: readonly string[]): Promise<void> {
  const args = argv.slice(2);
  const event = args[1];

  switch (event) {
    case "pre-tool-use": {
      try {
        const { runPreToolUseHook } = await import("../hooks/pre-tool-use.js");
        process.exitCode = await runPreToolUseHook(stdio());
      } catch {
        process.exitCode = 0; // fail-safe → native prompt, never auto-allow
      }
      return;
    }
    case "post-tool-use": {
      // program.ts passes no PostToolUseOptions field (`maxInlineChars`, `redact`,
      // `projectDir`) into buildHookCommand — its injections are all web-fetch
      // ones — and runPostToolUseHook defaults `redact` to `pipelineRedact`
      // internally. So `{}` here is exactly what the commander path produces.
      // A test asserts that call site stays free of those fields.
      const runtime: { maxInlineChars?: number } = {};
      const flagIndex = args.indexOf("--max-inline-chars");
      if (flagIndex !== -1) {
        const parsed = Number(args[flagIndex + 1]);
        if (Number.isInteger(parsed) && parsed > 0) runtime.maxInlineChars = parsed;
      }
      let code = 0;
      try {
        const { runPostToolUseHook } = await import("../hooks/post-tool-use.js");
        code = await runPostToolUseHook(stdio(), runtime);
      } catch (err) {
        // Fail-safe: never break the session over a hook crash.
        process.stderr.write(
          `golem hook post-tool-use: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        code = 0;
      }
      process.exitCode = code;
      return;
    }
    case "prompt-submit": {
      try {
        const { runUserPromptSubmitHook } = await import("../hooks/session-hooks.js");
        process.exitCode = await runUserPromptSubmitHook(stdio(), new Date().toISOString());
      } catch {
        process.exitCode = 0; // fail-safe
      }
      return;
    }
    case "notification": {
      try {
        const { runNotificationHook } = await import("../hooks/session-hooks.js");
        process.exitCode = await runNotificationHook(stdio(), new Date().toISOString());
      } catch {
        process.exitCode = 0; // fail-safe
      }
      return;
    }
    default: {
      // Unreachable via fastPathFor; defensive so a mismatch degrades to the CLI
      // rather than silently doing nothing.
      const { runCli } = await import("./program.js");
      await runCli(argv);
    }
  }
}
