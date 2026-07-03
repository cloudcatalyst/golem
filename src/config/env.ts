/**
 * Environment-variable override layer (E1).
 *
 * Mapping rules — deterministic, in full:
 *
 * 1. NAME SHAPE. `GOLEM_<SECTION>_<KEY>` maps to `section.key` in settings.
 *    The name is matched case-insensitively (Windows env vars are
 *    case-insensitive; `golem_proxy_port` and `GOLEM_PROXY_PORT` are the same
 *    variable). After the `GOLEM_` prefix, the name is split at the FIRST
 *    underscore: the token before it is the section, everything after it is
 *    the key. Section names therefore never contain underscores (enforced by
 *    schema.ts); keys may (e.g. `GOLEM_PROXY_UPSTREAM_BASE_URL` →
 *    `proxy.upstream_base_url`). Only two levels of nesting exist — the
 *    settings shape is flat `section.key`; deeper nesting is not supported.
 *
 * 2. CASE COLLISIONS. If two differently-cased raw names normalize to the
 *    same variable (possible in a POSIX environment or an explicit `env`
 *    option) and carry DIFFERENT values, loading fails — there is no
 *    deterministic winner. Identical values are accepted.
 *
 * 3. EMPTY VALUES. A variable set to the empty string is treated as unset
 *    and ignored (shell-friendly way to "remove" an override).
 *
 * 4. TYPE COERCION is driven by the target leaf's schema type:
 *    - boolean: `true/1/yes/on` → true, `false/0/no/off` → false
 *      (case-insensitive); anything else is an error.
 *    - number: `Number(value)` after trimming; must be finite.
 *    - array: if the trimmed value starts with `[` it must parse as a JSON
 *      array; otherwise it is split on commas with items trimmed (empty items
 *      dropped). Elements are coerced recursively per the element schema.
 *    - string: taken verbatim (no trimming).
 *    After coercion the value is validated by the leaf's zod schema; failures
 *    name the env var and the `section.key` it maps to.
 *
 * 5. UNKNOWN NAMES. A `GOLEM_*` variable that does not resolve to a known
 *    `section.key` is ignored with a warning (collected on the loaded config,
 *    surfaced by `golem status`) — never a hard failure, so future versions
 *    and sibling tooling can share the prefix.
 */

import { z } from "zod";
import { ConfigError } from "./errors.js";
import { leafSchema } from "./schema.js";

export const ENV_PREFIX = "GOLEM_";

const TRUE_TOKENS = new Set(["true", "1", "yes", "on"]);
const FALSE_TOKENS = new Set(["false", "0", "no", "off"]);

export interface EnvOverride {
  readonly section: string;
  readonly key: string;
  /** Coerced, schema-validated value. */
  readonly value: unknown;
  /** The raw environment variable name the value came from. */
  readonly varName: string;
}

export interface EnvLayer {
  readonly overrides: readonly EnvOverride[];
  readonly warnings: readonly string[];
}

/**
 * Extract the env override layer from an environment object.
 * Throws ConfigError on ambiguous case collisions, coercion failures, and
 * schema-invalid values; collects warnings for unrecognized `GOLEM_*` names.
 */
export function readEnvLayer(env: Readonly<Record<string, string | undefined>>): EnvLayer {
  // Normalize case first (rule 1) and detect collisions (rule 2).
  const byNormalized = new Map<string, { rawName: string; value: string }>();
  for (const rawName of Object.keys(env).sort()) {
    const value = env[rawName];
    if (value === undefined) {
      continue;
    }
    const normalized = rawName.toUpperCase();
    if (!normalized.startsWith(ENV_PREFIX)) {
      continue;
    }
    const existing = byNormalized.get(normalized);
    if (existing !== undefined && existing.value !== value) {
      throw new ConfigError(
        `ambiguous environment overrides: "${existing.rawName}" and "${rawName}" are the same ` +
          `variable on case-insensitive platforms but have different values`,
        { source: rawName },
      );
    }
    if (existing === undefined) {
      byNormalized.set(normalized, { rawName, value });
    }
  }

  const overrides: EnvOverride[] = [];
  const warnings: string[] = [];

  for (const [normalized, { rawName, value }] of byNormalized) {
    if (value === "") {
      continue; // rule 3: empty string means unset
    }
    const rest = normalized.slice(ENV_PREFIX.length);
    const splitAt = rest.indexOf("_");
    const section = splitAt === -1 ? rest.toLowerCase() : rest.slice(0, splitAt).toLowerCase();
    const key = splitAt === -1 ? "" : rest.slice(splitAt + 1).toLowerCase();
    const leaf = key === "" ? undefined : leafSchema(section, key);
    if (leaf === undefined) {
      warnings.push(
        `environment variable "${rawName}" does not match any known setting ` +
          `(expected GOLEM_<SECTION>_<KEY>); ignored`,
      );
      continue;
    }
    const coerced = coerceEnvValue(value, leaf, rawName);
    const parsed = leaf.safeParse(coerced);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => i.message).join("; ");
      throw new ConfigError(
        `environment variable "${rawName}" has an invalid value for "${section}.${key}": ${issues}`,
        { source: rawName, key: `${section}.${key}` },
      );
    }
    overrides.push({ section, key, value: parsed.data, varName: rawName });
  }

  return { overrides, warnings };
}

/** Strip Optional/Default wrappers to find the base type for coercion. */
function baseType(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (;;) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap() as z.ZodTypeAny;
    } else if (current instanceof z.ZodDefault) {
      current = current.removeDefault() as z.ZodTypeAny;
    } else {
      return current;
    }
  }
}

/** Coerce a raw string env value toward the leaf's schema type (rule 4). */
export function coerceEnvValue(raw: string, leaf: z.ZodTypeAny, varName: string): unknown {
  const target = baseType(leaf);

  if (target instanceof z.ZodBoolean) {
    const token = raw.trim().toLowerCase();
    if (TRUE_TOKENS.has(token)) {
      return true;
    }
    if (FALSE_TOKENS.has(token)) {
      return false;
    }
    throw new ConfigError(
      `environment variable "${varName}" must be a boolean ` +
        `(true/1/yes/on or false/0/no/off), got "${raw}"`,
      { source: varName },
    );
  }

  if (target instanceof z.ZodNumber) {
    const trimmed = raw.trim();
    const num = trimmed === "" ? Number.NaN : Number(trimmed);
    if (!Number.isFinite(num)) {
      throw new ConfigError(`environment variable "${varName}" must be a number, got "${raw}"`, {
        source: varName,
      });
    }
    return num;
  }

  if (target instanceof z.ZodArray) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        throw new ConfigError(
          `environment variable "${varName}" looks like a JSON array but does not parse: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          { source: varName },
        );
      }
      if (!Array.isArray(parsed)) {
        throw new ConfigError(
          `environment variable "${varName}" must be a JSON array when it starts with "["`,
          { source: varName },
        );
      }
      return parsed;
    }
    const element = target.element as z.ZodTypeAny;
    return trimmed
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "")
      .map((item) => coerceEnvValue(item, element, varName));
  }

  // Strings (incl. URLs) and anything else: verbatim, let zod validate.
  return raw;
}
