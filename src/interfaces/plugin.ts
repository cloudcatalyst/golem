/**
 * R8.11 — the plugin contract (FROZEN, ADR-0004).
 *
 * This is the surface a third-party package implements to extend Golem without
 * forking it. It is deliberately the smallest thing that works, because every
 * type here is a promise to someone else's code.
 *
 * ## The three seams are three trust classes (ADR-0004 §1)
 *
 * | seam | supplies | sees unredacted content | runs third-party code |
 * |---|---|---|---|
 * | redaction rule | {@link RedactionRuleDescriptor} — **data** | yes | **no** |
 * | pipeline stage | {@link PluginStage} — a function | no | yes |
 * | MCP tool | {@link PluginTool} — a function | no | yes |
 *
 * The asymmetry is the whole design. A redaction rule is the seam with real
 * demand (every org has private key formats) and it is pointed straight at the
 * most sensitive data in the process — so it accepts a *pattern*, never a
 * *predicate*. Golem compiles the RegExp and runs it; `validate` names one of
 * Golem's own validators rather than supplying one. No plugin function is ever
 * called on unredacted text, because there is nothing to call.
 *
 * A stage and a tool do run plugin code, and they are placed where that is
 * survivable: a stage sees only already-redacted content and only in the lossy
 * slot (never at slider ≤1, never on a caching upstream — Decision 31), and a
 * tool is not on the request path at all.
 *
 * ## What this contract deliberately does NOT give a plugin
 *
 * No credential store, no settings writer, no proxy handle, no `deps` bag — a
 * seam receives the narrow context types below and nothing else. Per ADR-0004
 * §5 this is an interface-surface decision, **not** a security boundary: seams
 * B and C are ordinary Node code with the full privilege of the process and
 * Golem does not sandbox them. The mitigations are that the user installs the
 * package themselves, pins it, and enables each seam explicitly.
 *
 * Nothing here may depend on zod or the MCP SDK — a plugin should be able to
 * satisfy this contract with a plain object and zero dependencies.
 */

/**
 * Golem's own pure validators, addressable by name. A rule descriptor selects
 * one instead of shipping a function (ADR-0004 §1) — that is what keeps
 * third-party code out of the redaction path.
 *
 * - `luhn` — Luhn checksum over the digits, separators allowed.
 * - `credit-card` — Luhn plus real-card formatting (one consistent separator,
 *   uniform digit grouping). What the built-in card rule uses.
 * - `high-entropy` — Shannon-entropy test, the same one the generic sweep runs.
 */
export type PluginValidatorName = "luhn" | "credit-card" | "high-entropy";

/** Regex flags a plugin may ask for. `g` and `d` are added by Golem and must not be given. */
export type PluginPatternFlag = "i" | "m" | "s" | "u";

/**
 * One redaction rule, as data. Mirrors Golem's internal `RedactionRule` with
 * two differences that are the point: `pattern` is a **string** Golem compiles,
 * and `validate` is a **name**, not a function.
 */
export interface RedactionRuleDescriptor {
  /**
   * Placeholder kind: `[REDACTED:<id>:<n>]`. Namespaced by Golem to
   * `<plugin>/<id>` on load, so a plugin can never collide with — or
   * impersonate — a built-in rule's placeholder.
   */
  readonly id: string;
  /** What it catches and why the pattern is shaped this way. Shown by `golem plugin list`. */
  readonly description: string;
  /**
   * RegExp source. Compiled by Golem with `g` and `d` added. Rejected at load
   * if it does not compile, exceeds the length cap, or trips the static
   * backtracking lint (ADR-0004 threat 4).
   */
  readonly pattern: string;
  /** Extra flags. `g`/`d` are supplied by Golem; anything else is rejected. */
  readonly flags?: readonly PluginPatternFlag[];
  /** Capture group to redact instead of the whole match. Default: whole match. */
  readonly group?: number;
  /** One of Golem's own validators, by name. Default: accept every match. */
  readonly validate?: PluginValidatorName;
}

/** What a stage may look at: the already-redacted request body and the resolved policy. */
export interface PluginStageContext {
  /**
   * The parsed Anthropic Messages request body, **after redaction and after
   * every built-in stage**. Treat as read-only; return a new object to change it.
   */
  readonly body: Readonly<Record<string, unknown>>;
  /** Compression level in force for this request (0–3). */
  readonly level: number;
  /** The upstream base URL this request is bound for. */
  readonly upstreamBaseUrl: string;
  /** Write one diagnostic line. Prefixed with the plugin name; never affects the request. */
  readonly log: (message: string) => void;
}

/** A stage's contribution: a replacement body, or null for "I changed nothing". */
export interface PluginStageResult {
  readonly body: Record<string, unknown>;
}

/**
 * Seam B — a request-pipeline stage. Runs after every built-in stage, in the
 * lossy slot only: `stages.semanticCompression !== "off"` **and** a
 * non-caching upstream. At slider ≤1, or against Anthropic, it does not run at
 * all, which is what keeps the byte-fidelity guarantee true by construction
 * rather than by review (ADR-0004 threat 6).
 *
 * Must fail to a no-op: a throw, a rejection, or a malformed result is
 * quarantined and the request proceeds with the body unchanged.
 */
export interface PluginStage {
  /** Stage name, used in `stageSavings` telemetry as `plugin:<name>`. */
  readonly name: string;
  transform(
    context: PluginStageContext,
  ): Promise<PluginStageResult | null> | PluginStageResult | null;
}

/** One declared tool parameter. Golem builds the zod/JSON schema from this. */
export interface PluginToolParam {
  readonly name: string;
  readonly type: "string" | "number" | "boolean";
  /** Shown to the model. Counts against the definition's token cost. */
  readonly description: string;
  readonly required?: boolean;
}

/** Argument values as validated by Golem before the handler is called. */
export type PluginToolArgs = Readonly<Record<string, string | number | boolean | undefined>>;

/** What a tool handler may look at. Deliberately tiny. */
export interface PluginToolContext {
  /** Absolute path of the project the MCP server is serving. */
  readonly projectDir: string;
  /** Write one diagnostic line. Prefixed with the plugin name. */
  readonly log: (message: string) => void;
}

/**
 * Seam C — an MCP tool. Off the request path, but a tool *definition* is billed
 * on **every** request whether or not it is ever called (§88/§100), so this seam
 * is off by default and `golem plugin list` reports each tool's measured
 * definition cost.
 *
 * The handler returns the tool's text result. A throw is reported to the model
 * as a tool error, never as a server crash.
 */
export interface PluginTool {
  /** Tool name as the model sees it. Namespaced by Golem to `<plugin>__<name>`. */
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly params?: readonly PluginToolParam[];
  handler(args: PluginToolArgs, context: PluginToolContext): Promise<string> | string;
}

/**
 * What a plugin package's **default export** must be. Every seam is optional;
 * a plugin supplying none is valid and contributes nothing.
 */
export interface GolemPlugin {
  /** Plugin name. Namespaces every rule id and tool name it contributes. */
  readonly name: string;
  /** Plugin's own version, reported by `golem plugin list` beside the configured pin. */
  readonly version?: string;
  /** Seam A — declarative redaction rules. */
  readonly redactionRules?: readonly RedactionRuleDescriptor[];
  /** Seam B — one pipeline stage. */
  readonly stage?: PluginStage;
  /** Seam C — MCP tools. */
  readonly tools?: readonly PluginTool[];
}

/** Which seams a configured plugin is permitted to contribute. */
export type PluginSeam = "redaction" | "stage" | "tool";

/** Every seam name, in the order `golem plugin list` prints them. */
export const PLUGIN_SEAMS: readonly PluginSeam[] = ["redaction", "stage", "tool"];

/**
 * Why a declared plugin contributed nothing. Absence is always a no-op with a
 * reason, never an error path (Decision 53 admission bar, criterion 3), so
 * every failure lands here rather than throwing.
 */
export type PluginLoadFailure =
  /** The specifier did not resolve — the user has not installed it. */
  | "unresolved"
  /** It resolved but importing it threw. */
  | "import-failed"
  /** It imported but its default export is not a {@link GolemPlugin}. */
  | "invalid-export"
  /** The installed version does not match the configured pin. */
  | "pin-mismatch"
  /** Every seam it offers is disabled for it in settings. */
  | "no-seams-enabled";
