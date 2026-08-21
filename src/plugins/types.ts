/**
 * `src/plugins/types.ts` — the plugin contract (R8.11, ADR-0005).
 *
 * A **plugin** runs *inside* Golem's process; a **pkg** runs *beside* it. That is
 * the whole reason Decision 53(g) named the two surfaces separately, and it is
 * why every shape here is deliberately small: a plugin declares data and pure
 * functions, and Golem decides when they run.
 *
 * Read ADR-0005 before extending this file. In particular: **there is no
 * sandbox.** Loading a plugin is exactly as dangerous as importing a dependency
 * you installed yourself. The constraints in this module narrow what a plugin is
 * *asked* to do, never what it *can* do — so the honest thing is to keep the
 * asked-for surface as small as it can be and to make the trust decision
 * explicit somewhere the user reads.
 *
 * This is NOT `src/interfaces/` (frozen contracts). It is deliberately outside,
 * so a first draft can be corrected; if it stabilises it can be promoted, and
 * promoting later is cheaper than freezing a guess now.
 */

import type { RedactionRule } from "../pipeline/redaction-rules.js";

/**
 * A redaction rule a plugin contributes — the same shape as a built-in, minus
 * anything that could reach past it.
 *
 * The rule is **appended** after every built-in and before the entropy sweep
 * (ADR-0005 §2), so it can only ever redact *more*. `id` is namespaced to
 * `<plugin>/<id>` when it becomes a placeholder kind, so a plugin can neither
 * impersonate a built-in kind nor collide with another plugin's.
 */
export interface PluginRedactionRule {
  /** Kebab-case, unique within the plugin. Becomes `[REDACTED:<plugin>/<id>:n]`. */
  readonly id: string;
  /** What it catches and why — shown by `golem plugin --verbose`. */
  readonly description: string;
  /** Must carry the `g` flag, like every rule in the built-in table. */
  readonly pattern: RegExp;
  /** Redact this capture group instead of the whole match. */
  readonly group?: number;
  /**
   * Extra pure check on the redaction target (the Luhn precedent). A throw is
   * treated as "not a secret" — the same verdict as returning false — so a buggy
   * validator cannot take down the pass.
   */
  readonly validate?: (target: string) => boolean;
}

/** What a pipeline stage is handed, and what it may return. */
export interface PluginStageInput {
  /**
   * The request body, **already redacted**. A plugin stage never sees raw
   * content (ADR-0005 §3).
   */
  readonly body: Record<string, unknown>;
  /** The project this request belongs to, for a stage that wants to scope itself. */
  readonly projectId: string;
}

/**
 * A pipeline stage a plugin contributes. Runs after redaction and before
 * compression; **redaction runs again over whatever it returns**, so a stage
 * cannot introduce unredacted content however it obtained it.
 *
 * Return the input body (or `undefined`) to do nothing. A throw skips the stage
 * for that request and the pre-stage body is used — a plugin never fails a
 * user's request.
 */
export interface PluginPipelineStage {
  /** Kebab-case, unique within the plugin. Appears in stage-timing telemetry. */
  readonly name: string;
  readonly description: string;
  readonly transform: (
    input: PluginStageInput,
  ) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
}

/**
 * An MCP tool a plugin contributes.
 *
 * `inputSchema` is an MCP raw shape (a record of Zod types), matching what
 * `server.registerTool` already takes for Golem's own tools — the plugin brings
 * its own Zod, which is fine because nothing here crosses a version boundary
 * that matters: the shape is consumed immediately at registration.
 */
export interface PluginMcpTool {
  /** Tool name as the model will see it. A collision with a built-in is rejected. */
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

/**
 * The registration API handed to `setup()`. **Append-only by construction**:
 * there is no remove, replace, reorder, or "disable built-in" method here, and
 * the built-in redaction table is never passed out (ADR-0005 §2). Those methods
 * do not exist to be called.
 */
export interface GolemPluginApi {
  /** Golem's version, for a plugin that wants to feature-detect. */
  readonly golemVersion: string;
  /** The project directory Golem is running for. */
  readonly projectDir: string;
  addRedactionRule(rule: PluginRedactionRule): void;
  addPipelineStage(stage: PluginPipelineStage): void;
  addMcpTool(tool: PluginMcpTool): void;
}

/**
 * What a plugin module must export (as `default` or as `plugin`).
 *
 * `setup` is called **once, at startup, before the process serves anything** —
 * not per request. That is a hard requirement, not a convenience: redaction has
 * to be a pure function of its input for prompt-cache prefix stability
 * (verification-notes §14), so the rule table must not change mid-process.
 */
export interface GolemPlugin {
  /** Kebab-case identity. Namespaces this plugin's redaction kinds. */
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  setup(api: GolemPluginApi): void | Promise<void>;
}

/** Which seam a registration landed in — for `golem plugin` and its tests. */
export type PluginSeam = "redaction-rule" | "pipeline-stage" | "mcp-tool";

/** One plugin that loaded, and what it contributed. */
export interface LoadedPlugin {
  readonly name: string;
  readonly version: string | null;
  readonly description: string | null;
  /** The specifier the user wrote, verbatim. */
  readonly specifier: string;
  /** Where it actually resolved from — the answer to "which copy is this?". */
  readonly resolved: string;
  readonly seams: Readonly<Record<PluginSeam, number>>;
}

/** Something that did not work. Never an error path — always a recorded fact. */
export interface PluginProblem {
  /** The specifier at fault, or the plugin name for a per-registration problem. */
  readonly subject: string;
  readonly reason: string;
}

/** The whole outcome of a load pass. Every field is safe to ignore. */
export interface LoadedPlugins {
  readonly plugins: readonly LoadedPlugin[];
  /** Ready to append after the built-in table — already namespaced and validated. */
  readonly redactionRules: readonly RedactionRule[];
  readonly stages: readonly PluginPipelineStage[];
  readonly mcpTools: readonly PluginMcpTool[];
  readonly problems: readonly PluginProblem[];
  /** False when `plugins.enabled` is off — nothing was even attempted. */
  readonly attempted: boolean;
}
