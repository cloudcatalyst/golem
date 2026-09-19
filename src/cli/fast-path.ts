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
  "permission-request",
  "host-gate",
  "post-tool-use",
  "prompt-submit",
  "notification",
  "question-answered",
];

/**
 * Does this argv have a fast path? Only exact, flag-compatible shapes qualify;
 * `--help` and anything unrecognised must reach commander so its output and error
 * messages stay authoritative.
 */
export function fastPathFor(argv: readonly string[]): "hook" | "statusline" | "status" | null {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) return null;
  const [first, second] = args;
  // R10.10: the VS Code extension polls `status --json` and `stats --json` on a
  // timer, four CLI spawns at a time against an 8s timeout that renders a miss
  // as "offline". Measured: `program.js` is ~2146ms to load where `status.js` is
  // ~526ms, so routing these through commander cost ~1.6s per poll for nothing —
  // the JSON path never touches the command registry. Only the exact
  // machine-readable shapes qualify; a human-facing `golem status` still goes the
  // long way, because its renderer is commander's business.
  //
  // `stats --json` deliberately stays on commander despite being the SLOWER of
  // the two: its plain path branches on telemetry aggregation and a
  // `hasRequests` fallback, and duplicating that here would be exactly the drift
  // this file's "behaviourally identical" rule exists to prevent. It is also not
  // the call that matters — a null `stats` blanks the savings figure, while a
  // null `status` is what renders the bar as OFFLINE.
  if (first === "status" && args.includes("--json") && statusFlagsOk(args.slice(1))) {
    return "status";
  }
  if (first === "statusline") {
    // Only the documented flag; anything else goes the long way.
    const rest = args.slice(1);
    return rest.every((a) => a === "--color") ? "statusline" : null;
  }
  if (first === "hook" && second !== undefined && FAST_HOOK_EVENTS.includes(second)) {
    const rest = args.slice(2);
    if (rest.length === 0) return "hook";
    // Two of these take exactly one flag; nothing else does.
    if (second === "post-tool-use" && rest.length === 2 && rest[0] === "--max-inline-chars") {
      return "hook";
    }
    // R13.3: `host-gate --session <id>` runs on EVERY tool call of a hosted
    // session, so it earns the fast path for the same reason pre-tool-use does.
    if (second === "host-gate" && rest.length === 2 && rest[0] === "--session") {
      return "hook";
    }
    return null;
  }
  return null;
}

/** Run the fast path chosen by {@link fastPathFor}. */
export async function runFastPath(
  kind: "hook" | "statusline" | "status",
  argv: readonly string[],
): Promise<void> {
  if (kind === "statusline") return runStatusline(argv);
  if (kind === "status") return runStatusJson(argv);
  return runHook(argv);
}

/**
 * Only flags whose handling is identical on the fast path. Anything else — an
 * unknown flag, a typo, a future option — falls through to commander so its
 * parsing and error message stay authoritative. Deliberately strict: a fast path
 * that silently ignores a flag is worse than one that never runs.
 */
function statusFlagsOk(rest: readonly string[]): boolean {
  const allowed = ["--json", "--dir"];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined || !allowed.includes(arg)) return false;
    // `--dir` and `--window` take a value; `--json` does not.
    if (arg !== "--json") {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("-")) return false;
      i += 1;
    }
  }
  return true;
}

/** The value of a `--flag <value>` pair, or undefined. */
function flagValue(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

/** Mirrors the `status --json` action in commands/status-update.ts. */
async function runStatusJson(argv: readonly string[]): Promise<void> {
  const args = argv.slice(2);
  const [{ collectStatus }, { VERSION }, { findProjectDir }] = await Promise.all([
    import("./status.js"),
    import("../version.js"),
    import("../config/paths.js"),
  ]);
  const dir = flagValue(args, "--dir") ?? findProjectDir(process.cwd()) ?? process.cwd();
  const report = await collectStatus({ projectDir: dir, version: VERSION });
  process.stdout.write(`${JSON.stringify(report, null, 2)}
`);
}

/**
 * How long to wait for the session JSON before rendering without it. Generous for
 * a local pipe written at spawn time, short enough that a stuck read cannot
 * outlive the ~2s re-render tick that produced it.
 */
const STATUSLINE_STDIN_TIMEOUT_MS = 1_000;

/**
 * Read the session JSON from stdin, and NEVER wait forever for it.
 *
 * Claude Code spawns `golem statusline` on a ~2s re-render timer and writes the
 * session JSON immediately — but it does not reliably close the pipe afterwards.
 * The previous unbounded read waited on an `end` that never came: the promise
 * never settled, the process never exited, and every tick leaked another one.
 * Observed 2026-09-13 on this machine: **264** live `main.js statusline`
 * processes, the oldest three days old, together holding 9.2 GB — enough to push
 * process creation machine-wide to seconds per spawn, which then also starved the
 * PostToolUse hook and the VS Code extension's `status --json` poll.
 *
 * Two independent guards, because either alone leaves a way to hang:
 *
 *  1. Resolve as soon as the buffer parses as a complete JSON value. In the
 *     normal case this returns the instant the payload lands, so the common path
 *     never depends on EOF *or* on the timer.
 *  2. Otherwise resolve on `end`, on `error`, or when the timer expires —
 *     whichever comes first — with whatever arrived.
 *
 * On settle stdin is detached AND released, so a still-open handle cannot keep the
 * event loop alive after the line has been written.
 *
 * `stream` is injected so the guarantee is testable without spawning a process;
 * production always passes `process.stdin`.
 */
/**
 * `unknown[]` rather than a narrower `(chunk: Buffer)`: node types `on` as
 * `(...args: any[]) => void`, and only a listener parameter at least as wide as
 * `any` leaves `process.stdin` assignable to this interface at all.
 */
type StreamListener = (...args: unknown[]) => void;

export interface SessionStdin {
  isTTY?: boolean | undefined;
  on(event: string, listener: StreamListener): unknown;
  off(event: string, listener: StreamListener): unknown;
  pause?(): unknown;
  unref?(): unknown;
  destroy?(): unknown;
}

export async function readSessionStdin(
  stream: SessionStdin = process.stdin,
  timeoutMs = STATUSLINE_STDIN_TIMEOUT_MS,
): Promise<string> {
  if (stream.isTTY === true) return "";
  return await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const text = (): string => Buffer.concat(chunks).toString("utf8");
    const done = (value: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off("data", onData as StreamListener);
      stream.off("end", onEnd as StreamListener);
      stream.off("error", onError as StreamListener);
      // `pause()` alone does NOT release the handle: on Windows an unclosed pipe
      // keeps the event loop alive, so the line renders and the process still
      // never exits — which is the leak, just one step later. Measured: with
      // pause() only, the process was still alive 20s after writing its output.
      // `collectGolemState` leaves no handles of its own, so releasing stdin is
      // all that stands between a rendered line and a clean exit.
      stream.pause?.();
      stream.unref?.();
      stream.destroy?.();
      resolve(value);
    };
    const onData = (c: Buffer): void => {
      chunks.push(c);
      // Complete payload already in hand — don't wait on a pipe that may never close.
      const soFar = text();
      try {
        JSON.parse(soFar);
        done(soFar);
      } catch {
        /* partial JSON — keep reading until EOF or the timer */
      }
    };
    const onEnd = (): void => done(text());
    const onError = (): void => done("");
    const timer = setTimeout(() => done(text()), timeoutMs);
    stream.on("data", onData as StreamListener);
    stream.on("end", onEnd as StreamListener);
    stream.on("error", onError as StreamListener);
  });
}

/** The only `statusline` implementation — there is no commander mirror. Must never throw or hang. */
async function runStatusline(argv: readonly string[]): Promise<void> {
  // Last-resort watchdog. Deliberately NEVER cleared: it is `unref`'d, so it
  // cannot hold the process open by itself and dies with a healthy process that
  // exits in its usual ~300ms. It only ever fires if something has wedged — which
  // is precisely when we want it. Clearing it on the happy path (the obvious
  // shape) would have disarmed the one guard that makes a repeat leak impossible.
  setTimeout(() => process.exit(0), 5_000).unref();
  try {
    const forceColor = argv.slice(2).includes("--color");
    const raw = await readSessionStdin();
    const { collectGolemState, parseSessionInput, renderStatusLine } = await import(
      "./statusline.js"
    );
    const session = parseSessionInput(raw);
    const dir = session.cwd ?? process.cwd();
    const golem = await collectGolemState(dir);
    const color = forceColor || (process.stdout.isTTY === true && !process.env.NO_COLOR);
    // The brand is painted from the Golem hex palette, so the line needs the
    // terminal's colour DEPTH, not just a yes/no. Undetectable depth while
    // colour is ON means `--color` was passed into something that is not a TTY
    // (`detectColorLevel` returns 0 for a pipe before it looks at COLORTERM) —
    // assume 24-bit there, because whatever reads a forced-colour line is a
    // renderer, not a 1980s terminal.
    const { detectColorLevel } = await import("../tui/ansi.js");
    const detected = detectColorLevel();
    const colorLevel = !color ? 0 : detected === 0 ? 3 : detected;
    // `process.stdout.columns` is undefined on a pipe (the normal case — Claude
    // Code captures this as text, not a TTY); `COLUMNS` covers a shell that
    // exports it anyway. Neither known means the line never truncates.
    const envColumns = Number(process.env.COLUMNS);
    const columns =
      process.stdout.columns ??
      (Number.isFinite(envColumns) && envColumns > 0 ? envColumns : undefined);
    process.stdout.write(
      `${renderStatusLine(session, golem, { color, colorLevel, ...(columns !== undefined ? { columns } : {}) })}\n`,
    );
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
    case "permission-request": {
      // R12.12 — fires only when a permission decision is pending, i.e. with a
      // human already waiting. Commander's ~725ms module graph is the difference
      // between resolving the request and losing the race to the dialog it
      // exists to pre-empt.
      try {
        const { runPermissionRequestHook } = await import("../hooks/permission-request.js");
        process.exitCode = await runPermissionRequestHook(stdio());
      } catch {
        process.exitCode = 0; // fail-safe → native prompt, never auto-allow
      }
      return;
    }
    case "host-gate": {
      // R13.3 — fail CLOSED, the opposite of the guest hooks below: a hosted
      // session has no human permission flow to fall back to, so a crash here
      // must refuse the call rather than let it run unsupervised.
      const at = args.indexOf("--session");
      const sessionId = at === -1 ? undefined : args[at + 1];
      try {
        const { runHostGateHook } = await import("../hooks/host-gate.js");
        process.exitCode = await runHostGateHook(
          stdio(),
          sessionId !== undefined ? { sessionId } : {},
        );
      } catch {
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
    case "question-answered": {
      try {
        const { runQuestionAnsweredHook } = await import("../hooks/session-hooks.js");
        process.exitCode = await runQuestionAnsweredHook(stdio(), new Date().toISOString());
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
