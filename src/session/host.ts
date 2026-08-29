/**
 * R13.3 — the session host: Golem spawns and supervises an agent session
 * through its own proxy, and can refuse outright.
 *
 * The runner is the `claude` CLI, driven as ONE long-lived process over
 * `-p --input-format stream-json --output-format stream-json` (ADR-0007 §3a;
 * R13.1's verdict, verification-notes §142, re-confirmed on client 2.1.246 in
 * §147). Not one process per turn: a single process holds one `session_id`
 * across turns, which is what makes a hosted conversation a conversation.
 *
 * ## What makes this different from the session on the developer's screen
 *
 * A hosted session is Golem's, not the developer's. Nobody is looking at it.
 * That cuts both ways and both are load-bearing:
 *
 *   * it can be **refused** rather than merely asked (`host-gate.ts`), because
 *     Golem owns the loop and injects the gate itself (`host-settings.ts`);
 *   * an `ask` has **nobody to answer it**, so it is a denial rather than a wait
 *     (ADR-0007 invariant 3).
 *
 * ## Invariant 8: no exemption
 *
 * The child is spawned with `ANTHROPIC_BASE_URL` pointing at Golem's proxy, so
 * a hosted session gets the same redaction, the same telemetry and the same
 * limits as anything else. It is not a side door.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";

/** The runner, and the flags §142/§147 measured as the multi-turn shape. */
export const RUNNER_BIN = "claude";

/**
 * `--verbose` is REQUIRED, not cosmetic: without it `--output-format stream-json`
 * does not emit the per-event stream (measured, §147/§142 item 2), and the host
 * would see only a final result — no visible tool calls, which ADR-0007 §2
 * promises.
 */
export function runnerArgs(settingsJson: string, permissionMode = "default"): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    permissionMode,
    "--settings",
    settingsJson,
  ];
}

/** One line of the runner's stdout, normalised. */
export interface HostEvent {
  /** `system/init`, `assistant`, `user`, `result/success`, `system/permission_denied`, … */
  readonly kind: string;
  readonly raw: Record<string, unknown>;
}

/** Assistant prose. */
export interface HostTextEvent {
  readonly type: "text";
  readonly text: string;
}

/** A tool the session decided to call — visible, per ADR-0007 §2. */
export interface HostToolUseEvent {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/** What came back. `isError` is how a host refusal surfaces to the model. */
export interface HostToolResultEvent {
  readonly type: "tool_result";
  readonly toolUseId: string;
  readonly isError: boolean;
  readonly content: string;
}

/** A refusal by the runner's OWN guards, distinct from a hook denial. */
export interface HostPermissionDeniedEvent {
  readonly type: "permission_denied";
  readonly tool: string;
  readonly message: string;
}

/** The turn finished. */
export interface HostResultEvent {
  readonly type: "result";
  readonly isError: boolean;
  readonly costUsd?: number;
  readonly numTurns?: number;
}

/** The runner reported rate-limit pressure — the park's signal (invariant 8). */
export interface HostRateLimitEvent {
  readonly type: "rate_limit";
  readonly raw: Record<string, unknown>;
}

export type HostStreamEvent =
  | HostTextEvent
  | HostToolUseEvent
  | HostToolResultEvent
  | HostPermissionDeniedEvent
  | HostResultEvent
  | HostRateLimitEvent;

/**
 * Normalise one runner event into the host's vocabulary.
 *
 * Exported and pure so the stream shape is testable without spawning anything —
 * the expensive part of this module is the process, and the fragile part is this
 * parsing, and they should not have to be tested together.
 */
export function normaliseEvent(raw: Record<string, unknown>): HostStreamEvent[] {
  const type = typeof raw.type === "string" ? raw.type : "";
  const subtype = typeof raw.subtype === "string" ? raw.subtype : undefined;
  const out: HostStreamEvent[] = [];

  if (type === "assistant") {
    const content = (raw.message as { content?: unknown[] } | undefined)?.content ?? [];
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim() !== "") {
        out.push({ type: "text", text: b.text });
      }
      if (b.type === "tool_use") {
        out.push({
          type: "tool_use",
          id: String(b.id ?? ""),
          name: String(b.name ?? ""),
          input: b.input,
        });
      }
    }
    return out;
  }

  if (type === "user") {
    const content = (raw.message as { content?: unknown[] } | undefined)?.content ?? [];
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type === "tool_result") {
        out.push({
          type: "tool_result",
          toolUseId: String(b.tool_use_id ?? ""),
          isError: b.is_error === true,
          content: typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? ""),
        });
      }
    }
    return out;
  }

  if (type === "system" && subtype === "permission_denied") {
    out.push({
      type: "permission_denied",
      tool: String(raw.tool_name ?? ""),
      message: String(raw.message ?? ""),
    });
    return out;
  }

  if (type === "rate_limit_event") {
    out.push({ type: "rate_limit", raw });
    return out;
  }

  if (type === "result") {
    out.push({
      type: "result",
      isError: raw.is_error === true,
      ...(typeof raw.total_cost_usd === "number" ? { costUsd: raw.total_cost_usd } : {}),
      ...(typeof raw.num_turns === "number" ? { numTurns: raw.num_turns } : {}),
    });
  }
  return out;
}

/** One user message, in the envelope the runner's stdin expects (§142 item 1). */
export function userMessageLine(text: string): string {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  })}\n`;
}

export interface HostedSessionOptions {
  readonly projectDir: string;
  /** Golem's proxy base URL — invariant 8, the session is not exempt. */
  readonly proxyBaseUrl: string;
  readonly settingsJson: string;
  readonly permissionMode?: string;
  /** Override the binary (tests point this at a fake runner). */
  readonly runnerBin?: string;
  /**
   * Override the argument array entirely.
   *
   * A test seam, and the only honest way to spawn a stand-in runner: the real
   * flags (`-p --input-format stream-json …`) are the real runner's, and a fake
   * that had to accept them would be pretending to be a CLI instead of speaking
   * the protocol. Production never sets this, so `runnerArgs` stays the one
   * definition of how the real runner is invoked.
   */
  readonly runnerArgsOverride?: readonly string[];
  /** Extra env for the child; merged over the inherited environment. */
  readonly env?: Record<string, string>;
}

/**
 * A supervised hosted session.
 *
 * Supervision follows `multiplex.ts`'s discipline rather than its code: bounded,
 * crash-tolerant, and **nothing lost silently** — a death records `lastError`
 * and emits `exit` rather than throwing into whatever happened to be awaiting.
 */
export class HostedSession extends EventEmitter {
  private child: ChildProcess | undefined;
  private buffer = "";
  private closed = false;
  /** Set when the runner dies unexpectedly; read rather than thrown. */
  lastError: string | undefined;
  /** The runner's own session id, learned from the first `system/init`. */
  runnerSessionId: string | undefined;

  constructor(private readonly options: HostedSessionOptions) {
    super();
  }

  start(): void {
    if (this.child !== undefined) throw new Error("session already started");
    const args = [
      ...(this.options.runnerArgsOverride ??
        runnerArgs(this.options.settingsJson, this.options.permissionMode)),
    ];
    this.child = spawn(this.options.runnerBin ?? RUNNER_BIN, args, {
      cwd: this.options.projectDir,
      stdio: ["pipe", "pipe", "pipe"],
      // Argument array, never a shell string (CLAUDE.md hard rule).
      shell: false,
      env: {
        ...process.env,
        // Invariant 8: every request this session makes transits Golem.
        ANTHROPIC_BASE_URL: this.options.proxyBaseUrl,
        ...this.options.env,
      },
    });

    this.child.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr?.on("data", (chunk: Buffer) => this.emit("stderr", chunk.toString("utf8")));
    this.child.on("error", (err) => {
      this.lastError = err.message;
      this.emit("exit", { code: null, error: err.message });
    });
    this.child.on("close", (code) => {
      this.closed = true;
      this.emit("exit", {
        code,
        ...(this.lastError !== undefined ? { error: this.lastError } : {}),
      });
    });
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let nl: number;
    // biome-ignore lint/suspicious/noAssignInExpressions: the standard JSONL drain.
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line === "") continue;
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // A partial or non-JSON line is not fatal — the runner also prints
        // diagnostics, and a parse failure must not kill a live session.
        continue;
      }
      if (typeof raw.session_id === "string" && this.runnerSessionId === undefined) {
        this.runnerSessionId = raw.session_id;
      }
      for (const event of normaliseEvent(raw)) this.emit("event", event);
    }
  }

  /** Relay one turn. The caller must have written the audit line FIRST (invariant 4). */
  send(text: string): void {
    const stdin = this.child?.stdin;
    if (stdin === undefined || stdin === null || this.closed) {
      throw new Error("hosted session is not running");
    }
    stdin.write(userMessageLine(text));
  }

  /** Close stdin — the runner finishes its current turn and exits cleanly. */
  end(): void {
    this.child?.stdin?.end();
  }

  /**
   * Kill the runner now.
   *
   * §142 item 3 measured that `SIGINT` does NOT interrupt a running turn on
   * Windows — only a process kill does. So this does not pretend to be a
   * graceful interrupt: it ends the process, and the caller is responsible for
   * telling the conversation that the turn was abandoned rather than answered.
   */
  kill(): void {
    this.child?.kill();
  }

  get running(): boolean {
    return this.child !== undefined && !this.closed;
  }
}
