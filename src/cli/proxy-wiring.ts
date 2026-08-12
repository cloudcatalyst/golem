/**
 * Claude Code ↔ Golem proxy WIRING — the `.claude/settings.json` `env` entries
 * that point Claude Code at the local proxy, and the ownership rule that decides
 * when Golem may remove them.
 *
 * Split out of `init.ts` for Decision 56: `golem proxy unwire`/`wire` need the
 * same ownership-guarded edit that `golem uninit` performs, and re-deriving that
 * guard is how a third party's `ANTHROPIC_BASE_URL` eventually gets clobbered.
 * `init.ts` imports the constants and {@link removeGolemEnv} from here so there
 * is exactly one definition of "is this wiring ours?".
 *
 * **The ownership rule.** Golem removes an env key only when it holds *Golem's
 * own* value for this project — `ANTHROPIC_BASE_URL === http://localhost:<our
 * port>`. A base URL naming any other host belongs to another proxy or gateway
 * and is never touched, only reported (verification-notes §112(d)).
 *
 * **Why unwiring alone is not a fix.** `env` in `settings.json` is NOT
 * hot-reloaded by Claude Code (verification-notes §13/§112(b)) — only
 * `permissions`, `hooks` and `apiKeyHelper` are. Removing the key takes effect on
 * the next session, so every caller must surface the required reload rather than
 * report success and leave a broken editor. {@link UnwireResult.needsReload} is
 * that signal.
 */

import path, { resolve } from "node:path";
import { loopbackCaPath } from "../proxy/loopback-cert.js";
import {
  type JsonObject,
  readJsonObject,
  readJsonObjectOrNull,
  writeJsonObject,
} from "./json-file.js";

export const ENV_BASE_URL = "ANTHROPIC_BASE_URL";
export const ENV_TOOL_SEARCH = "ENABLE_TOOL_SEARCH";
/**
 * R9.12: the trust anchor for the loopback stub endpoint, which is what lets a
 * cache-served WebFetch render green instead of as a denied tool call. Read ONCE
 * at Claude Code startup (§112), so setting it needs a restart to take effect.
 * Golem sets it only when nothing else owns it — see §121-C.
 */
export const ENV_EXTRA_CA = "NODE_EXTRA_CA_CERTS";
export const ENV_USE_FOUNDRY = "CLAUDE_CODE_USE_FOUNDRY";
export const ENV_FOUNDRY_BASE_URL = "ANTHROPIC_FOUNDRY_BASE_URL";

/** `http://localhost:<port>` — the base URL init writes for a given proxy port. */
export function proxyBaseUrl(port: number): string {
  return `http://localhost:${port}`;
}

export function claudeSettingsPath(projectDir: string): string {
  return path.join(projectDir, ".claude", "settings.json");
}

/**
 * R9.22 — the gitignored, machine-local settings scope, and the only correct
 * home for a machine-absolute path.
 *
 * `.claude/settings.json` is COMMITTED, so an absolute `NODE_EXTRA_CA_CERTS`
 * written there travels to every clone and resolves on none of them: Claude Code
 * then warns twice at every start about a certificate the reader never asked
 * for. The local file is gitignored and sits ABOVE the committed one in Claude
 * Code's precedence ladder (managed → CLI args → `settings.local.json` →
 * `settings.json` → `~/.claude/settings.json`, notes §13), so moving the key
 * here changes nothing about how it is read — only about who receives it.
 *
 * `ANTHROPIC_BASE_URL` deliberately stays in the committed file:
 * `http://localhost:<port>` is portable, and its presence is what tells a
 * teammate the project is wired.
 */
export function claudeLocalSettingsPath(projectDir: string): string {
  return path.join(projectDir, ".claude", "settings.local.json");
}

/**
 * Path equality as the filesystem sees it: resolved, and case-folded on win32
 * only. A user-typed path and one from `join` differ in case and separator on
 * Windows, and a false "not ours" silently drops the green WebFetch path; case
 * folding everywhere would instead merge two genuinely distinct files on POSIX.
 * One definition, because this comparison decides ownership in three places
 * (here, `init.ts`, `status.ts`) and three copies drift.
 */
export function samePath(a: string, b: string): boolean {
  const [ra, rb] = [resolve(a), resolve(b)];
  return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

function segmentsOf(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s.length > 0);
}

/**
 * R9.22 — is this a Golem loopback CA from SOMEONE ELSE'S checkout?
 *
 * True when `value` is not our path but ends in the same trailing segments ours
 * does (`.golem/loopback/ca.pem`), i.e. the same file under a different repo
 * root or drive letter. That is the signature of a path an older `golem init`
 * committed on another machine, and recognising it is what lets a fresh clone
 * self-heal on first init instead of inheriting a dead path.
 *
 * The tail is read off `ourCaPath` rather than hard-coded, so it follows
 * `loopbackCaPath` if that ever moves. Deliberately narrow: anything that does
 * NOT match this shape is assumed to be the user's own trust bundle and is never
 * touched (§121-C).
 */
export function isStaleGolemCaPath(value: string, ourCaPath: string): boolean {
  if (value.length === 0 || samePath(value, ourCaPath)) return false;
  const fold = (s: string): string => (process.platform === "win32" ? s.toLowerCase() : s);
  const ours = segmentsOf(ourCaPath).slice(-3).map(fold);
  const tail = segmentsOf(value).slice(-3).map(fold);
  return tail.length === ours.length && tail.every((s, i) => s === ours[i]);
}

/**
 * Delete the env entries Golem owns, in place, and report whether anything
 * changed. Pure apart from the mutation of `envObj`, so the ownership rule is
 * unit-testable without a filesystem.
 *
 * Only removes a key when it holds Golem's value for `baseUrl`: a foreign
 * `ANTHROPIC_BASE_URL`, or a Foundry base URL pointing somewhere else, is left
 * exactly as found. `ENABLE_TOOL_SEARCH` is removed only when it is the `"true"`
 * init wrote (notes §12 — init sets it *because* a non-first-party base URL
 * disables tool search, so it is Golem's key while our wiring is present).
 */
export function removeGolemEnv(envObj: JsonObject, baseUrl: string, caPath?: string): boolean {
  let changed = false;
  if (envObj[ENV_BASE_URL] === baseUrl) {
    delete envObj[ENV_BASE_URL];
    changed = true;
  }
  // R9.12: the loopback CA trust, removed on the same "only if it is ours" rule.
  // A `NODE_EXTRA_CA_CERTS` pointing anywhere else belongs to the user (§121-C)
  // and un-wiring Golem must not disturb it. R9.22 widens "ours" by exactly one
  // case: a Golem CA path from ANOTHER checkout is still Golem's output, so
  // uninit clears the committed leftover rather than leaving a dead path behind.
  if (caPath !== undefined && typeof envObj[ENV_EXTRA_CA] === "string") {
    const current = envObj[ENV_EXTRA_CA] as string;
    if (samePath(current, caPath) || isStaleGolemCaPath(current, caPath)) {
      delete envObj[ENV_EXTRA_CA];
      changed = true;
    }
  }
  if (envObj[ENV_FOUNDRY_BASE_URL] === `${baseUrl}/anthropic`) {
    delete envObj[ENV_FOUNDRY_BASE_URL];
    if (envObj[ENV_USE_FOUNDRY] === "true") delete envObj[ENV_USE_FOUNDRY];
    changed = true;
  }
  if (envObj[ENV_TOOL_SEARCH] === "true") {
    delete envObj[ENV_TOOL_SEARCH];
    changed = true;
  }
  return changed;
}

/** What a base URL found in `.claude/settings.json` belongs to. */
export type WiringOwner = "golem" | "foreign" | "none";

export interface WiringState {
  readonly owner: WiringOwner;
  /** The `ANTHROPIC_BASE_URL` actually present, if any. */
  readonly baseUrl: string | null;
}

function envOf(settings: JsonObject | null): JsonObject | null {
  const env = settings?.env;
  return typeof env === "object" && env !== null && !Array.isArray(env)
    ? (env as JsonObject)
    : null;
}

/**
 * Is this project currently wired to OUR proxy, someone else's, or nothing?
 *
 * Read-only, and on the `golem status` / statusline path — so it uses the quiet
 * reader: an unparseable settings file reports "not wired" rather than throwing
 * at someone who only asked for status. The WRITE paths below deliberately use
 * the loud one.
 */
export async function readWiringState(projectDir: string, baseUrl: string): Promise<WiringState> {
  const env = envOf(await readJsonObjectOrNull(claudeSettingsPath(projectDir)));
  const current = env?.[ENV_BASE_URL];
  if (typeof current !== "string") return { owner: "none", baseUrl: null };
  return { owner: current === baseUrl ? "golem" : "foreign", baseUrl: current };
}

/**
 * Why a *running* proxy is nonetheless not carrying this project's traffic.
 * `problem` states it; `remedy` is null when the fix is not Golem's to make.
 */
export interface WiringGap {
  readonly problem: string;
  readonly remedy: string | null;
}

/**
 * R8.32 — describe the gap between "the port is served" and "Claude Code uses
 * it", or `null` when the wiring does point at us.
 *
 * The mirror image of the R8.31 dead-port warning, and strictly worse. There,
 * live wiring pointed at a port nothing served, and the next request failed
 * loudly. Here the port IS served and the wiring is absent, so requests
 * **succeed** while bypassing redaction, compression and telemetry entirely.
 * Nothing fails, so nothing tells the user — which is why every status surface
 * has to ask, and why they all ask through this one function rather than
 * re-deriving the wording (four near-identical strings drift, and the drift is
 * always in the direction of reassurance).
 *
 * `foreign` gets a different answer from `none` on purpose: another gateway
 * owning the project's traffic is the human's decision, and the ownership rule
 * above forbids touching it — so `golem proxy wire` is NOT offered there.
 */
export function wiringGap(state: WiringState, ourBaseUrl: string): WiringGap | null {
  if (state.owner === "golem") return null;
  if (state.owner === "foreign") {
    return {
      problem: `Claude Code is wired to ${state.baseUrl} — another proxy or gateway owns this project's traffic, so Golem is NOT in the request path.`,
      remedy: null,
    };
  }
  return {
    problem: `Claude Code has no ${ENV_BASE_URL} — it talks to the upstream DIRECTLY, so Golem is NOT in the request path (no redaction, no compression, no telemetry).`,
    remedy: `\`golem proxy wire\` points it at ${ourBaseUrl} (needs a window reload).`,
  };
}

export interface UnwireResult {
  /** Did the file change? False when already unwired, or when the wiring is foreign. */
  readonly changed: boolean;
  /** Set when an `ANTHROPIC_BASE_URL` we do NOT own was found and deliberately left alone. */
  readonly foreignBaseUrl?: string;
  /**
   * True whenever the file changed — Claude Code does not hot-reload `env`
   * (§13/§112b), so the running session keeps the old value until it restarts.
   * Callers MUST surface this; reporting a bare success is the defect Decision 56
   * exists to remove.
   */
  readonly needsReload: boolean;
}

/**
 * Remove Golem's wiring from `.claude/settings.json`, leaving a foreign base URL
 * untouched. Idempotent: unwiring an already-unwired project is a no-op.
 */
export async function unwireProxyEnv(
  projectDir: string,
  baseUrl: string,
  opts: { readonly dryRun?: boolean } = {},
): Promise<UnwireResult> {
  const file = claudeSettingsPath(projectDir);
  const settings = await readJsonObject(file);
  const env = envOf(settings);

  const current = env?.[ENV_BASE_URL];
  if (typeof current === "string" && current !== baseUrl) {
    return { changed: false, foreignBaseUrl: current, needsReload: false };
  }

  // R9.22: the CA trust lives in the LOCAL scope now, so unwiring has to visit
  // both files — and it must still run when the committed file has no `env` at
  // all, which is the normal shape once the CA key moved out of it.
  const localChanged = await removeLocalCaTrust(projectDir, opts);

  let committedChanged = false;
  if (settings !== null && env !== null) {
    committedChanged = removeGolemEnv(env, baseUrl, loopbackCaPath(projectDir));
    if (committedChanged) {
      if (Object.keys(env).length === 0) delete settings.env;
      if (opts.dryRun !== true) await writeJsonObject(file, settings);
    }
  }

  const changed = committedChanged || localChanged;
  return { changed, needsReload: changed };
}

/**
 * R9.22 — drop Golem's `NODE_EXTRA_CA_CERTS` from `.claude/settings.local.json`,
 * on the same ownership rule as everything else here: only a path that is ours,
 * or a stale Golem path from another checkout, is removed. Returns whether the
 * file changed. The file itself is left in place even when it empties out — it
 * is gitignored and frequently holds settings that are not ours.
 */
export async function removeLocalCaTrust(
  projectDir: string,
  opts: { readonly dryRun?: boolean } = {},
): Promise<boolean> {
  const file = claudeLocalSettingsPath(projectDir);
  const settings = await readJsonObject(file);
  const env = envOf(settings);
  if (settings === null || env === null) return false;

  const current = env[ENV_EXTRA_CA];
  const ourCa = loopbackCaPath(projectDir);
  if (typeof current !== "string") return false;
  if (!samePath(current, ourCa) && !isStaleGolemCaPath(current, ourCa)) return false;

  delete env[ENV_EXTRA_CA];
  if (Object.keys(env).length === 0) delete settings.env;
  if (opts.dryRun !== true) await writeJsonObject(file, settings);
  return true;
}

/** What {@link writeLocalCaTrust} did — each field maps to one reported action. */
export interface LocalCaTrustResult {
  /** The local file now carries our CA path (false when it already did). */
  readonly wrote: boolean;
  /** A Golem CA path was found in the COMMITTED file and removed from it. */
  readonly healedCommitted: boolean;
  /** Someone else's `NODE_EXTRA_CA_CERTS`; nothing was written (§121-C). */
  readonly foreign?: string;
}

/**
 * R9.22 — put the loopback CA trust where a machine-absolute path belongs, and
 * clean up the committed file if an earlier init left one there.
 *
 * Ownership is settled before anything is written (§121-C): if EITHER file holds
 * a `NODE_EXTRA_CA_CERTS` that is neither ours nor a stale Golem path, it is the
 * user's — a TLS-inspection bundle, typically — and both files are left exactly
 * as found, reported as `foreign`. Concatenating bundles is not an option: the
 * copy goes stale when theirs rotates.
 *
 * Otherwise the committed value (ours, or a teammate's dead path) is deleted and
 * the local file is brought to `caPath`. Both halves matter: writing the local
 * file without healing the committed one leaves the stale path shadowed but
 * still in everyone's diff.
 */
export async function writeLocalCaTrust(
  projectDir: string,
  caPath: string,
  opts: { readonly dryRun?: boolean } = {},
): Promise<LocalCaTrustResult> {
  const localFile = claudeLocalSettingsPath(projectDir);
  const committedFile = claudeSettingsPath(projectDir);
  const localSettings = (await readJsonObject(localFile)) ?? {};
  const committedSettings = await readJsonObject(committedFile);

  const ownedByUs = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length > 0 &&
    (samePath(value, caPath) || isStaleGolemCaPath(value, caPath));
  const foreignValue = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 && !ownedByUs(value) ? value : null;

  const localEnv = envOf(localSettings);
  const committedEnv = envOf(committedSettings);
  const foreign =
    foreignValue(localEnv?.[ENV_EXTRA_CA]) ?? foreignValue(committedEnv?.[ENV_EXTRA_CA]);
  if (foreign !== null) return { wrote: false, healedCommitted: false, foreign };

  let healedCommitted = false;
  if (
    committedSettings !== null &&
    committedEnv !== null &&
    ownedByUs(committedEnv[ENV_EXTRA_CA])
  ) {
    delete committedEnv[ENV_EXTRA_CA];
    if (Object.keys(committedEnv).length === 0) delete committedSettings.env;
    healedCommitted = true;
    if (opts.dryRun !== true) await writeJsonObject(committedFile, committedSettings);
  }

  const currentLocal = localEnv?.[ENV_EXTRA_CA];
  const alreadySet = typeof currentLocal === "string" && samePath(currentLocal, caPath);
  if (!alreadySet) {
    const env = localEnv ?? {};
    env[ENV_EXTRA_CA] = caPath;
    localSettings.env = env;
    if (opts.dryRun !== true) await writeJsonObject(localFile, localSettings);
  }
  return { wrote: !alreadySet, healedCommitted };
}

export interface WireResult {
  readonly changed: boolean;
  /** A foreign base URL blocks re-wiring — we refuse rather than overwrite it. */
  readonly foreignBaseUrl?: string;
  readonly needsReload: boolean;
}

/**
 * Point Claude Code back at the local proxy — the inverse of
 * {@link unwireProxyEnv}. Refuses when a foreign `ANTHROPIC_BASE_URL` is present,
 * matching `golem init`'s conflict rule: another gateway owning this project's
 * traffic is a decision for the human, not something to overwrite.
 */
export async function wireProxyEnv(
  projectDir: string,
  baseUrl: string,
  opts: { readonly dryRun?: boolean } = {},
): Promise<WireResult> {
  const file = claudeSettingsPath(projectDir);
  // The loud reader, on purpose. This used to swallow a parse failure and fall
  // back to `{}` — which then got WRITTEN, replacing a user's whole
  // `.claude/settings.json` with nothing but an env block. `golem init` has
  // always refused to clobber a file it cannot parse; `golem proxy wire`
  // silently did the opposite.
  const settings = (await readJsonObject(file)) ?? {};
  const existing = envOf(settings);
  const env: JsonObject = existing ?? {};

  const current = env[ENV_BASE_URL];
  if (typeof current === "string" && current !== baseUrl) {
    return { changed: false, foreignBaseUrl: current, needsReload: false };
  }
  if (current === baseUrl && env[ENV_TOOL_SEARCH] === "true") {
    return { changed: false, needsReload: false };
  }

  env[ENV_BASE_URL] = baseUrl;
  env[ENV_TOOL_SEARCH] = "true"; // notes §12: re-enable tool search behind a gateway
  settings.env = env;
  if (opts.dryRun !== true) await writeJsonObject(file, settings);
  return { changed: true, needsReload: true };
}
