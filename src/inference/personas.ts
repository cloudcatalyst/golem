/**
 * R14.1 — the READ side of the persona registry.
 *
 * `src/config/schema.ts` says what a persona may contain and how layers merge;
 * this says what a persona *means* once merged. The split matters because the
 * layer schema deliberately applies **no defaults** — a default applied while
 * parsing one layer would let a higher layer that merely mentions a persona
 * overwrite a lower layer's explicit `owner`. Defaults therefore belong here,
 * after the merge, and there is exactly one place that applies them.
 *
 * ## Why under `src/inference/`
 *
 * The same argument `coder-prompt.ts` records: `src/mcp/` and `src/cli/` both
 * need this and neither is upstream of the other, while `src/inference/` is
 * upstream of both and imports from neither.
 *
 * ## What is deliberately NOT here
 *
 * Which lane a persona is staffed in — subagent or dispatched worker — is
 * R14.2. This module reports `staffed` (does it name a model at all) and stops
 * there. Guessing the lane before the resolution chain exists would put a second
 * answer to that question in the codebase, which is the thing R14.1's brief is
 * trying to avoid by retiring `default_coder`.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CODER_PROMPT } from "./coder-prompt.js";

/** `agent` — any agent may fill it. `user` — a role only a human fills. */
export type PersonaOwner = "agent" | "user";

/** One persona as WRITTEN (post-merge, pre-defaults). Mirrors `personaLayerSchema`. */
export interface PersonaConfig {
  readonly discipline?: string | undefined;
  readonly description?: string | undefined;
  readonly model?: string | undefined;
  readonly prompt?: string | undefined;
  readonly prompt_file?: string | undefined;
  readonly tools?: readonly string[] | undefined;
  readonly owner?: PersonaOwner | undefined;
}

/** One persona as MEANT — defaults applied, ready to act on. */
export interface EffectivePersona {
  readonly id: string;
  readonly discipline?: string | undefined;
  readonly description?: string | undefined;
  /** Undefined means UNSTAFFED: it declines rather than guessing. */
  readonly model?: string | undefined;
  /** Omitted means inherit the session's tools. */
  readonly tools?: readonly string[] | undefined;
  readonly owner: PersonaOwner;
  /**
   * Whether this persona names a model at all. The single question this module
   * answers about staffing; WHICH lane is R14.2.
   */
  readonly staffed: boolean;
  /**
   * Whether anything may staff it. `owner: user` is a role only a human fills,
   * so a dispatch must refuse it even when a model is set — the permission axis,
   * carried down from the task-level rule in CLAUDE.md.
   */
  readonly dispatchable: boolean;
}

/**
 * Built-in prompts for the shipped bench, used when neither `prompt`,
 * `prompt_file`, nor `.golem/personas/<id>.md` supplies one.
 *
 * Short on purpose, exactly as `DEFAULT_CODER_PROMPT` is: the same text may
 * frame a small local model or a frontier subagent, and a long preamble makes
 * the small one fail. Each says only what changes the shape of the output.
 */
export const DEFAULT_PERSONA_PROMPTS: Readonly<Record<string, string>> = {
  coder: DEFAULT_CODER_PROMPT,
  reviewer:
    "You are reviewing code for defects. Read it as code — do not trust the " +
    "comments, the commit message, or the names to tell you what it does. Report " +
    "what is wrong, where, and what it would break, most serious first. Say " +
    "plainly when you find nothing rather than manufacturing a finding.",
  scribe:
    "You turn work that has landed into prose someone with no context can read " +
    "later. Read the diff and the source documents before writing. Say what " +
    "actually happened, including what failed and what was decided against; " +
    "prefer a number to an adjective, and say when something was not measured " +
    "rather than estimating it. Link sources instead of restating them.",
};

/** A generic fallback for a persona with no built-in and no prompt file. */
export const GENERIC_PERSONA_PROMPT =
  "You are completing one self-contained task for another engineer to review. " +
  "Do the work you were asked for and report what you did. If the task cannot be " +
  "completed from what you were given, say precisely what is missing in one line " +
  "instead of guessing.";

/** Conventional prompt location: `<project>/.golem/personas/<id>.md`. */
export function personaPromptPath(projectDir: string, id: string): string {
  return path.join(projectDir, ".golem", "personas", `${id}.md`);
}

/**
 * Apply the read-side defaults to one merged persona.
 *
 * `owner` defaults to `agent`; `staffed` is "names a model at all"; and
 * `dispatchable` folds in the permission axis, so a caller cannot staff a
 * `user`-owned role by checking only `staffed`.
 */
export function effectivePersona(id: string, config: PersonaConfig): EffectivePersona {
  const owner: PersonaOwner = config.owner ?? "agent";
  const model = config.model !== undefined && config.model !== "" ? config.model : undefined;
  return {
    id,
    ...(config.discipline === undefined ? {} : { discipline: config.discipline }),
    ...(config.description === undefined ? {} : { description: config.description }),
    ...(model === undefined ? {} : { model }),
    ...(config.tools === undefined ? {} : { tools: config.tools }),
    owner,
    staffed: model !== undefined,
    dispatchable: model !== undefined && owner === "agent",
  };
}

/** Every declared persona, defaults applied, in stable id order. */
export function effectivePersonas(
  personas: Readonly<Record<string, PersonaConfig>>,
): readonly EffectivePersona[] {
  return Object.keys(personas)
    .sort()
    .map((id) => effectivePersona(id, personas[id] ?? {}));
}

/**
 * Personas that declare a given discipline. Free-form and case-insensitive:
 * `discipline` is a label, not an enum (R14.4), so matching must not be
 * stricter than the field.
 */
export function personasForDiscipline(
  personas: Readonly<Record<string, PersonaConfig>>,
  discipline: string,
): readonly EffectivePersona[] {
  const wanted = discipline.trim().toLowerCase();
  return effectivePersonas(personas).filter((p) => p.discipline?.toLowerCase() === wanted);
}

/**
 * The model a persona is staffed with, or undefined when nothing should dispatch
 * it — R14.1's replacement for reading `inference.default_coder` directly.
 *
 * Returns undefined for a persona that is undeclared, unstaffed, **or**
 * `owner: user`. Folding the permission axis in here rather than at each call
 * site is the point: six places used to read `default_coder`, and six places
 * each remembering to check `owner` separately is five chances to forget.
 */
export function personaModel(
  personas: Readonly<Record<string, PersonaConfig>>,
  id: string,
): string | undefined {
  const config = personas[id];
  if (config === undefined) return undefined;
  const persona = effectivePersona(id, config);
  return persona.dispatchable ? persona.model : undefined;
}

/** Where a persona's prompt came from — reported by `golem personas`. */
export type PromptSource = "inline" | "prompt_file" | "convention" | "built-in" | "generic";

export interface ResolvedPrompt {
  readonly text: string;
  readonly source: PromptSource;
  /** The file actually read, when one was. */
  readonly path?: string;
}

/**
 * Resolve a persona's system prompt, mirroring `resolveCoderPrompt`: a file the
 * user owns wins over the built-in, and a repo that has customised nothing
 * carries no files at all.
 *
 * Precedence, highest first:
 *   1. inline `prompt`
 *   2. `prompt_file` (explicit path)
 *   3. `.golem/personas/<id>.md` (the convention `golem personas eject` writes)
 *   4. the built-in for that persona
 *   5. a generic fallback
 *
 * An explicitly-named `prompt_file` that cannot be read **throws**: the user
 * named a file, and silently substituting a built-in would run a persona on a
 * prompt they did not write. A missing *conventional* file is not an error —
 * its absence is the normal case.
 */
export async function resolvePersonaPrompt(
  id: string,
  config: PersonaConfig,
  projectDir: string,
): Promise<ResolvedPrompt> {
  if (config.prompt !== undefined && config.prompt !== "") {
    return { text: config.prompt, source: "inline" };
  }

  if (config.prompt_file !== undefined && config.prompt_file !== "") {
    const file = path.isAbsolute(config.prompt_file)
      ? config.prompt_file
      : path.join(projectDir, config.prompt_file);
    const text = await readFile(file, "utf8"); // deliberately unguarded — see above
    return { text: text.trim(), source: "prompt_file", path: file };
  }

  const conventional = personaPromptPath(projectDir, id);
  try {
    const text = await readFile(conventional, "utf8");
    return { text: text.trim(), source: "convention", path: conventional };
  } catch {
    // Absent is the normal case: nothing has been ejected for this persona.
  }

  const builtIn = DEFAULT_PERSONA_PROMPTS[id];
  if (builtIn !== undefined) {
    return { text: builtIn, source: "built-in" };
  }
  return { text: GENERIC_PERSONA_PROMPT, source: "generic" };
}
