/**
 * The LSP bridge (R8.6) — four questions, one tool mode each.
 *
 * `diagnostics` / `definition` / `references` / `hover` are the questions that
 * stop an agent grepping: the R8.5 repo map says what exists, the language
 * server says what refers to what. They are **modes of the `code` tool**, never
 * four tools — §100 measured every tool definition as a permanent per-request
 * bill.
 *
 * Posture (Decision 53, tier 2): the user brings the server, it is off by
 * default, and **absence is a no-op, never an error path**. Every failure mode
 * here — no server configured for the extension, the binary not on `PATH`, a
 * handshake that times out, a crash mid-request, a protocol desync — resolves
 * to `available: false` plus a one-line reason. The caller reads a file the
 * ordinary way and the session continues.
 *
 * Lifecycle: clients are pooled per server id and evicted after an idle period,
 * so a run of questions pays the handshake once while a forgotten server does
 * not live forever inside `golem mcp serve`.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commandOnPath } from "../detect.js";
import { LspClient, type LspClientOptions } from "./client.js";
import { type LspServerSpec, resolveLspServers, serverForFile } from "./servers.js";

export type LspMode = "diagnostics" | "definition" | "references" | "hover";

/** The `code` tool modes this bridge serves, in the order they are documented. */
export const LSP_MODES: readonly LspMode[] = ["diagnostics", "definition", "references", "hover"];

export const DEFAULT_LSP_INITIALIZE_TIMEOUT_MS = 20_000;
export const DEFAULT_LSP_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_LSP_IDLE_TIMEOUT_MS = 300_000;
/** How long to wait for the server to publish diagnostics after a `didOpen`. */
export const DEFAULT_LSP_DIAGNOSTICS_WAIT_MS = 8_000;
/** Extra time spent collecting later diagnostic revisions once the first arrives. */
const DIAGNOSTICS_SETTLE_MS = 400;
/** Locations echoed in the rendered text before it is truncated with a count. */
const MAX_RENDERED_LOCATIONS = 40;

export interface LspLocation {
  /** Repo-relative POSIX path when the location is inside the root, else absolute. */
  readonly file: string;
  /** 1-based, to match the repo map and every editor. */
  readonly line: number;
  readonly character: number;
}

export interface LspDiagnostic extends LspLocation {
  readonly severity: "error" | "warning" | "information" | "hint";
  readonly message: string;
  readonly code?: string;
  readonly source?: string;
}

export interface LspQueryInput {
  readonly mode: LspMode;
  /** Repo-relative or absolute path to the file being asked about. */
  readonly file: string;
  /** 1-based line. Required by every mode except `diagnostics`, unless `symbol` is given. */
  readonly line?: number;
  /** 1-based column. Defaults to the position of `symbol`, or the first non-blank column. */
  readonly character?: number;
  /** Name to locate in the file instead of giving a column — pairs with the repo map. */
  readonly symbol?: string;
}

export interface LspQueryResult {
  readonly mode: LspMode;
  readonly available: boolean;
  /** Why the answer is unavailable. Present only when `available` is false. */
  readonly reason?: string;
  /** Which configured server answered. */
  readonly server?: string;
  /** Rendered, token-frugal text — what the model reads. */
  readonly text: string;
  readonly locations: readonly LspLocation[];
  readonly diagnostics: readonly LspDiagnostic[];
}

export interface LspBridgeOptions {
  /** Workspace root: relative paths resolve against it, and it becomes `rootUri`. */
  readonly root: string;
  /** User rows layered over the built-in ones. */
  readonly servers?: readonly LspServerSpec[];
  readonly initializeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly diagnosticsWaitMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Seam for tests and for an explicitly-pathed server: resolve a command name
   * to an absolute path, or `null` when it is not installed. Defaults to the
   * spawn-free `PATH`/`PATHEXT` walk the rest of `src/ext/` uses.
   */
  readonly resolveCommand?: (command: string) => string | null;
}

interface PooledClient {
  readonly client: LspClient;
  readonly diagnostics: Map<string, LspDiagnostic[]>;
  readonly waiters: Set<(uri: string) => void>;
  timer: NodeJS.Timeout | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const SEVERITIES: Readonly<Record<number, LspDiagnostic["severity"]>> = {
  1: "error",
  2: "warning",
  3: "information",
  4: "hint",
};

export class LspBridge {
  private readonly pool = new Map<string, PooledClient>();
  private readonly resolveCommand: (command: string) => string | null;
  private readonly servers: readonly LspServerSpec[];
  private closed = false;

  constructor(private readonly options: LspBridgeOptions) {
    this.servers = resolveLspServers(options.servers ?? []);
    this.resolveCommand = options.resolveCommand ?? ((command) => commandOnPath(command));
  }

  /**
   * Answer one question. Never rejects: an unavailable answer is a result with
   * `available: false`, because a tool that throws teaches the model to stop
   * asking (Decision 53's degrade rule).
   */
  async query(input: LspQueryInput): Promise<LspQueryResult> {
    try {
      return await this.runQuery(input);
    } catch (err) {
      return unavailable(input.mode, (err as Error).message);
    }
  }

  /**
   * Kill every pooled server **synchronously**. For `process.on("exit")`, where
   * no promise will ever settle: without it a parent that dies leaves orphaned
   * language servers behind, which is the worst outcome for a feature whose
   * whole posture is "absence costs you nothing".
   */
  killAll(): void {
    this.closed = true;
    for (const entry of this.pool.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.client.kill();
    }
    this.pool.clear();
  }

  /** Stop every pooled server. Idempotent; safe to call on process shutdown. */
  async close(): Promise<void> {
    this.closed = true;
    const entries = [...this.pool.values()];
    this.pool.clear();
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        await entry.client.stop();
      }),
    );
  }

  private async runQuery(input: LspQueryInput): Promise<LspQueryResult> {
    if (this.closed) return unavailable(input.mode, "the LSP bridge is closed");

    const absolute = path.resolve(this.options.root, input.file);
    const spec = serverForFile(absolute, this.servers);
    if (spec === undefined) {
      return unavailable(
        input.mode,
        `no language server is configured for ${path.extname(absolute) || "this file type"}`,
      );
    }

    let text: string;
    try {
      text = await readFile(absolute, "utf8");
    } catch (err) {
      return unavailable(input.mode, `cannot read ${input.file}: ${(err as Error).message}`);
    }

    const resolved = this.resolveCommand(spec.command);
    if (resolved === null) {
      return unavailable(
        input.mode,
        `${spec.command} is not installed (tier-2: Golem spawns it, it never ships it)`,
      );
    }

    const entry = await this.acquire(spec, resolved);
    const uri = pathToFileURL(absolute).href;

    entry.diagnostics.delete(uri);
    entry.client.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: spec.languageId, version: 1, text },
    });

    try {
      if (input.mode === "diagnostics") {
        const found = await this.awaitDiagnostics(entry, uri);
        return renderDiagnostics(spec.id, found);
      }
      const position = resolvePosition(text, input);
      if (position === null) {
        return unavailable(
          input.mode,
          input.symbol !== undefined
            ? `\`${input.symbol}\` does not appear in ${input.file}`
            : `${input.mode} needs a \`line\` (1-based) or a \`symbol\``,
        );
      }
      return await this.positionQuery(entry, spec, uri, input.mode, position);
    } finally {
      entry.client.notify("textDocument/didClose", { textDocument: { uri } });
    }
  }

  private async positionQuery(
    entry: PooledClient,
    spec: LspServerSpec,
    uri: string,
    mode: Exclude<LspMode, "diagnostics">,
    position: { line: number; character: number },
  ): Promise<LspQueryResult> {
    const params: Record<string, unknown> = { textDocument: { uri }, position };
    if (mode === "references") params.context = { includeDeclaration: false };
    const method =
      mode === "definition"
        ? "textDocument/definition"
        : mode === "references"
          ? "textDocument/references"
          : "textDocument/hover";

    const answer = await entry.client.request<unknown>(method, params);
    if (mode === "hover") return renderHover(spec.id, answer);
    return renderLocations(spec.id, mode, toLocations(this.options.root, answer));
  }

  /** Wait for the server to publish diagnostics for `uri`, bounded either way. */
  private async awaitDiagnostics(entry: PooledClient, uri: string): Promise<LspDiagnostic[]> {
    const budget = this.options.diagnosticsWaitMs ?? DEFAULT_LSP_DIAGNOSTICS_WAIT_MS;
    const deadline = Date.now() + budget;
    if (!entry.diagnostics.has(uri)) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(finish, budget);
        timer.unref?.();
        const waiter = (published: string): void => {
          if (published === uri) finish();
        };
        function finish(): void {
          clearTimeout(timer);
          entry.waiters.delete(waiter);
          resolve();
        }
        entry.waiters.add(waiter);
      });
    }
    // Servers commonly publish an empty set first and the real one a beat later
    // (tsserver loads the project asynchronously). Give the revision a moment.
    const settle = Math.max(0, Math.min(DIAGNOSTICS_SETTLE_MS, deadline - Date.now()));
    if (settle > 0) await sleep(settle);
    return entry.diagnostics.get(uri) ?? [];
  }

  private async acquire(spec: LspServerSpec, command: string): Promise<PooledClient> {
    const existing = this.pool.get(spec.id);
    if (existing?.client.alive === true) {
      this.touch(spec.id, existing);
      return existing;
    }
    if (existing !== undefined) this.pool.delete(spec.id);

    const clientOptions: LspClientOptions = {
      command,
      args: spec.args,
      cwd: this.options.root,
      initializeTimeoutMs: this.options.initializeTimeoutMs ?? DEFAULT_LSP_INITIALIZE_TIMEOUT_MS,
      requestTimeoutMs: this.options.requestTimeoutMs ?? DEFAULT_LSP_REQUEST_TIMEOUT_MS,
      ...(this.options.env !== undefined ? { env: this.options.env } : {}),
    };
    const client = await LspClient.start(clientOptions);
    const entry: PooledClient = {
      client,
      diagnostics: new Map(),
      waiters: new Set(),
      timer: undefined,
    };
    client.onNotification("textDocument/publishDiagnostics", (params) => {
      if (!isRecord(params) || typeof params.uri !== "string") return;
      entry.diagnostics.set(params.uri, toDiagnostics(this.options.root, params));
      for (const waiter of [...entry.waiters]) waiter(params.uri);
    });
    this.pool.set(spec.id, entry);
    this.touch(spec.id, entry);
    return entry;
  }

  /** Restart the idle countdown; an unused server should not outlive its usefulness. */
  private touch(id: string, entry: PooledClient): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    const idle = this.options.idleTimeoutMs ?? DEFAULT_LSP_IDLE_TIMEOUT_MS;
    const timer = setTimeout(() => {
      this.pool.delete(id);
      void entry.client.stop();
    }, idle);
    timer.unref?.();
    entry.timer = timer;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function unavailable(mode: LspMode, reason: string): LspQueryResult {
  return {
    mode,
    available: false,
    reason,
    text: `No LSP ${mode} available: ${reason}`,
    locations: [],
    diagnostics: [],
  };
}

/**
 * Turn the caller's 1-based, optionally symbol-named position into LSP's
 * 0-based one. `symbol` exists so a caller holding a repo-map row (`file`,
 * `line`, symbol name) can ask without counting columns.
 */
function resolvePosition(
  text: string,
  input: LspQueryInput,
): { line: number; character: number } | null {
  const lines = text.split(/\r?\n/);

  if (input.symbol !== undefined && input.symbol.length > 0) {
    const start = input.line !== undefined ? Math.max(0, input.line - 1) : 0;
    for (let offset = 0; offset < lines.length; offset++) {
      // Search from the hinted line outward-forward, then wrap, so a stale line
      // number degrades to "somewhere in this file" instead of to nothing.
      const index = (start + offset) % lines.length;
      const column = indexOfWord(lines[index] ?? "", input.symbol);
      if (column !== -1) return { line: index, character: column };
    }
    return null;
  }

  if (input.line === undefined) return null;
  const line = Math.max(0, input.line - 1);
  if (line >= lines.length) return null;
  if (input.character !== undefined) return { line, character: Math.max(0, input.character - 1) };
  const firstNonBlank = (lines[line] ?? "").search(/\S/);
  return { line, character: firstNonBlank === -1 ? 0 : firstNonBlank };
}

/** First whole-word occurrence of `word` in `line`, or -1. */
function indexOfWord(line: string, word: string): number {
  const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\w$]/.test(ch);
  let from = 0;
  for (;;) {
    const at = line.indexOf(word, from);
    if (at === -1) return -1;
    if (!isWordChar(line[at - 1]) && !isWordChar(line[at + word.length])) return at;
    from = at + 1;
  }
}

function displayPath(root: string, absolute: string): string {
  const relative = path.relative(root, absolute);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    return absolute;
  }
  return relative.split(path.sep).join("/");
}

function uriToDisplay(root: string, uri: string): string {
  try {
    return displayPath(root, fileURLToPath(uri));
  } catch {
    return uri;
  }
}

function positionOf(value: unknown): { line: number; character: number } {
  if (!isRecord(value)) return { line: 1, character: 1 };
  const line = typeof value.line === "number" ? value.line : 0;
  const character = typeof value.character === "number" ? value.character : 0;
  return { line: line + 1, character: character + 1 };
}

/** `Location | Location[] | LocationLink[] | null` — all four shapes LSP allows. */
function toLocations(root: string, answer: unknown): LspLocation[] {
  const raw =
    answer === null || answer === undefined ? [] : Array.isArray(answer) ? answer : [answer];
  const out: LspLocation[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const uri = typeof item.uri === "string" ? item.uri : item.targetUri;
    if (typeof uri !== "string") continue;
    const range = isRecord(item.range) ? item.range : item.targetSelectionRange;
    const { line, character } = positionOf(isRecord(range) ? range.start : undefined);
    out.push({ file: uriToDisplay(root, uri), line, character });
  }
  return out;
}

function toDiagnostics(root: string, params: Record<string, unknown>): LspDiagnostic[] {
  const file = uriToDisplay(root, params.uri as string);
  const raw = Array.isArray(params.diagnostics) ? params.diagnostics : [];
  const out: LspDiagnostic[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const { line, character } = positionOf(isRecord(item.range) ? item.range.start : undefined);
    const severity = typeof item.severity === "number" ? SEVERITIES[item.severity] : undefined;
    out.push({
      file,
      line,
      character,
      severity: severity ?? "error",
      message: typeof item.message === "string" ? item.message : "",
      ...(typeof item.code === "string" || typeof item.code === "number"
        ? { code: String(item.code) }
        : {}),
      ...(typeof item.source === "string" ? { source: item.source } : {}),
    });
  }
  return out;
}

function renderDiagnostics(server: string, found: LspDiagnostic[]): LspQueryResult {
  const header =
    found.length === 0
      ? "[Golem lsp diagnostics] no problems reported"
      : `[Golem lsp diagnostics] ${found.length} problem${found.length === 1 ? "" : "s"}`;
  const lines = found
    .slice(0, MAX_RENDERED_LOCATIONS)
    .map(
      (d) =>
        `${d.file}:${d.line}:${d.character} ${d.severity}${d.code !== undefined ? ` ${d.code}` : ""}: ${d.message}`,
    );
  if (found.length > MAX_RENDERED_LOCATIONS) {
    lines.push(`… ${found.length - MAX_RENDERED_LOCATIONS} more`);
  }
  return {
    mode: "diagnostics",
    available: true,
    server,
    text: [header, ...lines].join("\n"),
    locations: [],
    diagnostics: found,
  };
}

function renderLocations(
  server: string,
  mode: "definition" | "references",
  locations: LspLocation[],
): LspQueryResult {
  const header =
    locations.length === 0
      ? `[Golem lsp ${mode}] none found`
      : `[Golem lsp ${mode}] ${locations.length} location${locations.length === 1 ? "" : "s"}`;
  const lines = locations
    .slice(0, MAX_RENDERED_LOCATIONS)
    .map((l) => `${l.file}:${l.line}:${l.character}`);
  if (locations.length > MAX_RENDERED_LOCATIONS) {
    lines.push(`… ${locations.length - MAX_RENDERED_LOCATIONS} more`);
  }
  return {
    mode,
    available: true,
    server,
    text: [header, ...lines].join("\n"),
    locations,
    diagnostics: [],
  };
}

/** `Hover.contents` is a `MarkupContent`, a `MarkedString`, or an array of either. */
function renderHover(server: string, answer: unknown): LspQueryResult {
  const parts: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      parts.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) collect(item);
    } else if (isRecord(value)) {
      if (typeof value.value === "string") parts.push(value.value);
    }
  };
  collect(isRecord(answer) ? answer.contents : null);
  const body = parts.join("\n").trim();
  return {
    mode: "hover",
    available: true,
    server,
    text:
      body.length === 0
        ? "[Golem lsp hover] nothing at that position"
        : `[Golem lsp hover]\n${body}`,
    locations: [],
    diagnostics: [],
  };
}
