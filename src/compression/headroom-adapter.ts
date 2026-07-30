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
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { request } from "undici";
import { HEADROOM_SIDECAR_PYPI_PIN } from "./index.js";
import type { MemoryFact, MemorySearchProvider } from "./memory-search.js";
import type { SemanticCompressor, SemanticMode, SemanticResult } from "./semantic.js";

/** Line every worker prints on stdout once listening (carries the bound port). */
const LISTENING_RE = /GOLEM_HEADROOM_LISTENING (\d+)/;

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

  #child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  #port: number | null = null;
  #startPromise: Promise<boolean> | null = null;

  constructor(options: WorkerProcessOptions) {
    this.#command = options.command;
    this.#launchArgs = options.launchArgs;
    this.#workerPath = options.workerPath;
    this.#workerArgs = options.workerArgs ?? [];
    this.#host = options.host;
    this.#startupTimeoutMs = options.startupTimeoutMs;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#log = options.log;
  }

  /** True once the worker is listening and health-checked. */
  isRunning(): boolean {
    return this.#child !== null && this.#port !== null;
  }

  /**
   * Spawn the worker and wait until it is listening + healthy. Idempotent and
   * memoized; resolves `false` (never throws) if the worker cannot come up, so
   * callers can degrade gracefully.
   */
  start(): Promise<boolean> {
    if (this.#startPromise !== null) return this.#startPromise;
    this.#startPromise = this.#startInner().catch((err: unknown) => {
      this.#log(`failed to start: ${err instanceof Error ? err.message : String(err)}`);
      this.stop(); // kill a half-started worker so it can't linger orphaned
      return false;
    });
    return this.#startPromise;
  }

  async #startInner(): Promise<boolean> {
    const args = [...this.#launchArgs, this.#workerPath, "--port", "0", ...this.#workerArgs];
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
    if (port === null) {
      // Startup timeout: the process may still be alive (e.g. a slow first
      // package download) — kill it or it lingers orphaned. Its exit event
      // then runs #cleanup, so a later request may retry a fresh start.
      this.#log("worker did not announce a listening port in time");
      try {
        child.kill();
      } catch {
        // already gone
      }
      this.#cleanup();
      return false;
    }
    this.#port = port;

    const healthy = await this.#health();
    if (!healthy) {
      // Same orphan risk: the worker is listening but unhealthy — kill it.
      this.#log("worker did not pass health check");
      try {
        child.kill();
      } catch {
        // already gone
      }
      this.#cleanup();
      return false;
    }
    this.#log(`worker ready on ${this.#host}:${port}`);
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
