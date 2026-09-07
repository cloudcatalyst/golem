/**
 * Layered config loader (E1), resolving the ADR-0008 cascade.
 *
 * Every declaration is either NORMAL or IMPORTANT, and the two bands resolve
 * one after the other. Normal declarations cascade in origin order; important
 * ones cascade afterwards in REVERSED origin order, so every important
 * declaration beats every normal one and the strongest importance belongs to
 * the most foundational origin:
 *
 *               NORMAL  (low → high)          IMPORTANT  (low → high)
 *     weakest   default                       override!
 *               user                          env!
 *               team                          local!
 *               project                       project!
 *               local                         team!
 *               env                           user!
 *    strongest  override                      default!
 *
 * {@link ORIGIN_ORDER} is that ladder, and it is the ONLY place the ranking
 * lives: pass 1 reads it forwards, pass 2 reads it reversed. Two hand-kept
 * lists that must stay mirror images is a bug waiting for the next origin.
 *
 * An origin declares importance with a top-level `"!important"` array of
 * dotted `section.key` strings, sibling to the sections:
 *
 *     { "telemetry": { "enabled": false }, "!important": ["telemetry.enabled"] }
 *
 * Values themselves are untouched by this — deliberately, so every zod leaf in
 * schema.ts keeps `safeParse`-ing exactly the shape it parses today (ADR-0008
 * rejected a `{"$value": …, "$important": true}` wrapper for that reason).
 *
 * `env` and `override` contribute NORMAL declarations only: there is no syntax
 * for importance in an env var and inventing one is out of scope. Their rows in
 * the important band define the ordering; nothing produces them. The live
 * consequence is that a file origin's `!important` now beats `GOLEM_*`, which
 * reverses the previously shipped position — see ADR-0008 §The env reversal.
 *
 * Merging is per LEAF (`section.key`): a layer that sets `proxy.port` does
 * not disturb `proxy.upstream_base_url` from a lower layer. Arrays replace
 * wholesale (no element merging).
 *
 * Error/warning policy (deterministic, applied identically to every layer):
 * - Missing files, empty/whitespace-only files: fine — layer contributes
 *   nothing.
 * - Malformed JSON, non-object roots/sections, or a KNOWN key with an
 *   invalid value: hard ConfigError naming the file (or env var / overrides
 *   layer) and the `section.key`.
 * - UNKNOWN sections/keys: ignored with a warning (collected on the result).
 *   They are tolerated — not fatal — so files written by newer Golem versions
 *   or carrying third-party keys still load, and `writeSetting` round-trips
 *   preserve them. `null` is not a valid way to unset a key (delete the key,
 *   or use `writeSetting(scope, key, undefined)`).
 * - A key named in `"!important"` that the origin does not actually set:
 *   warning, not an error. Importance without a value is meaningless, not
 *   dangerous. A malformed `"!important"` (not an array of strings) IS an
 *   error — it is a key Golem owns, not a third-party one to tolerate.
 */

import { readFile } from "node:fs/promises";
import { readEnvLayer } from "./env.js";
import { ConfigError } from "./errors.js";
import { isPlainObject, splitDotted } from "./file-io.js";
import {
  migrationFrom,
  migrationShadowedWarning,
  migrationWarning,
  retirementFor,
  retirementMessage,
} from "./migrations.js";
import { type SettingsFilePaths, settingsFilePaths } from "./paths.js";
import {
  DEFAULT_SETTINGS,
  deepFreeze,
  type GolemSettings,
  leafSchema,
  SECTION_NAMES,
  SETTINGS_LEAVES,
} from "./schema.js";

/** Which layer supplied a value. See {@link ORIGIN_ORDER} for the ranking. */
export type LayerName = "default" | "user" | "team" | "project" | "local" | "env" | "override";

/**
 * The origins, most foundational first — the single source of the ranking.
 *
 * Pass 1 (normal declarations) walks this forwards; pass 2 (important
 * declarations) walks it reversed. Adding an origin means adding it here and
 * nowhere else.
 *
 * `team` is declared but not yet populated by any fetch: `team-layer-fetch`
 * fills it, and {@link LoadConfigOptions.teamLayer} is the slot it fills
 * (`team-settings-layer` was the original owner and is retired — Decision
 * 62(c) — so do not go looking for it). It
 * sits above `user` in the normal band because a team is shared across many
 * projects, so a repo specialising a company default is the expected case
 * rather than a violation (ADR-0008 §The origins).
 */
export const ORIGIN_ORDER: readonly LayerName[] = [
  "default",
  "user",
  "team",
  "project",
  "local",
  "env",
  "override",
];

/**
 * Keys a REMOTE origin may never contribute, at any importance — ADR-0008
 * §The floor.
 *
 * `proxy.bypass_all` is in the settings schema and is therefore writable from a
 * settings file, and R8.33's "only the CLI or this panel" rule was written
 * before any remote origin existed. Without this, importance would create a
 * remote redaction-disable: an admin — or anyone who compromised the portal —
 * could ship `proxy.bypass_all: true` as `team!` and every machine in the org
 * would forward unredacted traffic.
 *
 * The `portal.*` identity keys (`team-portal-auth`) are here for a narrower but
 * equally circular reason: they say WHICH portal to trust and which OAuth client
 * to present, and the team layer is fetched FROM that portal. A remote origin
 * able to move `portal.url` or `portal.issuer` could point the next sign-in at a
 * server of its choosing and harvest the authorization code — a portal
 * redirecting its own clients elsewhere is not a configuration change, it is a
 * handover. `portal.link_timeout_ms` is deliberately NOT denied: it is a
 * convenience with no security weight, and a team with slow SSO has a real
 * reason to raise it.
 *
 * The whole `team.*` section (`project-team-binding`) is denied for the same
 * circularity, one level closer in: those keys say WHICH organization this
 * project belongs to and WHETHER the team layer applies at all. A team origin
 * able to write `team.org_id` could rebind the project to another organization
 * — which is a takeover, not a setting — and one able to write `team.sync` or
 * `team.skills` could switch itself back on for a member who had deliberately
 * turned it off. A layer must not be the thing that decides it is allowed to be
 * a layer, so the binding is only ever writable by a LOCAL file, `golem team
 * link`, or `GOLEM_TEAM_*` on the machine itself.
 *
 * Compiled in, never fetched: a list the remote can edit is not a floor. A
 * denied key is DROPPED with a loud warning, never sanitised in silence.
 * CLAUDE.md governs — importance is a dial, and no dial value disables
 * redaction.
 */
export const REMOTE_DENIED_SETTINGS: ReadonlySet<string> = new Set([
  "proxy.bypass_all",
  "portal.url",
  "portal.issuer",
  "portal.client_id",
  "team.org_id",
  "team.portal_url",
  "team.sync",
  "team.skills",
]);

/** The `"!important"` declaration list, top-level and sibling to the sections. */
const IMPORTANT_KEY = "!important";

/** Which band a declaration resolves in. */
type Band = "normal" | "important";

export interface ProvenanceEntry {
  readonly layer: LayerName;
  /** Absolute file path or env var name; absent for defaults and overrides. */
  readonly source?: string;
  /**
   * R9.6 — the dotted key actually present in the source, when it differs from
   * the leaf this value landed on (i.e. the file still names a renamed setting).
   * Absent in the ordinary case. Reporting the new key here would claim the file
   * says something it does not, which is the dishonesty the migration exists to
   * avoid: the user must be able to find the line they need to edit.
   */
  readonly key?: string;
  /**
   * ADR-0008 — set when the winning declaration came from the IMPORTANT band,
   * i.e. the origin named this key in its `"!important"` list. Absent
   * otherwise, so an install that declares no importance produces provenance
   * byte-identical to the one it produced before this existed.
   */
  readonly important?: true;
}

/** Dotted `section.key` → which layer supplied the effective value. */
export type Provenance = Readonly<Record<string, ProvenanceEntry>>;

/** Per-request override layer: same snake_case two-level shape as the files. */
export type SettingsOverrides = {
  readonly [S in keyof GolemSettings]?: Partial<GolemSettings[S]>;
};

export interface LoadConfigOptions {
  /** Project root containing `.golem/`; defaults to process.cwd(). */
  readonly projectDir?: string;
  /** User config dir; defaults to `~/.golem` (see paths.ts). */
  readonly userDir?: string;
  /** Environment to read `GOLEM_*` overrides from; defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Highest-precedence in-memory layer (e.g. per-request header overrides). */
  readonly overrides?: SettingsOverrides;
  /**
   * The `team` origin's already-resolved payload, same shape as a settings file
   * (sections plus an optional `"!important"` list).
   *
   * The SLOT, not the fetch: `team-layer-fetch` owns retrieving this from the
   * portal and caching it per org to `~/.golem/teams/<org_id>.json` (Decision
   * 63). Nothing in this module reaches the network. Supplying it marks the
   * origin REMOTE, so
   * {@link REMOTE_DENIED_SETTINGS} applies to it.
   */
  readonly teamLayer?: {
    readonly settings: unknown;
    /** Where it came from, for provenance — the team name or the cache path. */
    readonly source?: string;
  };
}

export interface GolemConfig {
  /** Effective settings, deeply frozen. */
  readonly settings: GolemSettings;
  /** Which layer supplied each `section.key` (for `golem status`). */
  readonly provenance: Provenance;
  /** Resolved settings file paths (whether or not the files exist). */
  readonly files: SettingsFilePaths;
  /** Non-fatal issues: unknown keys/sections, unrecognized GOLEM_* vars. */
  readonly warnings: readonly string[];
}

type MutableTree = Record<string, Record<string, unknown>>;

export async function loadConfig(options: LoadConfigOptions = {}): Promise<GolemConfig> {
  const files = settingsFilePaths(options);

  // Layer 0: defaults.
  const tree: MutableTree = {};
  const provenance: Record<string, ProvenanceEntry> = {};
  for (const section of SECTION_NAMES) {
    tree[section] = {
      ...(DEFAULT_SETTINGS[section] as unknown as Record<string, unknown>),
    };
    for (const key of Object.keys(SETTINGS_LEAVES[section])) {
      provenance[`${section}.${key}`] = { layer: "default" };
    }
  }

  const warnings: string[] = [];

  // Every object-shaped origin is read and parsed ONCE. Both bands resolve over
  // the same parsed declarations, so the second pass costs no file I/O.
  const origins = new Map<LayerName, ObjectLayer>();
  const fileOrigins: readonly { readonly layer: LayerName; readonly file: string }[] = [
    { layer: "user", file: files.user },
    { layer: "project", file: files.project },
    { layer: "local", file: files.local },
  ];
  for (const { layer, file } of fileOrigins) {
    const raw = await readSettingsFile(file);
    if (raw !== undefined) {
      origins.set(layer, buildObjectLayer(raw, layer, file, file, false, warnings));
    }
  }
  if (options.teamLayer !== undefined) {
    const { settings: raw, source } = options.teamLayer;
    origins.set(
      "team",
      buildObjectLayer(raw, "team", source, source ?? "team settings", true, warnings),
    );
  }
  if (options.overrides !== undefined) {
    origins.set(
      "override",
      buildObjectLayer(
        options.overrides,
        "override",
        undefined,
        "per-request overrides",
        false,
        warnings,
      ),
    );
  }

  const envLayer = readEnvLayer(options.env ?? process.env);
  warnings.push(...envLayer.warnings);

  // Pass 1 — NORMAL declarations, weakest origin first.
  for (const layer of ORIGIN_ORDER) {
    if (layer === "env") {
      for (const override of envLayer.overrides) {
        const section = tree[override.section];
        if (section !== undefined) {
          section[override.key] = override.value;
          provenance[`${override.section}.${override.key}`] = {
            layer: "env",
            source: override.varName,
          };
        }
      }
      continue;
    }
    const origin = origins.get(layer);
    if (origin !== undefined) {
      applyObjectLayer(tree, provenance, warnings, origin, "normal");
    }
  }

  // Pass 2 — IMPORTANT declarations, in REVERSED origin order, after every
  // normal one has landed. The reversal is the whole point: it is what makes
  // `user!` beat `team!`, and what makes any file's `!important` beat `GOLEM_*`.
  for (const layer of [...ORIGIN_ORDER].reverse()) {
    const origin = origins.get(layer);
    if (origin !== undefined && origin.important.size > 0) {
      applyObjectLayer(tree, provenance, warnings, origin, "important");
    }
  }

  const settings = deepFreeze(tree as unknown as GolemSettings);
  return deepFreeze({
    settings,
    provenance: provenance as Provenance,
    files,
    warnings,
  });
}

/**
 * Read + parse one settings file. Returns undefined when the file is missing
 * or effectively empty; throws ConfigError (naming the file) on unreadable
 * files or malformed JSON.
 */
async function readSettingsFile(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new ConfigError(
      `cannot read settings file ${file}: ${err instanceof Error ? err.message : String(err)}`,
      { source: file },
    );
  }
  // Windows editors may prepend a UTF-8 BOM; JSON.parse rejects it.
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (stripped.trim() === "") {
    return undefined;
  }
  try {
    return JSON.parse(stripped);
  } catch (err) {
    throw new ConfigError(
      `settings file ${file} contains invalid JSON: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      { source: file },
    );
  }
}

/**
 * Leaves that merge PER KEY across layers instead of replacing wholesale.
 *
 * The default — a whole leaf replaced by the highest layer that sets it — is
 * right for a scalar and for a list. It is wrong for a registry keyed by
 * user-chosen ids: a project that declares a bench would silently erase the
 * user's, and restaffing one persona in `settings.local.json` would mean
 * restating every other persona to avoid losing them.
 *
 * Membership is deliberately a short, explicit list rather than "any
 * `z.record` leaf". `inference.worker_targets` is also a record and is NOT
 * here: replacing a target map wholesale is the long-standing behaviour, and
 * changing it silently would be a routing change disguised as a refactor.
 */
const MERGE_PER_KEY_LEAVES: ReadonlySet<string> = new Set(["inference.personas"]);

/**
 * Merge one layer's record-of-objects onto what lower layers built: per key,
 * then per field within a key.
 *
 * Two levels, not a general deep merge. One level would make
 * `{ "reviewer": { "model": "..." } }` in `settings.local.json` drop the
 * project's `discipline` and `description` for that persona, which is exactly
 * the case this exists to serve. Going deeper than two has no meaning here —
 * a persona's fields are scalars and one string array, and `tools` REPLACES
 * (an allow-list you can only add to is not an allow-list).
 *
 * Provenance is recorded per `<leaf>.<id>.<field>` so `golem personas` can say
 * which layer supplied each field, not merely which layer last touched the
 * bench.
 */
function mergePerKey(
  previous: unknown,
  incoming: Record<string, unknown>,
  dotted: string,
  provenance: Record<string, ProvenanceEntry>,
  layer: LayerName,
  sourceFile: string | undefined,
  band: Band,
): Record<string, unknown> {
  const merged: Record<string, unknown> = isPlainObject(previous) ? { ...previous } : {};
  for (const [id, value] of Object.entries(incoming)) {
    if (!isPlainObject(value)) {
      merged[id] = value;
      continue;
    }
    const prior = merged[id];
    merged[id] = isPlainObject(prior) ? { ...prior, ...value } : { ...value };
    for (const field of Object.keys(value)) {
      provenance[`${dotted}.${id}.${field}`] = {
        layer,
        ...(sourceFile !== undefined && { source: sourceFile }),
        ...(band === "important" && { important: true as const }),
      };
    }
  }
  return merged;
}

/**
 * One object-shaped origin, parsed once and read by both bands.
 *
 * `important` holds the dotted keys this origin declared important, spelled as
 * the origin spells them — before any rename migration — because that is the
 * line a reader would have to edit.
 */
interface ObjectLayer {
  readonly layer: LayerName;
  readonly raw: Record<string, unknown>;
  /** Absolute file path (or team source); absent for per-request overrides. */
  readonly sourceFile?: string;
  /** How this origin is named in warnings and errors. */
  readonly label: string;
  readonly important: ReadonlySet<string>;
  /** True when a remote party authored it — {@link REMOTE_DENIED_SETTINGS} applies. */
  readonly remote: boolean;
}

/**
 * Validate one origin's root shape and split its `"!important"` list off from
 * its values, before either band runs.
 *
 * Done here rather than inside {@link applyObjectLayer} so that the important
 * set is known when the NORMAL pass runs — an important declaration must not
 * land in the normal band and then be re-applied in the important one, or a
 * lower origin's normal value would briefly, and visibly, win.
 */
function buildObjectLayer(
  raw: unknown,
  layer: LayerName,
  sourceFile: string | undefined,
  label: string,
  remote: boolean,
  warnings: string[],
): ObjectLayer {
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${label}: settings root must be a JSON object`, {
      ...(sourceFile !== undefined && { source: sourceFile }),
    });
  }

  // What this origin actually sets, so `"!important"` can be checked against it.
  // Unknown and renamed keys count as "set": they get their own warning below,
  // and reporting both for one line would be noise, not clarity.
  const declared = new Set<string>();
  for (const [sectionName, sectionValue] of Object.entries(raw)) {
    if (sectionName === IMPORTANT_KEY || !isPlainObject(sectionValue)) continue;
    for (const key of Object.keys(sectionValue)) declared.add(`${sectionName}.${key}`);
  }

  const important = new Set<string>();
  const listed = raw[IMPORTANT_KEY];
  if (listed !== undefined) {
    if (!Array.isArray(listed) || listed.some((entry) => typeof entry !== "string")) {
      throw new ConfigError(
        `${label}: "${IMPORTANT_KEY}" must be an array of dotted "section.key" strings, ` +
          `got ${describeType(listed)}`,
        { key: IMPORTANT_KEY, ...(sourceFile !== undefined && { source: sourceFile }) },
      );
    }
    for (const dotted of listed as readonly string[]) {
      if (declared.has(dotted)) {
        important.add(dotted);
        continue;
      }
      warnings.push(
        `${label}: "${dotted}" is listed in "${IMPORTANT_KEY}" but this file does not set it — ignored`,
      );
    }
  }

  return {
    layer,
    raw,
    ...(sourceFile !== undefined && { sourceFile }),
    label,
    important,
    remote,
  };
}

/**
 * Apply ONE BAND of one origin to the merge tree, recording provenance and
 * collecting unknown-key warnings.
 *
 * Each declaration belongs to exactly one band, so a key skipped here is a key
 * this origin will contribute in the other pass — which is why per-KEY warnings
 * fire unconditionally (they are emitted once, in the key's own band) while
 * per-SECTION warnings are gated to the normal pass (the same section is walked
 * by both).
 */
function applyObjectLayer(
  tree: MutableTree,
  provenance: Record<string, ProvenanceEntry>,
  warnings: string[],
  origin: ObjectLayer,
  band: Band,
): void {
  const { layer, raw, sourceFile, label, important, remote } = origin;
  for (const [sectionName, sectionValue] of Object.entries(raw)) {
    if (sectionName === IMPORTANT_KEY) {
      continue; // the declaration list, already split out by buildObjectLayer
    }
    if (!(sectionName in SETTINGS_LEAVES)) {
      if (band === "normal") {
        warnings.push(`${label}: unknown settings section "${sectionName}" ignored`);
      }
      continue;
    }
    if (!isPlainObject(sectionValue)) {
      throw new ConfigError(
        `${label}: section "${sectionName}" must be an object of settings, ` +
          `got ${describeType(sectionValue)}`,
        { key: sectionName, ...(sourceFile !== undefined && { source: sourceFile }) },
      );
    }
    for (const [key, value] of Object.entries(sectionValue)) {
      const dotted = `${sectionName}.${key}`;
      // A declaration resolves in exactly one band; the other pass skips it
      // before doing any work, so nothing below can run or warn twice.
      if (important.has(dotted) !== (band === "important")) continue;
      if (remote && REMOTE_DENIED_SETTINGS.has(dotted)) {
        warnings.push(remoteRefusalWarning(label, dotted));
        continue;
      }
      let leaf = leafSchema(sectionName, key);
      // R9.6: the key the value lands on, and the key the FILE named — the same
      // thing except for a renamed setting, where provenance must report the
      // name actually present in the file rather than implying the new one.
      let targetKey = key;
      let fromKey: string | undefined;

      if (leaf === undefined) {
        // A RETIRED key raises before anything else. It is not unknown (we know
        // exactly what it was) and it is not renamed (there is no destination
        // leaf), so neither of the branches below would tell the truth about it.
        const retired = retirementFor(dotted);
        if (retired !== undefined) {
          throw new ConfigError(retirementMessage(retired, label), {
            key: dotted,
            ...(sourceFile !== undefined && { source: sourceFile }),
          });
        }
        const migration = migrationFrom(dotted);
        if (migration === undefined) {
          warnings.push(`${label}: unknown setting "${dotted}" ignored`);
          continue;
        }
        // The replacement set in the SAME layer wins; the old key is reported
        // and dropped. Across layers, normal precedence applies untouched.
        const [, liveKey] = splitDotted(migration.to);
        if (liveKey !== undefined && Object.hasOwn(sectionValue, liveKey)) {
          warnings.push(migrationShadowedWarning(migration, label));
          continue;
        }
        // Exactly one warning per migrated key — never also "unknown setting".
        warnings.push(migrationWarning(migration, label));
        targetKey = liveKey ?? key;
        fromKey = dotted;
        leaf = leafSchema(sectionName, targetKey);
        if (leaf === undefined) continue; // guarded by assertLeafRename's test
        // Checked again on the RESOLVED key: a rename must not be a way for a
        // remote to reach a denied leaf under its old, undenied spelling.
        if (remote && REMOTE_DENIED_SETTINGS.has(`${sectionName}.${targetKey}`)) {
          warnings.push(remoteRefusalWarning(label, `${sectionName}.${targetKey}`));
          continue;
        }
      }

      if (value === undefined) {
        continue; // absent — only possible via in-memory overrides
      }
      const parsed = leaf.safeParse(value);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => i.message).join("; ");
        throw new ConfigError(`${label}: invalid value for "${dotted}": ${issues}`, {
          key: dotted,
          ...(sourceFile !== undefined && { source: sourceFile }),
        });
      }
      const section = tree[sectionName];
      if (section !== undefined) {
        section[targetKey] = MERGE_PER_KEY_LEAVES.has(dotted)
          ? mergePerKey(
              section[targetKey],
              parsed.data as Record<string, unknown>,
              dotted,
              provenance,
              layer,
              sourceFile,
              band,
            )
          : parsed.data;
        provenance[`${sectionName}.${targetKey}`] = {
          layer,
          ...(sourceFile !== undefined && { source: sourceFile }),
          ...(fromKey !== undefined && { key: fromKey }),
          ...(band === "important" && { important: true as const }),
        };
      }
    }
  }
}

/**
 * The one wording for a refused remote key. Loud on purpose: a floor that
 * sanitises quietly leaves an admin believing they set something they did not.
 */
function remoteRefusalWarning(label: string, dotted: string): string {
  return (
    `${label}: REFUSED "${dotted}" — a remote origin may never set it, at any ` +
    `importance (ADR-0008 floor). The value was DROPPED, not applied.`
  );
}

function describeType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "an array" : `a ${typeof value}`;
}
