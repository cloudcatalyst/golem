/**
 * HeadroomSidecar — the ONE place Golem knows about Headroom (CLAUDE.md hard
 * rule: "any Headroom client imports live only in headroom-adapter.ts"). It
 * manages a persistent Python worker (headroom-worker.py) that keeps Headroom's
 * compression pipeline warm, and exposes it to the proxy as a neutral
 * {@link SemanticCompressor} for slider ≥3 (spec Decision 18/23).
 *
 * Architecture (verification-notes §34): we do NOT chain `headroom proxy` (it is
 * a competing Anthropic forwarder); we call `headroom.compress()` in-process in
 * the worker and Golem keeps the redaction-first, byte-faithful forward. The
 * worker is launched via `uv run --with headroom-ai==<pin>` by default — an
 * OPT-IN dependency, never in Golem's core install (CLAUDE.md: no heavyweight
 * deps by default). Heuristic-only: bare `headroom-ai`, no torch/`[ml]` (§35).
 *
 * Fail-open everywhere: if the worker can't start, dies, or errors on a request,
 * {@link compress} resolves `null` so the pipeline skips the stage and forwards
 * the losslessly-compressed body. Nothing here can break a request.
 *
 * The exact PyPI pin lives in ./index.ts (CLAUDE.md); it is read lazily at spawn
 * time so this module never bumps or hardcodes it.
 */

import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { request } from "undici";
import { HEADROOM_SIDECAR_PYPI_PIN } from "./index.js";
import type { SemanticCompressor, SemanticMode, SemanticResult } from "./semantic.js";

/** Line the worker prints on stdout once it is listening (carries the bound port). */
const LISTENING_RE = /GOLEM_HEADROOM_LISTENING (\d+)/;

/** Default Anthropic model id used by the worker only for token counting. */
const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";

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
  /** Sink for diagnostics (default: stderr). Never stdout (would corrupt MCP stdio callers). */
  readonly log?: (message: string) => void;
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
  readonly #command: string;
  readonly #launchArgs: readonly string[];
  readonly #workerPath: string;
  readonly #host: string;
  readonly #startupTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #model: string;
  readonly #log: (message: string) => void;

  #child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  #port: number | null = null;
  #startPromise: Promise<boolean> | null = null;

  constructor(options: HeadroomSidecarOptions = {}) {
    this.#command = options.command ?? "uv";
    this.#launchArgs = options.launchArgs ?? defaultLaunchArgs();
    this.#workerPath = options.workerPath ?? defaultWorkerPath();
    this.#host = options.host ?? "127.0.0.1";
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 90_000;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.#model = options.model ?? DEFAULT_MODEL;
    this.#log = options.log ?? ((m) => process.stderr.write(`golem headroom: ${m}\n`));
  }

  /** True once the worker is listening and health-checked. */
  isRunning(): boolean {
    return this.#child !== null && this.#port !== null;
  }

  /**
   * Spawn the worker and wait until it is listening + healthy. Idempotent and
   * memoized; resolves `false` (never throws) if the sidecar cannot come up, so
   * callers can degrade gracefully.
   */
  start(): Promise<boolean> {
    if (this.#startPromise !== null) return this.#startPromise;
    this.#startPromise = this.#startInner().catch((err: unknown) => {
      this.#log(`failed to start: ${err instanceof Error ? err.message : String(err)}`);
      this.#cleanup();
      return false;
    });
    return this.#startPromise;
  }

  async #startInner(): Promise<boolean> {
    const args = [...this.#launchArgs, this.#workerPath, "--port", "0"];
    const child = spawn(this.#command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;

    let stderrTail = "";
    child.stderr.on("data", (d: Buffer) => {
      stderrTail = `${stderrTail}${d.toString("utf8")}`.slice(-2000);
    });
    child.once("exit", (code) => {
      if (this.#port === null) {
        this.#log(`worker exited before listening (code ${code}). stderr: ${stderrTail.trim()}`);
      }
      this.#cleanup();
    });

    const port = await this.#awaitListeningPort(child);
    if (port === null) return false;
    this.#port = port;

    const healthy = await this.#health();
    if (!healthy) {
      this.#log("worker did not pass health check");
      this.#cleanup();
      return false;
    }
    this.#log(`sidecar ready on ${this.#host}:${port}`);
    return true;
  }

  /** Resolve the port from the worker's stdout announcement, or null on timeout/exit. */
  #awaitListeningPort(
    child: ChildProcessByStdio<null, Readable, Readable>,
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

  /** {@link SemanticCompressor}. Fail-open: resolves null on any unavailability/error. */
  async compress(
    messages: ReadonlyArray<Readonly<Record<string, unknown>>>,
    mode: SemanticMode,
  ): Promise<SemanticResult | null> {
    if (!this.isRunning() || this.#port === null) {
      // Not started (or dead) — try one lazy start so callers need not sequence it.
      const up = await this.start();
      if (!up || this.#port === null) return null;
    }
    try {
      const res = await request(`http://${this.#host}:${this.#port}/compress`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages, model: this.#model, mode }),
        headersTimeout: this.#requestTimeoutMs,
        bodyTimeout: this.#requestTimeoutMs,
      });
      const text = await res.body.text();
      if (res.statusCode !== 200) {
        this.#log(`compress returned ${res.statusCode}: ${text.slice(0, 200)}`);
        return null;
      }
      const parsed = JSON.parse(text) as {
        messages?: unknown;
        tokens_before?: unknown;
        tokens_after?: unknown;
        transforms_applied?: unknown;
      };
      if (!Array.isArray(parsed.messages)) return null;
      return {
        messages: parsed.messages as ReadonlyArray<Readonly<Record<string, unknown>>>,
        tokensBefore: typeof parsed.tokens_before === "number" ? parsed.tokens_before : 0,
        tokensAfter: typeof parsed.tokens_after === "number" ? parsed.tokens_after : 0,
        transformsApplied: Array.isArray(parsed.transforms_applied)
          ? (parsed.transforms_applied as string[])
          : [],
      };
    } catch (err) {
      this.#log(`compress error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Stop the worker (best-effort). */
  stop(): void {
    if (this.#child !== null) {
      try {
        this.#child.kill();
      } catch {
        // already gone
      }
    }
    this.#cleanup();
  }

  #cleanup(): void {
    this.#child = null;
    this.#port = null;
    this.#startPromise = null;
  }
}
