/**
 * headroom-adapter.ts — the ONE place Golem knows about Headroom (CLAUDE.md
 * hard rule: "any Headroom client imports live only in headroom-adapter.ts").
 * It manages persistent Python workers that keep Headroom's pipelines warm,
 * communicating over local HTTP, and exposes them to the rest of Golem only
 * through neutral seams:
 *
 * - {@link HeadroomSidecar} implements {@link SemanticCompressor} (slider ≥3
 *   semantic compression, spec Decision 18/23).
 * - {@link HeadroomMemorySidecar} implements {@link MemorySearchProvider}
 *   (R3.6 MEMORY-scope federated search, spec Decisions 13/18).
 *
 * Architecture (verification-notes §34): we do NOT chain `headroom proxy` (it is
 * a competing Anthropic forwarder); each worker calls into `headroom` in-process
 * and Golem keeps the redaction-first, byte-faithful forward. Workers are
 * launched via `uv run --with <pin>` by default — an OPT-IN dependency, never
 * in Golem's core install (CLAUDE.md: no heavyweight deps by default).
 *
 * The two sidecars are independently opt-in, independently launched processes,
 * NOT one shared process: `HeadroomMemorySidecar` needs the `[memory]` extra
 * (sentence-transformers, transitively torch — verification-notes §4), a much
 * heavier install than bare compression's `headroom-ai`, so a user must choose
 * to install it separately from `compression.headroom_sidecar`. They share only
 * the process-management plumbing (`HeadroomWorkerProcess`, private to this
 * module) and the PyPI version pin.
 *
 * Fail-open everywhere: if a worker can't start, dies, or errors on a request,
 * the public method resolves `null` so the caller skips the stage/contributes
 * nothing. Nothing here can break a request or a search.
 *
 * The exact PyPI pin lives in ./index.ts (CLAUDE.md); it is read lazily at spawn
 * time so this module never bumps or hardcodes it.
 */

import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { request } from "undici";
import { HEADROOM_SIDECAR_PYPI_PIN } from "./index.js";
import type { MemoryFact, MemorySearchProvider } from "./memory-search.js";
import type { SemanticCompressor, SemanticMode, SemanticResult } from "./semantic.js";

/** Line every worker prints on stdout once listening (carries the bound port). */
const LISTENING_RE = /GOLEM_HEADROOM_LISTENING (\d+)/;

/**
 * Set on every worker we spawn, telling it to exit the moment its stdin pipe
 * reaches EOF (R10.3).
 *
 * This is the ONE mechanism that makes orphaning structurally impossible rather
 * than merely handled. Golem's proxy daemon is stopped with `process.kill(pid)`,
 * which on Windows is `TerminateProcess` — Node's *emulated* SIGTERM handler in
 * the target is never invoked by an external kill, so the daemon's `shutdown`
 * function does not run, and anything that relied on it did not happen. Nothing
 * inside the dying parent can be trusted to run; what CAN be trusted is the
 * kernel closing its handles. The worker holds the read end of a pipe whose only
 * write end lives in the daemon, so the daemon's death — clean exit, SIGKILL,
 * TerminateProcess, or a power-off-grade crash — closes that pipe and the worker
 * sees EOF.
 *
 * Gated behind this env var so a worker run by hand (stdin a terminal, or
 * `/dev/null`, which reads EOF immediately) does not exit on startup.
 */
const PARENT_PIPE_ENV = "GOLEM_HEADROOM_PARENT_PIPE";

/**
 * Worker script basenames, used to recognise a stray worker process by its
 * command line during the start-up sweep. Both sidecars' scripts, because ONE
 * sweep reaps every kind of worker Golem can leave behind.
 */
const WORKER_SCRIPT_NAMES = ["headroom-worker.py", "headroom-memory-worker.py"] as const;

/**
 * CLI flag every worker is launched with, carrying the project it belongs to.
 * The worker ignores it — its only job is to be *visible in the command line*,
 * so the sweep can tell this project's workers from another project's. Without
 * it, a globally-installed Golem launches byte-identical command lines for every
 * project on the machine and a sweep could not safely kill any of them.
 */
const PROJECT_ARG = "--golem-project";

/** Default Anthropic model id used by the compression worker only for token counting. */
const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";

interface WorkerProcessOptions {
  readonly command: string;
  readonly launchArgs: readonly string[];
  readonly workerPath: string;
  /** Extra CLI args appended after the standard `--port 0` (e.g. `--db-path`). */
  readonly workerArgs?: readonly string[];
  readonly host: string;
  readonly startupTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly log: (message: string) => void;
  /** Base backoff in ms for worker-respawn delays (R8.30). Default 1000. */
  readonly backoffBaseMs?: number;
  /**
   * Project this worker serves. Appended to the worker's command line as
   * {@link PROJECT_ARG} so {@link reapOrphanedHeadroomWorkers} can scope a sweep
   * to one project. Omitted when unknown — the worker then simply cannot be
   * matched by project, which is the safe direction to fail.
   */
  readonly projectDir?: string;
}

/**
 * Every worker process this module has running, so ONE call
 * ({@link stopAllHeadroomWorkers}) tears down every sidecar rather than the
 * caller having to know how many classes of sidecar exist. The proxy's shutdown
 * path used to stop only the semantic one, which meant the memory sidecar leaked
 * even on a clean POSIX shutdown (R10.3).
 */
const LIVE_WORKERS = new Set<HeadroomWorkerProcess>();

/**
 * Stop every Headroom worker this process has spawned, of every kind.
 * Best-effort and synchronous, so it is safe to call from a signal handler or an
 * `exit` listener. Idempotent.
 */
export function stopAllHeadroomWorkers(): void {
  for (const worker of [...LIVE_WORKERS]) worker.stop();
}

/**
 * Kill a process tree on Windows, where killing a pid kills only that pid.
 *
 * `uv run` is not one process: it launches a Python that (via uv's Windows
 * trampoline) launches the Python that actually serves, so the pid Node holds is
 * the ancestor of the worker, not the worker. `taskkill /T` walks the tree.
 * Argument-array spawn, never a shell string (CLAUDE.md); best-effort and silent
 * — a failure here is a process we could not kill, not an error for the caller.
 */
function killProcessTreeWindows(pid: number): void {
  try {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => {
      /* taskkill missing or the pid already gone */
    });
    killer.unref();
  } catch {
    // spawn itself failed — nothing more we can do
  }
}

/**
 * Shared spawn/health/request lifecycle for a Headroom Python worker. The two
 * sidecars differ only in launch args, worker script, and which endpoint they
 * POST to — this stays private to the module so neither public class repeats
 * the process-management plumbing.
 */
class HeadroomWorkerProcess {
  readonly #command: string;
  readonly #launchArgs: readonly string[];
  readonly #workerPath: string;
  readonly #workerArgs: readonly string[];
  readonly #host: string;
  readonly #startupTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #log: (message: string) => void;
  readonly #projectDir: string | undefined;

  #child: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  #port: number | null = null;
  #startPromise: Promise<boolean> | null = null;
  /** Next-spawn timestamp — backs off after an unexpected worker death (R8.30). */
  #nextSpawnAt: number = 0;
  /** Base backoff in ms for worker-respawn delays (R8.30). Default 1000 (1s). */
  readonly #backoffBaseMs: number;
  /** Consecutive spawn failures since last successful start. */
  #spawnAttempts: number = 0;
  /** True during an explicit stop(), so the exit handler skips backoff. */
  #stopping: boolean = false;

  constructor(options: WorkerProcessOptions) {
    this.#command = options.command;
    this.#launchArgs = options.launchArgs;
    this.#workerPath = options.workerPath;
    this.#workerArgs = options.workerArgs ?? [];
    this.#host = options.host;
    this.#startupTimeoutMs = options.startupTimeoutMs;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#log = options.log;
    this.#backoffBaseMs = options.backoffBaseMs ?? 1000;
    this.#projectDir = options.projectDir;
  }

  /** True once the worker is listening and health-checked. */
  isRunning(): boolean {
    return this.#child !== null && this.#port !== null;
  }

  /**
   * Spawn the worker and wait until it is listening + healthy. Idempotent and
   * memoized; resolves `false` (never throws) if the worker cannot come up, so
   * callers can degrade gracefully.
   *
   * R8.30: after an unexpected worker death, the next spawn is delayed by an
   * exponential backoff (base → 2× → 4×, capped at 30s) instead of retrying in a
   * tight loop. A flaky Python environment then produces at most one spawn
   * attempt per backoff window instead of a burst of log noise.
   */
  start(): Promise<boolean> {
    if (this.#startPromise !== null) return this.#startPromise;
    this.#stopping = false;
    const wait = this.#nextSpawnAt - Date.now();
    if (wait > 0) {
      this.#log(`worker respawn backing off for ${Math.round(wait)}ms`);
      this.#startPromise = new Promise<boolean>((resolve) =>
        setTimeout(() => {
          this.#startPromise = null;
          resolve(this.start());
        }, wait),
      );
      return this.#startPromise;
    }
    this.#startPromise = this.#startInner().catch((err: unknown) => {
      this.#log(`failed to start: ${err instanceof Error ? err.message : String(err)}`);
      this.stop(); // kill a half-started worker so it can't linger orphaned
      return false;
    });
    return this.#startPromise;
  }

  async #startInner(): Promise<boolean> {
    // Say so when the script itself is missing, rather than spawning `uv` on a
    // path that is not there and reporting the generic startup failure that
    // comes back (R10.5).
    //
    // This is not a hypothetical: `scripts/copy-assets.mjs` shipped only one of
    // the two workers, so on every BUILT install the memory sidecar's script was
    // absent. It failed open, as designed — and said nothing recognisable, so a
    // feature that was on in config did nothing for as long as nobody looked.
    // Fail-open is unchanged (`false` here, `null` from every public method);
    // the only difference is that the user is told which of the two it is: a
    // broken install, not a missing `uv`.
    //
    // Deliberately not retried: a file that is absent at start does not appear
    // mid-run, so the memoized `false` keeps this to one message instead of one
    // per search. `stop()` clears it, so a restart re-checks.
    if (!existsSync(this.#workerPath)) {
      this.#log(
        `worker script not found at ${this.#workerPath} — this install did not ship it, so ` +
          "the sidecar is unavailable and contributes nothing. Reinstall golem-run, or run " +
          "`npm run build` if this is a source checkout.",
      );
      return false;
    }
    const args = [
      ...this.#launchArgs,
      this.#workerPath,
      "--port",
      "0",
      ...this.#workerArgs,
      ...(this.#projectDir === undefined ? [] : [PROJECT_ARG, this.#projectDir]),
    ];
    // stdin is a PIPE, deliberately: it is never written to, it exists so that
    // its closure — which the OS guarantees when this process dies, however it
    // dies — is the worker's signal to exit. See PARENT_PIPE_ENV.
    const child = spawn(this.#command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, [PARENT_PIPE_ENV]: "1" },
    });
    this.#child = child;
    LIVE_WORKERS.add(this);
    // A worker that dies on its own closes the read end; writing is never done
    // here, but an EPIPE must not become an unhandled 'error' event.
    child.stdin.on("error", () => {
      /* worker gone — the exit handler below is the one that matters */
    });
    // Do not let the idle keep-alive pipe hold a short-lived CLI's event loop
    // open. (A pipe stdio stream is a net.Socket; `unref` is not on Writable.)
    (child.stdin as unknown as { unref?: () => void }).unref?.();

    let stderrTail = "";
    child.stderr.on("data", (d: Buffer) => {
      stderrTail = `${stderrTail}${d.toString("utf8")}`.slice(-2000);
    });
    child.once("exit", (code) => {
      if (this.#port === null) {
        this.#log(`worker exited before listening (code ${code}). stderr: ${stderrTail.trim()}`);
      } else {
        // Unexpected death — set backoff so the next start() doesn't retry in a tight loop.
        if (!this.#stopping) {
          this.#spawnAttempts++;
          const delay = Math.min(this.#backoffBaseMs * 2 ** (this.#spawnAttempts - 1), 30_000);
          this.#nextSpawnAt = Date.now() + delay;
          this.#log(
            `worker died unexpectedly (code ${code}) — respawn delayed ${delay}ms (attempt ${this.#spawnAttempts})`,
          );
        }
      }
      this.#cleanup();
    });

    const port = await this.#awaitListeningPort(child);
    if (port === null) {
      // Startup timeout: the process may still be alive (e.g. a slow first
      // package download) — kill it or it lingers orphaned. Its exit event
      // then runs #cleanup, so a later request may retry a fresh start.
      // R8.30: surface the stderr tail so a "uv couldn't find Python 3.13"
      // style failure is actionable, not a generic timeout message.
      this.#log(
        stderrTail.trim()
          ? `startup timeout — stderr tail: ${stderrTail.trim()}`
          : "startup timeout (no stderr captured)",
      );
      HeadroomWorkerProcess.killChild(child);
      this.#cleanup();
      return false;
    }
    this.#port = port;

    const healthy = await this.#health();
    if (!healthy) {
      // Same orphan risk: the worker is listening but unhealthy — kill it.
      this.#log("worker did not pass health check");
      HeadroomWorkerProcess.killChild(child);
      this.#cleanup();
      return false;
    }
    // Successful start: reset the respawn backoff (R8.30).
    this.#spawnAttempts = 0;
    this.#nextSpawnAt = 0;
    this.#log(`worker ready on ${this.#host}:${port}`);
    return true;
  }

  /** Resolve the port from the worker's stdout announcement, or null on timeout/exit. */
  #awaitListeningPort(
    child: ChildProcessByStdio<Writable, Readable, Readable>,
  ): Promise<number | null> {
    return new Promise<number | null>((resolve) => {
      let buf = "";
      let settled = false;
      const done = (v: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => done(null), this.#startupTimeoutMs);
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        const m = LISTENING_RE.exec(buf);
        if (m?.[1] !== undefined) done(Number.parseInt(m[1], 10));
      });
      child.once("exit", () => done(null));
      child.once("error", () => done(null));
    });
  }

  async #health(): Promise<boolean> {
    if (this.#port === null) return false;
    try {
      const res = await request(`http://${this.#host}:${this.#port}/health`, {
        method: "GET",
        headersTimeout: 5_000,
        bodyTimeout: 5_000,
      });
      await res.body.text();
      return res.statusCode === 200;
    } catch {
      return false;
    }
  }

  /**
   * The parsed `/health` body (not just a boolean), for callers that need the
   * worker's self-report — notably `supported_config`, the field names the
   * installed Headroom accepts (Decision 53's version gate). Resolves `null` on
   * any unavailability; never throws, and never starts the worker.
   */
  async healthJson(): Promise<unknown | null> {
    if (!this.isRunning() || this.#port === null) return null;
    try {
      const res = await request(`http://${this.#host}:${this.#port}/health`, {
        method: "GET",
        headersTimeout: 5_000,
        bodyTimeout: 5_000,
      });
      const text = await res.body.text();
      if (res.statusCode !== 200) return null;
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }

  /**
   * POST `body` as JSON to `path` (lazily starting the worker if needed) and
   * parse the JSON response. Resolves `null` — never throws — on any
   * unavailability, non-200 status, or malformed response; callers layer
   * their own shape validation on top of the parsed value.
   */
  async postJson(path: string, body: unknown): Promise<unknown | null> {
    if (!this.isRunning() || this.#port === null) {
      const up = await this.start();
      if (!up || this.#port === null) return null;
    }
    try {
      const res = await request(`http://${this.#host}:${this.#port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        headersTimeout: this.#requestTimeoutMs,
        bodyTimeout: this.#requestTimeoutMs,
      });
      const text = await res.body.text();
      if (res.statusCode !== 200) {
        this.#log(`${path} returned ${res.statusCode}: ${text.slice(0, 200)}`);
        return null;
      }
      return JSON.parse(text) as unknown;
    } catch (err) {
      this.#log(`${path} error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Stop the worker (best-effort).
   *
   * Three steps, because the pid Node holds is not necessarily the process doing
   * the work (`uv run` puts one or two Python processes between them):
   *
   * 1. Close stdin. That is the EOF the worker itself watches for, so it reaches
   *    the REAL worker however deep it sits — no pid, no tree walk needed.
   * 2. Kill the direct child, which ends the launcher.
   * 3. On Windows, `taskkill /T` the child's tree, since a kill there does not
   *    propagate to descendants. Only while Node still knows the child is
   *    unreaped, so the pid is certainly still ours and cannot have been reused.
   */
  stop(): void {
    this.#stopping = true;
    if (this.#child !== null) HeadroomWorkerProcess.killChild(this.#child);
    this.#cleanup();
  }

  /**
   * Take down a spawned child and everything under it.
   *
   * Static, and used by every abandonment path — an explicit {@link stop}, a
   * startup timeout, a failed health check — because they abandon the same kind
   * of process tree and every one of them could otherwise strand the real
   * worker. The timeout path is not hypothetical: a first start that has to
   * download the package can exceed the budget while the worker is alive.
   *
   * Deliberately NOT `stop()`, so callers mid-start do not set the `#stopping`
   * flag and suppress R8.30's respawn backoff.
   */
  static killChild(child: ChildProcessByStdio<Writable, Readable, Readable>): void {
    try {
      // First, because it is the step that reaches the REAL worker however many
      // launcher processes sit in between (see PARENT_PIPE_ENV).
      child.stdin.end();
      child.stdin.destroy();
    } catch {
      // already closed
    }
    // Node has not reaped it, so the pid is certainly still this child's and
    // cannot have been recycled onto some unrelated process by the time taskkill
    // runs.
    const stillOurs = child.exitCode === null && child.signalCode === null;
    try {
      child.kill();
    } catch {
      // already gone
    }
    if (process.platform === "win32" && stillOurs && child.pid !== undefined) {
      killProcessTreeWindows(child.pid);
    }
  }

  #cleanup(): void {
    LIVE_WORKERS.delete(this);
    this.#child = null;
    this.#port = null;
    this.#startPromise = null;
  }
}

export interface HeadroomSidecarOptions {
  /** Launcher command (default "uv"). */
  readonly command?: string;
  /**
   * Args placed BEFORE the worker path. Default runs the pinned package in an
   * ephemeral uv environment: `run --python 3.13 --with headroom-ai==<pin> python`.
   */
  readonly launchArgs?: readonly string[];
  /** Override the worker script path (default: headroom-worker.py next to this module). */
  readonly workerPath?: string;
  readonly host?: string;
  /** First start may resolve+download the package — allow generous time. */
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  /** Model id passed to Headroom for token counting (default sonnet). */
  readonly model?: string;
  /**
   * Opaque `CompressConfig` overrides forwarded to the worker (Decision 53).
   *
   * Deliberately **untyped**: enumerating Headroom's config here is what made
   * every new upstream option unreachable until this file was edited, and the pin
   * is not the coupling point. Keys the installed Headroom does not accept are
   * reported back and skipped, never passed. Layered UNDER Golem's per-mode
   * presets in the worker, so a caller can override one key without replacing the
   * slider's behaviour wholesale.
   */
  readonly config?: Readonly<Record<string, unknown>>;
  /** Sink for diagnostics (default: stderr). Never stdout (would corrupt MCP stdio callers). */
  readonly log?: (message: string) => void;
  /** Base backoff in ms for worker-respawn delays (R8.30). Default 1000 (1s). */
  readonly backoffBaseMs?: number;
  /**
   * The project this sidecar serves. Stamped onto the worker's command line so a
   * later {@link reapOrphanedHeadroomWorkers} can recognise this project's
   * workers and leave every other project's alone (R10.3).
   */
  readonly projectDir?: string;
}

function defaultWorkerPath(): string {
  return fileURLToPath(new URL("./headroom-worker.py", import.meta.url));
}

function defaultLaunchArgs(): string[] {
  return [
    "run",
    "--python",
    "3.13",
    "--with",
    `headroom-ai==${HEADROOM_SIDECAR_PYPI_PIN}`,
    "python",
  ];
}

export class HeadroomSidecar implements SemanticCompressor {
  readonly #proc: HeadroomWorkerProcess;
  readonly #model: string;
  readonly #config: Readonly<Record<string, unknown>> | undefined;
  readonly #log: (message: string) => void;
  /** Ignored-key sets already reported, so a bad setting warns once, not per request. */
  readonly #warnedIgnored = new Set<string>();

  constructor(options: HeadroomSidecarOptions = {}) {
    const log = options.log ?? ((m: string) => process.stderr.write(`golem headroom: ${m}\n`));
    this.#proc = new HeadroomWorkerProcess({
      command: options.command ?? "uv",
      launchArgs: options.launchArgs ?? defaultLaunchArgs(),
      workerPath: options.workerPath ?? defaultWorkerPath(),
      host: options.host ?? "127.0.0.1",
      startupTimeoutMs: options.startupTimeoutMs ?? 90_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
      log,
      ...(options.backoffBaseMs !== undefined && { backoffBaseMs: options.backoffBaseMs }),
      ...(options.projectDir !== undefined && { projectDir: options.projectDir }),
    });
    this.#model = options.model ?? DEFAULT_MODEL;
    this.#config =
      options.config !== undefined && Object.keys(options.config).length > 0
        ? options.config
        : undefined;
    this.#log = log;
  }

  /** True once the worker is listening and health-checked. */
  isRunning(): boolean {
    return this.#proc.isRunning();
  }

  /** Spawn the worker and wait until ready. See {@link HeadroomWorkerProcess.start}. */
  start(): Promise<boolean> {
    return this.#proc.start();
  }

  /** {@link SemanticCompressor}. Fail-open: resolves null on any unavailability/error. */
  async compress(
    messages: ReadonlyArray<Readonly<Record<string, unknown>>>,
    mode: SemanticMode,
  ): Promise<SemanticResult | null> {
    const parsed = (await this.#proc.postJson("/compress", {
      messages,
      model: this.#model,
      mode,
      ...(this.#config !== undefined && { config: this.#config }),
    })) as {
      messages?: unknown;
      tokens_before?: unknown;
      tokens_after?: unknown;
      transforms_applied?: unknown;
      config_ignored?: unknown;
    } | null;
    if (parsed === null || !Array.isArray(parsed.messages)) return null;
    this.#reportIgnoredConfig(parsed.config_ignored);
    return {
      messages: parsed.messages as ReadonlyArray<Readonly<Record<string, unknown>>>,
      tokensBefore: typeof parsed.tokens_before === "number" ? parsed.tokens_before : 0,
      tokensAfter: typeof parsed.tokens_after === "number" ? parsed.tokens_after : 0,
      transformsApplied: Array.isArray(parsed.transforms_applied)
        ? (parsed.transforms_applied as string[])
        : [],
    };
  }

  /**
   * Warn once per distinct ignored-key set that a configured override did not
   * reach Headroom.
   *
   * A silently-dropped setting is the failure mode this passthrough exists to
   * avoid: a user sets `compression.headroom_config`, nothing changes, and there
   * is no way to tell whether the key was wrong or the effect was nil.
   * Deliberately a log line rather than a new `SemanticResult` field — the result
   * contract is consumed by the pipeline and should not grow for a diagnostic.
   */
  #reportIgnoredConfig(ignored: unknown): void {
    if (!Array.isArray(ignored) || ignored.length === 0) return;
    const keys = ignored.filter((k): k is string => typeof k === "string");
    if (keys.length === 0) return;
    const signature = keys.join(",");
    if (this.#warnedIgnored.has(signature)) return;
    this.#warnedIgnored.add(signature);
    this.#log(
      `compression.headroom_config: this Headroom (pin ${HEADROOM_SIDECAR_PYPI_PIN}) ignored ` +
        `${keys.join(", ")} — check the key against the installed version's CompressConfig`,
    );
  }

  /**
   * Worker health, including `supported_config` — the config field names the
   * installed Headroom actually accepts. `null` when the worker is not running.
   * This is the version gate: capability read from the running package rather
   * than inferred from a pin number.
   */
  async health(): Promise<Readonly<Record<string, unknown>> | null> {
    const parsed = await this.#proc.healthJson();
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Readonly<Record<string, unknown>>)
      : null;
  }

  /** Stop the worker (best-effort). */
  stop(): void {
    this.#proc.stop();
  }
}

export interface HeadroomMemorySidecarOptions {
  /** Launcher command (default "uv"). */
  readonly command?: string;
  /**
   * Args placed BEFORE the worker path. Default runs the pinned package + the
   * `[memory]` extra in an ephemeral uv environment: `run --python 3.13 --with
   * headroom-ai[memory]==<pin> python`.
   */
  readonly launchArgs?: readonly string[];
  /** Override the worker script path (default: headroom-memory-worker.py next to this module). */
  readonly workerPath?: string;
  readonly host?: string;
  /** First start may resolve+download the (heavier) package — allow generous time. */
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  /** Where the embedded sqlite/HNSW memory store lives (passed as `--db-path`). */
  readonly dbPath?: string;
  /** Sink for diagnostics (default: stderr). Never stdout (would corrupt MCP stdio callers). */
  readonly log?: (message: string) => void;
  /**
   * The project this sidecar serves. Stamped onto the worker's command line so a
   * later {@link reapOrphanedHeadroomWorkers} can recognise this project's
   * workers and leave every other project's alone (R10.3).
   */
  readonly projectDir?: string;
}

function defaultMemoryWorkerPath(): string {
  return fileURLToPath(new URL("./headroom-memory-worker.py", import.meta.url));
}

function defaultMemoryLaunchArgs(): string[] {
  return [
    "run",
    "--python",
    "3.13",
    "--with",
    `headroom-ai[memory]==${HEADROOM_SIDECAR_PYPI_PIN}`,
    "python",
  ];
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value as Record<string, unknown>).every((v) => typeof v === "string")
  );
}

/**
 * HeadroomMemorySidecar — R3.6 (spec Decisions 13/18): a second, independently
 * opt-in Headroom worker exposing MEMORY-scope search (`GolemKnowledgeBase`'s
 * {@link MemorySearchProvider} dependency, wired when `scopes` includes
 * `"memory"`). Kept as a separate process and config from {@link HeadroomSidecar}
 * — see this module's doc comment for why the two are never one shared process.
 *
 * Golem never writes memories through this seam: MEMORY-scope federation is
 * search-only, matching the frozen `FederatedSearch` contract, so an empty or
 * never-populated store degrades to `[]`, same as any other empty search.
 */
export class HeadroomMemorySidecar implements MemorySearchProvider {
  readonly #proc: HeadroomWorkerProcess;

  constructor(options: HeadroomMemorySidecarOptions = {}) {
    const log =
      options.log ?? ((m: string) => process.stderr.write(`golem headroom-memory: ${m}\n`));
    this.#proc = new HeadroomWorkerProcess({
      command: options.command ?? "uv",
      launchArgs: options.launchArgs ?? defaultMemoryLaunchArgs(),
      workerPath: options.workerPath ?? defaultMemoryWorkerPath(),
      workerArgs: options.dbPath !== undefined ? ["--db-path", options.dbPath] : [],
      host: options.host ?? "127.0.0.1",
      startupTimeoutMs: options.startupTimeoutMs ?? 90_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
      log,
      ...(options.projectDir !== undefined && { projectDir: options.projectDir }),
    });
  }

  /** True once the worker is listening and health-checked. */
  isRunning(): boolean {
    return this.#proc.isRunning();
  }

  /** Spawn the worker and wait until ready. See {@link HeadroomWorkerProcess.start}. */
  start(): Promise<boolean> {
    return this.#proc.start();
  }

  /** {@link MemorySearchProvider.search}. Fail-open: resolves null on any unavailability/error. */
  async search(query: string, projectId: string, k: number): Promise<MemoryFact[] | null> {
    const parsed = (await this.#proc.postJson("/memory/search", {
      query,
      project_id: projectId,
      top_k: k,
    })) as { results?: unknown } | null;
    if (parsed === null || !Array.isArray(parsed.results)) return null;
    const facts: MemoryFact[] = [];
    for (const r of parsed.results) {
      if (typeof r !== "object" || r === null) continue;
      const { id, content, score, metadata } = r as Record<string, unknown>;
      if (typeof id !== "string" || typeof content !== "string" || typeof score !== "number") {
        continue;
      }
      facts.push({ id, content, score, metadata: isStringRecord(metadata) ? metadata : {} });
    }
    return facts;
  }

  /** Stop the worker (best-effort). */
  stop(): void {
    this.#proc.stop();
  }
}

/** One row of the machine's process table, as the sweep needs to see it. */
export interface SystemProcessRow {
  readonly pid: number;
  readonly commandLine: string;
}

/**
 * Compare paths the way a *command line* has to be compared: slashes normalised
 * (Windows quotes and mixes them) and case folded (Windows is case-insensitive,
 * and two POSIX paths differing only in case that BOTH contain a Headroom worker
 * script is not a situation that occurs).
 */
function normalizePathish(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

/**
 * Which of these processes are stray Headroom workers belonging to `projectDir`?
 *
 * Pure and exported so the matching rule — the part that must never be wrong —
 * is directly testable without killing anything. Two conditions, both required:
 *
 * 1. The command line names one of Golem's worker scripts. That excludes every
 *    other Python on the machine (other tools' `uv` sidecars, language servers).
 * 2. The command line places it in THIS project — either by the
 *    {@link PROJECT_ARG} stamp, or by the worker script itself living under the
 *    project directory (which is how a repo-local install looks, and how the
 *    orphans that predate the stamp are still recognisable).
 *
 * Condition 2 is what makes the sweep safe on a machine running several Golem
 * proxies at once, one per project: a globally-installed Golem gives every
 * project the same worker path, and killing on script name alone would take down
 * a different project's healthy sidecar. The directory test is anchored with a
 * trailing separator so `…/golem` never matches `…/golem2`.
 */
export function selectHeadroomOrphans(
  processes: readonly SystemProcessRow[],
  options: { readonly projectDir: string; readonly excludePids?: readonly number[] },
): number[] {
  const dir = normalizePathish(options.projectDir).replace(/\/+$/, "");
  if (dir === "") return [];
  const excluded = new Set<number>([process.pid, ...(options.excludePids ?? [])]);
  const out: number[] = [];
  for (const row of processes) {
    if (!Number.isInteger(row.pid) || row.pid <= 0 || excluded.has(row.pid)) continue;
    const cmd = normalizePathish(row.commandLine);
    if (!WORKER_SCRIPT_NAMES.some((name) => cmd.includes(name))) continue;
    const stamped =
      cmd.includes(`${PROJECT_ARG} ${dir}`) || cmd.includes(`${PROJECT_ARG} "${dir}"`);
    if (!stamped && !cmd.includes(`${dir}/`)) continue;
    out.push(row.pid);
  }
  return out;
}

/** Parse `ps -A -o pid=,args=` output (POSIX). */
function parsePsOutput(text: string): SystemProcessRow[] {
  const rows: SystemProcessRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m?.[1] === undefined || m[2] === undefined) continue;
    rows.push({ pid: Number.parseInt(m[1], 10), commandLine: m[2] });
  }
  return rows;
}

/** Parse the `ConvertTo-Json` output of the Windows process query. */
function parseWindowsProcessJson(text: string): SystemProcessRow[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const rows: SystemProcessRow[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const { ProcessId, CommandLine } = item as Record<string, unknown>;
    if (typeof ProcessId !== "number" || typeof CommandLine !== "string") continue;
    rows.push({ pid: ProcessId, commandLine: CommandLine });
  }
  return rows;
}

/** Run a process-listing command and collect its stdout, or "" on any failure. */
function runCapture(command: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      resolve("");
      return;
    }
    let out = "";
    let settled = false;
    const done = (value: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      done("");
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    child.on("error", () => done(""));
    child.on("close", () => done(out));
  });
}

/**
 * The machine's Headroom-worker-shaped processes. Never throws; an empty list
 * means "could not tell", which the sweep treats the same as "none" — declining
 * to reap is always safe, guessing is not.
 *
 * No native dependency and no shell string: Windows has no `ps`, and `wmic` is
 * gone from current builds, so the command line has to come from PowerShell's
 * CIM query — invoked as an argument array with a fixed, non-interpolated
 * script. POSIX gets plain `ps`.
 */
async function listWorkerLikeProcesses(timeoutMs: number): Promise<SystemProcessRow[]> {
  if (process.platform === "win32") {
    const script =
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*headroom*worker.py*' } | " +
      "Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
    const out = await runCapture(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      timeoutMs,
    );
    return parseWindowsProcessJson(out);
  }
  return parsePsOutput(await runCapture("ps", ["-A", "-o", "pid=,args="], timeoutMs));
}

export interface ReapOrphansOptions {
  /** Only workers belonging to this project are ever killed. */
  readonly projectDir: string;
  /** Diagnostics sink; nothing is written anywhere else. */
  readonly log?: (message: string) => void;
  /** Pids to spare (e.g. workers this process is deliberately running). */
  readonly excludePids?: readonly number[];
  /** Budget for the process listing. Default 10s. */
  readonly timeoutMs?: number;
  /** Seams for tests — real enumeration/kill by default. */
  readonly listProcesses?: () => Promise<readonly SystemProcessRow[]>;
  readonly kill?: (pid: number) => void;
}

/**
 * Kill Headroom workers left behind by an EARLIER Golem daemon for this project,
 * and report the pids killed.
 *
 * The recovery half of R10.3. The stdin-EOF contract (see {@link PARENT_PIPE_ENV})
 * stops new orphans being created, but it cannot help processes that are already
 * running the old code — on the machine where this was found, 24 of them, the
 * oldest five days old and burning two minutes of CPU. Those only ever go away
 * if something sweeps them up, so the daemon does it at start.
 *
 * Fail-open in every direction: cannot enumerate, cannot parse, cannot kill — it
 * resolves an empty list and the proxy starts normally. It must be called BEFORE
 * this process starts a worker of its own, since a live worker of ours is
 * indistinguishable from a stray one by command line (or its pid passed in
 * `excludePids`).
 */
export async function reapOrphanedHeadroomWorkers(
  options: ReapOrphansOptions,
): Promise<readonly number[]> {
  const log = options.log;
  try {
    const list =
      options.listProcesses ?? (() => listWorkerLikeProcesses(options.timeoutMs ?? 10_000));
    const rows = await list();
    const selectOptions = {
      projectDir: options.projectDir,
      ...(options.excludePids !== undefined && { excludePids: options.excludePids }),
    };
    const pids = selectHeadroomOrphans(rows, selectOptions);
    if (pids.length === 0) return [];
    const kill =
      options.kill ??
      ((pid: number) => {
        if (process.platform === "win32") {
          killProcessTreeWindows(pid);
          return;
        }
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone / not ours
        }
      });
    for (const pid of pids) kill(pid);
    log?.(
      `reaped ${pids.length} orphaned worker process(es) from an earlier run: ${pids.join(", ")}`,
    );
    return pids;
  } catch (err) {
    log?.(`orphan sweep skipped: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
