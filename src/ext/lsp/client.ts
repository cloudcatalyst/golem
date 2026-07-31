/**
 * A minimal, **bounded** LSP client over stdio (R8.6).
 *
 * Golem spawns a language server the user already installed (tier-2, Decision
 * 53) and asks it four questions. It is deliberately not a general LSP client:
 * no workspace sync, no dynamic registration, no capability negotiation beyond
 * what those four questions need.
 *
 * The risk R8.6 names is **lifecycle**, not protocol. A language server is a
 * long-lived process with a handshake, and the failure that matters is a hung
 * one: an editor shows a spinner, but an agent tool call that never returns
 * burns the turn. So every wait here is bounded —
 *   - the `initialize` handshake ({@link LspClientOptions.initializeTimeoutMs}),
 *   - every request ({@link LspClientOptions.requestTimeoutMs}),
 *   - the graceful `shutdown`/`exit` on the way out ({@link STOP_GRACE_MS}),
 * and a dead process rejects pending work immediately instead of leaving it
 * pending forever. The bridge above turns each of those rejections into a
 * no-op result, never an error path.
 *
 * Cross-platform per CLAUDE.md: argument-array spawn, `shell: false`,
 * `windowsHide`, and `pathToFileURL` for every URI (a `file://C:\...` string
 * built by hand is the classic Windows LSP bug).
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { encodeMessage, MessageBuffer } from "./framing.js";

/** How long `stop()` waits for a well-behaved exit before killing the process. */
export const STOP_GRACE_MS = 1_500;

/** Bytes of the server's stderr kept for diagnosis. Bounded on purpose. */
const STDERR_TAIL_BYTES = 4 * 1024;

export interface LspClientOptions {
  readonly command: string;
  readonly args: readonly string[];
  /** Workspace root — becomes `rootUri` and the child's working directory. */
  readonly cwd: string;
  readonly initializeTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** A request that outlived its budget. The connection may still be usable. */
export class LspTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`${method} did not answer within ${timeoutMs}ms`);
    this.name = "LspTimeoutError";
  }
}

/** The server died, failed to start, or was stopped while work was pending. */
export class LspExitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LspExitError";
  }
}

/** The server answered with a JSON-RPC error object. */
export class LspResponseError extends Error {
  constructor(
    method: string,
    readonly code: number,
    message: string,
  ) {
    super(`${method} failed (${code}): ${message}`);
    this.name = "LspResponseError";
  }
}

interface Pending {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: NodeJS.Timeout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class LspClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, (params: unknown) => void>();
  private readonly buffer = new MessageBuffer();
  private stderrChunks: Buffer[] = [];
  private stderrBytes = 0;
  private dead: Error | null = null;
  private capabilities: unknown = null;
  private stopping: Promise<void> | null = null;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options: LspClientOptions,
  ) {
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.onStderr(chunk));
    // `error` fires when the binary is missing or not executable; `exit` covers
    // a crash. Either way pending work must fail now rather than time out later.
    child.on("error", (err) =>
      this.die(new LspExitError(`language server failed: ${err.message}`)),
    );
    child.on("exit", (code, signal) =>
      this.die(
        new LspExitError(
          `language server exited (code ${code ?? "null"}, signal ${signal ?? "null"})`,
        ),
      ),
    );
    // A server that closes stdin mid-write must not take the process down.
    child.stdin.on("error", () => {});
  }

  /** Spawn the server and complete the `initialize` handshake, or throw. */
  static async start(options: LspClientOptions): Promise<LspClient> {
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      ...(options.env !== undefined ? { env: { ...options.env } } : {}),
    }) as ChildProcessWithoutNullStreams;

    const client = new LspClient(child, options);
    try {
      const result = await client.request<{ capabilities?: unknown }>(
        "initialize",
        {
          processId: process.pid,
          clientInfo: { name: "golem", version: "0.1.0" },
          rootUri: pathToFileURL(options.cwd).href,
          workspaceFolders: [{ uri: pathToFileURL(options.cwd).href, name: "workspace" }],
          capabilities: {
            textDocument: {
              synchronization: { dynamicRegistration: false },
              definition: { dynamicRegistration: false, linkSupport: true },
              references: { dynamicRegistration: false },
              hover: { dynamicRegistration: false, contentFormat: ["plaintext", "markdown"] },
              publishDiagnostics: { relatedInformation: false },
            },
          },
        },
        options.initializeTimeoutMs,
      );
      client.capabilities = isRecord(result) ? (result.capabilities ?? null) : null;
      client.notify("initialized", {});
      return client;
    } catch (err) {
      // A half-initialised server is a leaked process; take it down hard, since
      // it never reached the state where `shutdown` is meaningful.
      client.kill();
      throw err;
    }
  }

  get serverCapabilities(): unknown {
    return this.capabilities;
  }

  /** False once the process has exited, errored, or been stopped. */
  get alive(): boolean {
    return this.dead === null;
  }

  /** Last few KiB of the server's stderr — the only clue when a handshake fails. */
  get stderrTail(): string {
    return Buffer.concat(this.stderrChunks).toString("utf8");
  }

  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (this.dead !== null) return Promise.reject(this.dead);
    const id = this.nextId++;
    const budget = timeoutMs ?? this.options.requestTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LspTimeoutError(method, budget));
      }, budget);
      // A pending LSP request must never hold the process open — a hung server
      // would otherwise keep `golem mcp serve` (or a test worker) alive.
      timer.unref?.();
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.dead !== null) return;
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** Register the single handler for a server notification (e.g. diagnostics). */
  onNotification(method: string, handler: (params: unknown) => void): void {
    this.handlers.set(method, handler);
  }

  /**
   * Ask the server to exit, then make sure it did. Idempotent and never throws:
   * a stop that fails is still a stop, and the caller has nothing useful to do
   * with the failure.
   */
  stop(): Promise<void> {
    this.stopping ??= this.doStop();
    return this.stopping;
  }

  private async doStop(): Promise<void> {
    if (this.dead === null) {
      try {
        await this.request("shutdown", null, STOP_GRACE_MS);
        this.notify("exit", null);
      } catch {
        // Fall through to the kill — a server that will not shut down politely
        // is exactly the case this grace period exists for.
      }
      await this.waitForExit(STOP_GRACE_MS);
    }
    this.kill();
  }

  private waitForExit(ms: number): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Terminate immediately, synchronously — no `shutdown` handshake, no waiting. */
  kill(): void {
    this.die(new LspExitError("language server stopped"));
    try {
      this.child.kill();
    } catch {
      // Already gone.
    }
  }

  private send(message: unknown): void {
    try {
      this.child.stdin.write(encodeMessage(message));
    } catch (err) {
      this.die(new LspExitError(`could not write to language server: ${(err as Error).message}`));
    }
  }

  private onStdout(chunk: Buffer): void {
    this.buffer.append(chunk);
    let messages: unknown[];
    try {
      messages = this.buffer.drain();
    } catch (err) {
      // A desynchronised stream cannot be recovered: every later frame boundary
      // is a guess. Kill the connection rather than return invented answers.
      this.die(new LspExitError(`language server protocol error: ${(err as Error).message}`));
      this.kill();
      return;
    }
    for (const message of messages) this.dispatch(message);
  }

  private dispatch(message: unknown): void {
    if (!isRecord(message)) return;
    const id = message.id;

    if (typeof id === "number" && ("result" in message || "error" in message)) {
      const pending = this.pending.get(id);
      if (pending === undefined) return; // already timed out
      this.pending.delete(id);
      clearTimeout(pending.timer);
      const error = message.error;
      if (isRecord(error)) {
        pending.reject(
          new LspResponseError(
            pending.method,
            typeof error.code === "number" ? error.code : 0,
            typeof error.message === "string" ? error.message : "unknown error",
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method !== "string") return;

    if (id === undefined) {
      this.handlers.get(message.method)?.(message.params);
      return;
    }

    // A server->client REQUEST (`workspace/configuration`, `client/register-
    // Capability`, …). Golem implements none of them, but a server that is
    // still waiting on a reply may never answer our question — so decline
    // explicitly instead of ignoring it.
    this.send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `golem does not implement ${message.method}` },
    });
  }

  private onStderr(chunk: Buffer): void {
    this.stderrChunks.push(chunk);
    this.stderrBytes += chunk.byteLength;
    while (this.stderrBytes > STDERR_TAIL_BYTES && this.stderrChunks.length > 1) {
      const dropped = this.stderrChunks.shift();
      this.stderrBytes -= dropped?.byteLength ?? 0;
    }
  }

  private die(err: Error): void {
    if (this.dead !== null) return;
    this.dead = err;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}
