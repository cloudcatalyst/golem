/**
 * R9.6 — settings key migrations.
 *
 * Golem had no migration machinery. A settings file naming a key that no longer
 * exists loads with **exit 0** and a warning that only `golem status` prints, so
 * the setting silently stops taking effect while every surface reports success.
 * That is the failure class this project keeps rediscovering (R8.32's
 * running-but-unwired proxy, R9.4's status line naming a model that could never
 * run): a silent no-op is worse than an error.
 *
 * The one prior rename (R9.1's `proxy.active_account` → `proxy.default_target`)
 * was handled by a bespoke read-time fallback inside `resolveDefaultTargetId`.
 * It worked and was unreusable — the next rename would hand-roll the same idea
 * somewhere else, or forget to. This table is that idea, once.
 *
 * **This module never rewrites the user's file.** Reading the old key is enough;
 * silently editing user-authored config would be a worse precedent than the
 * problem (see the task's Out of scope).
 */

import { leafSchema } from "./schema.js";

/** One renamed setting: `from` is the retired dotted path, `to` the live one. */
export interface SettingMigration {
  /** Retired dotted `section.key`, as it may still appear in a settings file. */
  readonly from: string;
  /** The dotted `section.key` that replaced it. */
  readonly to: string;
  /** Task or release that renamed it — quoted in the warning so it is traceable. */
  readonly since: string;
}

/**
 * Every rename Golem honours, oldest first.
 *
 * **Leaf renames only.** The env mapping splits `GOLEM_<SECTION>_<KEY>` on the
 * first underscore after the prefix, so renaming a *section* would change how
 * every one of its env vars parses. Section renames are deliberately refused
 * rather than half-supported — see {@link assertLeafRename}.
 */
export const SETTING_MIGRATIONS: readonly SettingMigration[] = [
  {
    from: "proxy.active_account",
    to: "proxy.default_target",
    since: "R9.1",
  },
  {
    // R9.23: renamed `accounts` to `gateways` — the new key carries a `models`
    // array instead of a single `model`.
    from: "proxy.accounts",
    to: "proxy.gateways",
    since: "R9.23",
  },
];

/**
 * A setting that is GONE, with no leaf to migrate to.
 *
 * Distinct from {@link SETTING_MIGRATIONS} on purpose. A rename has a
 * destination leaf, so the old key can keep working while warning. A retirement
 * has no destination the loader can write to — `inference.default_coder`'s
 * replacement is `inference.personas.coder.model`, a FIELD inside a record, and
 * `assertLeafRename` rightly refuses to call that a leaf rename.
 *
 * So a retired key **raises** rather than warning. That is the harsher choice
 * and the correct one here: this module exists because "the setting silently
 * stops taking effect while every surface reports success" is the failure class
 * this project keeps rediscovering. A warning nobody reads would reproduce it
 * exactly — the file would still say `default_coder` and the user would still
 * believe a model was selected.
 */
export interface RetiredSetting {
  /** The dotted path that no longer exists. */
  readonly path: string;
  /** What to write instead — prose, because the replacement may not be a leaf. */
  readonly replacement: string;
  /** Task that retired it, quoted in the error so it is traceable. */
  readonly since: string;
}

export const RETIRED_SETTINGS: readonly RetiredSetting[] = [
  {
    path: "inference.default_coder",
    replacement:
      'inference.personas.coder.model (e.g. { "personas": { "coder": { "model": "…" } } })',
    since: "R14.1",
  },
];

/** The retirement record for a dotted path, or undefined if it is not retired. */
export function retirementFor(dotted: string): RetiredSetting | undefined {
  return RETIRED_SETTINGS.find((r) => r.path === dotted);
}

/** The message a retired key raises — names the file, the key, and the replacement. */
export function retirementMessage(retired: RetiredSetting, label: string): string {
  return (
    `${label}: "${retired.path}" was retired in ${retired.since} and no longer does anything. ` +
    `Use ${retired.replacement} instead. ` +
    "Golem raises rather than ignoring it, so the setting cannot silently stop taking effect."
  );
}

/** Section of a dotted path, or the whole string when it has no dot. */
function sectionOf(dotted: string): string {
  const i = dotted.indexOf(".");
  return i === -1 ? dotted : dotted.slice(0, i);
}

function splitLeaf(dotted: string): readonly [string, string | undefined] {
  const i = dotted.indexOf(".");
  if (i === -1) return [dotted, undefined];
  return [dotted.slice(0, i), dotted.slice(i + 1)];
}

/**
 * Guard invoked by the table's own test: a migration may not move a key between
 * sections, its `to` must be a live leaf, and its `from` must NOT be. A
 * migration pointing at a key that no longer exists would reintroduce exactly
 * the silent no-op it exists to prevent, one level further down.
 */
export function assertLeafRename(m: SettingMigration): string | undefined {
  if (sectionOf(m.from) !== sectionOf(m.to)) {
    // A pre-authorised exemption for ONE cross-section rename. Cross-section
    // renames break env-var mapping (GOLEM_PROXY_* → GOLEM_INFERENCE_*), which
    // is why they are refused in general; this pair was reviewed and accepted
    // because the old env var is retired too.
    //
    // Note it does not currently fire: SETTING_MIGRATIONS routes
    // `proxy.active_account` to `proxy.default_target` (same section), and
    // `proxy.default_target` is the deprecated leaf that resolves onward to
    // `inference.default_target`. The exemption is kept so that collapsing
    // those two hops into one direct migration stays a one-line table change
    // rather than a guard change — but it is dead against today's table.
    if (m.from === "proxy.active_account" && m.to === "inference.default_target") {
      return undefined;
    }
    return (
      `migration ${m.from} → ${m.to} crosses sections; section renames are not ` +
      "supported (GOLEM_<SECTION>_<KEY> parsing splits on the section boundary)"
    );
  }
  const [toSection, toKey] = splitLeaf(m.to);
  if (toKey === undefined || leafSchema(toSection, toKey) === undefined) {
    return `migration ${m.from} → ${m.to} targets "${m.to}", which is not a live setting`;
  }
  const [fromSection, fromKey] = splitLeaf(m.from);
  if (fromKey !== undefined && leafSchema(fromSection, fromKey) !== undefined) {
    return (
      `migration ${m.from} → ${m.to} names "${m.from}", which is STILL a live ` +
      "setting — retire it from SETTINGS_LEAVES or drop the migration, else both " +
      "keys are writable and the rename is a fiction"
    );
  }
  return undefined;
}

/** The migration retiring `dotted`, or undefined when it is not a renamed key. */
export function migrationFrom(dotted: string): SettingMigration | undefined {
  return SETTING_MIGRATIONS.find((m) => m.from === dotted);
}

/**
 * Resolve a possibly-retired dotted key to the live one.
 *
 * Returns the input unchanged when it names no migration, so callers can pass
 * any user-supplied key through without branching.
 */
export function liveKeyFor(dotted: string): string {
  return migrationFrom(dotted)?.to ?? dotted;
}

/**
 * The sentence shown when a settings file still names a retired key.
 *
 * Says what happened, what is being read instead, and what to change — a
 * warning the reader cannot act on is the same as no warning.
 */
export function migrationWarning(m: SettingMigration, label: string): string {
  return (
    `${label}: setting "${m.from}" was renamed to "${m.to}" in ${m.since}. ` +
    "The old name is still read, so nothing is broken — rename the key in that " +
    "file to stop relying on the fallback."
  );
}

/** The sentence shown when one layer sets BOTH the retired key and its replacement. */
export function migrationShadowedWarning(m: SettingMigration, label: string): string {
  return (
    `${label}: sets both "${m.from}" (renamed in ${m.since}) and "${m.to}"; ` +
    `"${m.to}" wins and the old key is ignored. Delete "${m.from}" from that file.`
  );
}
