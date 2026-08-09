/**
 * R6.2 v1 + Decisions 46/47 — `golem account` CLI (spec Decision 21d; ADR-0003, amended).
 *
 * Explicit switching between the user's own configured accounts/providers, plus
 * Golem-managed credentials. ADR-0003 invariants surfaced here:
 * - **No secret is ever printed or stored as a setting.** `list` reports only
 *   WHERE each account's credential resolves from (the OS store, or an opted-in
 *   plaintext file) and whether it resolves at all — never its value; switching
 *   writes only the non-secret `proxy.active_account` selector. Stored
 *   credentials live in the OS credential store (Decision 46), never in
 *   settings, `.golem/` state, or an environment variable (Decision 47).
 * - **Fail-closed.** `use <id>` refuses an id that is not in `proxy.accounts`,
 *   and refuses to switch onto an account whose credential does not resolve
 *   unless you pass `--yes` (no silent switch to an un-credentialed account).
 * - **Audit.** Every switch, login, and logout is appended to
 *   `.golem/state/account-log.jsonl` (non-secret metadata only).
 * - **No orphaned secrets.** `remove <id>` logs the account out first, so
 *   de-registering an account never leaves its key behind in the OS store.
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { defaultUserDir, loadConfig, writeSetting } from "../config/index.js";
import type { ProxySettings } from "../config/schema.js";
import {
  type CredentialFault,
  type CredentialStore,
  canPrompt,
  createCredentialStore,
  DEFAULT_ACCOUNT_ID,
  envVarForAccount,
  type StoreTarget,
} from "../credentials/index.js";
import { probeCredential } from "../credentials/probe.js";
import { PromptCancelled, promptSecret } from "../credentials/prompt.js";
import {
  accountsReferencedByTargets,
  doubledVersionSegment,
  isTranslatingProvider,
} from "../providers/index.js";
import { clearServedModel } from "../proxy/index.js";
import { InitError } from "./init.js";

/**
 * A non-secret account descriptor: either a named `proxy.accounts` entry or the
 * synthetic default built from the top-level `proxy.upstream_*` config. The
 * registry's account shape is not an exported schema type, so this is derived
 * from {@link ProxySettings} (adding the `id` the array element carries).
 */
type RegistryAccount = NonNullable<ProxySettings["accounts"]>[number];
export interface AccountTarget {
  readonly id: string;
  readonly provider: ProxySettings["upstream_provider"];
  readonly base_url: string;
  readonly model?: string;
  readonly auth_scheme: NonNullable<RegistryAccount["auth_scheme"]>;
}

export interface AccountRow {
  readonly id: string;
  readonly provider: string;
  readonly base_url: string;
  readonly model: string | null;
  /** Whether a credential resolves for this account (never the value). */
  readonly key_set: boolean;
  /**
   * Where the credential resolves from — the OS store, or an opted-in plaintext
   * file — so the user can see *why* a key is or isn't picked up (Decision 46).
   * Absent when `key_set` is false.
   */
  readonly key_location?: string;
  /** Credential backends that errored while being consulted (surfaced, not swallowed). */
  readonly key_faults?: readonly CredentialFault[];
  readonly active: boolean;
  /**
   * True for the synthetic DEFAULT account — the top-level upstream config the
   * proxy falls back to when no named account is active. It is not a
   * `proxy.accounts` entry; selecting it just clears `active_account`.
   */
  readonly is_default?: boolean;
}

export interface AccountsReport {
  /**
   * The active account id: a named account, or the synthetic default id (the
   * top-level provider, e.g. `anthropic`) when no named account is active.
   * Never null — the default is always a real, selectable identity.
   */
  readonly active: string;
  /** True when `active_account` is set but not present in the registry (misconfig). */
  readonly active_unknown: boolean;
  readonly accounts: readonly AccountRow[];
}

/**
 * The id of the synthetic DEFAULT account — the top-level upstream config used
 * when no named account is active. It is simply the top-level provider name
 * (e.g. `anthropic`), so the cleared state reads as a real destination rather
 * than "(none)". Selecting it clears `active_account`.
 */
export function defaultAccountId(provider: string): string {
  return provider;
}

/**
 * The credential-store id for the synthetic default account. The display id is
 * the provider name (`anthropic`); the store id is the reserved
 * {@link DEFAULT_ACCOUNT_ID}, so the top-level upstream config's credential is
 * stored under one stable key regardless of which provider it currently names.
 */
const DEFAULT_STORE_ID = DEFAULT_ACCOUNT_ID;

/**
 * Resolve the (provider, base_url, model, auth_scheme, store id) for an account
 * selection — either a named registry account or the synthetic default (the
 * top-level upstream config). Shared by the credential commands so they probe
 * and store against exactly what the proxy would use.
 */
async function resolveAccountTarget(
  projectDir: string,
  id: string,
): Promise<{
  readonly storeId: string;
  readonly account: AccountTarget;
  readonly isDefault: boolean;
}> {
  const { settings } = await loadConfig({ projectDir });
  const p = settings.proxy;
  if (id === defaultAccountId(p.upstream_provider) || id === DEFAULT_STORE_ID) {
    return {
      storeId: DEFAULT_STORE_ID,
      isDefault: true,
      account: {
        id: defaultAccountId(p.upstream_provider),
        provider: p.upstream_provider,
        base_url: p.upstream_base_url,
        ...(p.upstream_model !== undefined ? { model: p.upstream_model } : {}),
        auth_scheme: p.upstream_auth_scheme,
      },
    };
  }
  const found = (p.accounts ?? []).find((a) => a.id === id);
  if (found === undefined) {
    const ids = (p.accounts ?? []).map((a) => a.id).join(", ") || "(none configured)";
    throw new InitError(`unknown account "${id}"; configured accounts: ${ids}`);
  }
  return {
    storeId: found.id,
    isDefault: false,
    account: {
      id: found.id,
      provider: found.provider,
      base_url: found.base_url,
      ...(found.model !== undefined ? { model: found.model } : {}),
      auth_scheme: found.auth_scheme ?? "inherit",
    },
  };
}

/**
 * Read the account registry + which is active (best-effort; never reads secret
 * values). `env` overrides the process environment used for the non-secret
 * `GOLEM_<SECTION>_<KEY>` settings overrides only — credentials come from the
 * OS store, never the environment (Decision 47), so on a machine with a stored
 * key the `key_set` flags are true regardless of what `env` says.
 */
export async function collectAccounts(
  projectDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  opts: { readonly store_backend?: CredentialStore } = {},
): Promise<AccountsReport> {
  const { settings } = await loadConfig({ projectDir, env });
  const selected = settings.proxy.default_target ?? null;
  const accounts = settings.proxy.accounts ?? [];
  const defaultId = defaultAccountId(settings.proxy.upstream_provider);
  const store = opts.store_backend ?? createCredentialStore({ userDir: defaultUserDir() });

  // The default is active whenever no named account is selected, or the
  // selection names the default id itself.
  const defaultActive = selected === null || selected === defaultId;
  const defStatus = await store.status(DEFAULT_STORE_ID);
  const defaultRow: AccountRow = {
    id: defaultId,
    provider: settings.proxy.upstream_provider,
    base_url: settings.proxy.upstream_base_url,
    model: settings.proxy.upstream_model ?? null,
    key_set: defStatus.present,
    ...(defStatus.location !== undefined ? { key_location: defStatus.location.label } : {}),
    ...(defStatus.faults.length > 0 ? { key_faults: defStatus.faults } : {}),
    active: defaultActive,
    is_default: true,
  };

  const namedRows: AccountRow[] = await Promise.all(
    accounts.map(async (a) => {
      const st = await store.status(a.id);
      return {
        id: a.id,
        provider: a.provider,
        base_url: a.base_url,
        model: a.model ?? null,
        key_set: st.present,
        ...(st.location !== undefined ? { key_location: st.location.label } : {}),
        ...(st.faults.length > 0 ? { key_faults: st.faults } : {}),
        active: a.id === selected,
      };
    }),
  );

  // Unknown = a selection that is neither the default id nor a known named
  // account (a genuine misconfig — the proxy falls back to the top-level config).
  const activeUnknown =
    selected !== null && selected !== defaultId && !accounts.some((a) => a.id === selected);
  const active = defaultActive || activeUnknown ? defaultId : selected;

  return { active, active_unknown: activeUnknown, accounts: [defaultRow, ...namedRows] };
}

/** Append a non-secret event to the audit log (ADR-0003). Fire-and-forget safe. */
async function appendAudit(
  projectDir: string,
  entry: { readonly action: string; readonly account: string | null },
  nowIso: string,
): Promise<void> {
  const file = path.join(projectDir, ".golem", "state", "account-log.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify({ ts: nowIso, ...entry })}\n`, "utf8");
}

/**
 * Switch the active account. `id: null`, `"none"` (handled by the caller), or
 * the synthetic default id (the top-level provider) all clear `active_account`
 * and revert to the top-level config. Any other id must be in `proxy.accounts`
 * (fail-closed — an unknown id is rejected). Records an audit line.
 *
 * **Credential preflight (Decision 46).** Before switching, resolve the target's
 * credential. If none resolves, fail closed with the remediation
 * (`golem account login <id>` or exporting the env var) unless `assumeYes` —
 * there is no silent switch onto an account that cannot authenticate. This is
 * the check that turns "set the key first" from advice into a guarantee.
 */
export async function useAccount(
  projectDir: string,
  id: string | null,
  nowIso: string,
  opts: {
    readonly assumeYes?: boolean;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly store_backend?: CredentialStore;
  } = {},
): Promise<{ readonly active: string | null }> {
  const env = opts.env ?? process.env;
  const { settings } = await loadConfig({ projectDir, env });

  // Resolve the target: null / the default id both mean "clear active_account
  // and revert to the top-level config". Any other id must be a known account.
  let target = id;
  if (id !== null) {
    if (id === defaultAccountId(settings.proxy.upstream_provider)) {
      target = null; // selecting the synthetic default = clear
    } else {
      const known = (settings.proxy.accounts ?? []).some((a) => a.id === id);
      if (!known) {
        const ids =
          (settings.proxy.accounts ?? []).map((a) => a.id).join(", ") || "(none configured)";
        throw new InitError(`unknown account "${id}"; configured accounts: ${ids}`);
      }
    }
  }

  // Credential preflight (Decision 46), scoped to switching ONTO a keyed
  // upstream: refuse to activate a named, non-default account whose credential
  // does not resolve, unless the caller explicitly overrides. Clearing to the
  // default is always allowed — the default may legitimately run keyless
  // (Anthropic `inherit` forwards the client's own auth), so gating it would
  // break the normal revert path. This is the guarantee that "set the key
  // first" is enforced rather than advised.
  if (opts.assumeYes !== true && target !== null) {
    const store = opts.store_backend ?? createCredentialStore({ userDir: defaultUserDir() });
    const hit = await store.resolve(target);
    if (hit === null) {
      throw new InitError(
        `no credential is stored for "${target}". Set one first:\n` +
          `  golem account login ${target}    (prompts, verifies it, stores it in the OS credential store)\n` +
          `Then retry. To switch anyway (fail-closed override): golem account use ${target} --yes`,
      );
    }
  }

  // A single-leaf write: `undefined` deletes the key (revert to the default),
  // a string sets it. writeSetting validates against the schema.
  await writeSetting("local", "proxy.default_target", target ?? undefined, { projectDir });
  // Drop the last-served-model snapshot: it describes the account we just left,
  // and leaving it would make `status`/statusline/the extension report the
  // PREVIOUS model as the current one until the new upstream serves a request.
  // Best-effort — a switch must not fail over a display cache.
  await clearServedModel(projectDir).catch(() => {});
  await appendAudit(
    projectDir,
    { action: target === null ? "clear" : "use", account: target },
    nowIso,
  );
  return { active: target };
}

/** Options for {@link loginAccount}. */
export interface LoginOptions {
  /** Probe the upstream and refuse to store a rejected key (default true). */
  readonly probe?: boolean;
  /** Where to store: the OS store (default) or explicit plaintext `--store file`. */
  readonly store?: StoreTarget;
  /** Override prompting: read the secret from this pre-supplied value (tests, pipes). */
  readonly secret?: string;
  readonly store_backend?: CredentialStore;
}

/**
 * Store a credential for an account, prompting for it and verifying it against
 * the upstream first (Decision 46). This is what "credential management managed
 * by Golem" means: the user is asked for the key, the key is confirmed to work
 * before it is stored, and it lands in the OS credential store — not in a config
 * file, not re-typed into every new terminal.
 *
 * The secret is never echoed, logged, or written anywhere but the store. A
 * rejected key is NOT stored (fail-closed) unless the caller probes first and
 * the verdict is merely inconclusive (provider unreachable / no probe endpoint),
 * in which case it is stored with a warning.
 *
 * `opts.secret` supplies the key without prompting — how the CLI feeds a piped
 * key through on a non-TTY stdin. This is the only non-interactive path now that
 * there is no env-var backend (Decision 47), so it is the CI/headless story; the
 * secret still never touches argv.
 */
export async function loginAccount(
  projectDir: string,
  id: string,
  nowIso: string,
  opts: LoginOptions = {},
): Promise<{
  readonly account: string;
  readonly stored_in: string;
  readonly probe: string;
  /** The URL real traffic will go to — printed so the route is verifiable, not assumed. */
  readonly request_url?: string;
}> {
  const { account, storeId } = await resolveAccountTarget(projectDir, id);
  const store = opts.store_backend ?? createCredentialStore({});

  // 1. Get the secret: the caller may supply it (tests/pipes); otherwise prompt.
  let secret = opts.secret;
  if (secret === undefined) {
    if (!canPrompt()) {
      throw new InitError(
        "cannot prompt for a credential: stdin is not a terminal. Either run this in an " +
          `interactive terminal, or pipe the key in: echo "<key>" | golem account login ${id}`,
      );
    }
    try {
      secret = await promptSecret(`Enter the API key for "${id}" (${account.provider}): `);
    } catch (err) {
      if (err instanceof PromptCancelled) throw new InitError("login cancelled.");
      throw err;
    }
  }
  if (secret.trim() === "") throw new InitError("empty key — nothing stored.");

  // 2. Probe it against the upstream before storing (unless disabled).
  let probeVerdict = "skipped";
  let requestUrl: string | undefined;
  if (opts.probe !== false) {
    const result = await probeCredential({
      provider: account.provider,
      baseUrl: account.base_url,
      authScheme: account.auth_scheme ?? "inherit",
      secret,
    });
    probeVerdict = result.verdict;
    requestUrl = result.requestUrl;
    // A route problem is independent of the key: say so even on `accepted`, or
    // the user stores a working key against a base URL that 404s every request.
    if (result.configWarning !== undefined) {
      process.stderr.write(`warning: ${result.configWarning}\n`);
    }
    if (result.verdict === "rejected") {
      // Fail-closed: do NOT store a key the upstream actively rejects.
      throw new InitError(
        `the upstream rejected that key (${result.detail}). Nothing was stored. ` +
          `Check the key and try again, or probe a different account.`,
      );
    }
    if (result.verdict === "inconclusive") {
      // Store anyway but say plainly that we could not confirm it.
      process.stderr.write(
        `warning: could not confirm the key — ${result.detail}. Storing anyway.\n`,
      );
    }
  }

  // 3. Store it in the OS credential store (or explicit plaintext file).
  const where = await store.store(storeId, secret, opts.store ?? "auto");
  await appendAudit(projectDir, { action: "login", account: storeId }, nowIso);
  return {
    account: id,
    stored_in: where.label,
    probe: probeVerdict,
    ...(requestUrl !== undefined ? { request_url: requestUrl } : {}),
  };
}

/**
 * Remove an account's stored credential from every backend (the OS store and any
 * opted-in plaintext file). Since Decision 47 there is no environment-variable
 * backend, so a logout is complete — there is no un-unsettable copy left behind.
 */
export async function logoutAccount(
  projectDir: string,
  id: string,
  nowIso: string,
  opts: { readonly store_backend?: CredentialStore } = {},
): Promise<{
  readonly account: string;
  readonly removed: readonly string[];
}> {
  const { storeId } = await resolveAccountTarget(projectDir, id);
  const store = opts.store_backend ?? createCredentialStore({});
  const removed = await store.forget(storeId);
  await appendAudit(projectDir, { action: "logout", account: storeId }, nowIso);
  return { account: id, removed: removed.map((l) => l.label) };
}

/** Input for {@link addAccount}. All fields are NON-SECRET (ADR-0003 invariant 1). */
export interface NewAccount {
  readonly id: string;
  readonly provider: RegistryAccount["provider"];
  readonly base_url: string;
  readonly model?: string;
  readonly auth_scheme?: RegistryAccount["auth_scheme"];
}

/**
 * Register a new account in `proxy.accounts`. This is the registration leg the
 * credential commands depend on: until an id exists here, `account login <id>`
 * and `account use <id>` both reject it as unknown.
 *
 * Written to the **local** scope (`settings.local.json`) — the top file layer —
 * because the proxy reads the MERGED config and a `proxy.accounts` array in any
 * higher-precedence layer wholesale-replaces lower ones. Writing anywhere lower
 * would let a pre-existing local-layer `accounts` mask the change. Local scope
 * also keeps machine-specific account registrations out of the committable
 * project settings file.
 *
 * Fail-closed and non-destructive: refuses a duplicate id, refuses to shadow
 * the synthetic default's id, preserves every existing entry and its key order
 * (read-modify-write of the whole array through the schema-validated
 * `proxy.accounts` leaf). Never touches a credential — that is `account login`'s
 * job. Audit-logged.
 */
export async function addAccount(
  projectDir: string,
  input: NewAccount,
  nowIso: string,
): Promise<{ readonly account: string }> {
  const { settings } = await loadConfig({ projectDir });
  const p = settings.proxy;
  const accounts = [...(p.accounts ?? [])];

  if (input.id === defaultAccountId(p.upstream_provider) || input.id === DEFAULT_STORE_ID) {
    throw new InitError(
      `"${input.id}" is the default account (the top-level upstream config) — it is not a ` +
        `registered account and needs no \`account add\`. Set its credential with ` +
        `\`golem account login ${input.id}\` or edit proxy.upstream_* directly.`,
    );
  }
  if (accounts.some((a) => a.id === input.id)) {
    throw new InitError(
      `account "${input.id}" already exists. To change it, \`golem account remove ${input.id}\` ` +
        `and re-add, or edit proxy.accounts directly.`,
    );
  }

  // `--model` only reaches the wire on a TRANSLATING provider: a byte-faithful
  // case-(a) upstream never parses the body, so the client's own `claude-*` id is
  // forwarded and the configured model is silently inert. Accepting it without a
  // word is how an account gets registered that cannot possibly serve the model
  // its own config names (Decision 48).
  if (input.model !== undefined && !isTranslatingProvider(input.provider)) {
    process.stderr.write(
      `warning: provider "${input.provider}" is byte-faithful (it forwards the client's own ` +
        `model id unchanged), so model "${input.model}" will be IGNORED on the wire — it is ` +
        "recorded for display only. To pin a model, use a translating provider " +
        "(openai, openrouter, ollama, gemini).\n",
    );
  }
  // Catch the base-URL/route mismatch at registration, not on the first request
  // (where a byte-faithful double-version path 404s with an HTML page).
  const doubled = doubledVersionSegment(input.provider, input.base_url);
  if (doubled !== undefined) {
    process.stderr.write(
      `warning: base URL "${input.base_url}" composes into ${doubled} — the API version ` +
        "segment is repeated, so requests will 404. Drop the trailing version segment " +
        "(the proxy appends the client's own).\n",
    );
  }
  const entry: RegistryAccount = {
    id: input.id,
    provider: input.provider,
    base_url: input.base_url,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.auth_scheme !== undefined ? { auth_scheme: input.auth_scheme } : {}),
  };
  // writeSetting validates the WHOLE array against the accounts leaf schema
  // (id/provider/base_url required, model/auth_scheme optional) before writing.
  await writeSetting("local", "proxy.accounts", [...accounts, entry], { projectDir });
  await appendAudit(projectDir, { action: "add", account: input.id }, nowIso);
  return { account: input.id };
}

/**
 * Remove an account from `proxy.accounts` (local scope — see {@link addAccount}
 * for why local, not project). Fail-closed on an unknown id; if the removed
 * account was active, clears `active_account` back to the default rather than
 * leaving a dangling reference. Audit-logged.
 *
 * **Logs the account out first.** De-registering an account used to leave its
 * secret sitting in the OS credential store, reachable by nobody and forgotten
 * by everybody — a credential with no account is pure liability. So `remove`
 * now runs the same `forget` that `account logout` does, *before* it edits the
 * registry (the credential's store id is derived from the registry entry, so the
 * order matters), and reports what it deleted. Pass `keepCredential` to keep the
 * stored key — the escape hatch for re-adding the same account shortly after.
 */
export async function removeAccount(
  projectDir: string,
  id: string,
  nowIso: string,
  opts: {
    readonly keepCredential?: boolean;
    readonly store_backend?: CredentialStore;
  } = {},
): Promise<{
  readonly account: string;
  readonly was_active: boolean;
  /** Backends the credential was deleted from; empty when none held one or `keepCredential`. */
  readonly credential_removed: readonly string[];
}> {
  const { settings } = await loadConfig({ projectDir });
  const p = settings.proxy;
  const accounts = p.accounts ?? [];
  if (id === defaultAccountId(p.upstream_provider) || id === DEFAULT_STORE_ID) {
    throw new InitError(
      `"${id}" is the default account (the top-level upstream config) — remove it by editing ` +
        `proxy.upstream_* directly, not via \`account remove\`.`,
    );
  }
  if (!accounts.some((a) => a.id === id)) {
    const ids = accounts.map((a) => a.id).join(", ") || "(none configured)";
    throw new InitError(`unknown account "${id}"; configured accounts: ${ids}`);
  }

  // Log out BEFORE de-registering: logoutAccount resolves the credential's store
  // id from the registry entry, which is about to disappear.
  let credentialRemoved: readonly string[] = [];
  if (opts.keepCredential !== true) {
    const logout = await logoutAccount(projectDir, id, nowIso, {
      ...(opts.store_backend !== undefined ? { store_backend: opts.store_backend } : {}),
    });
    credentialRemoved = logout.removed;
  }

  const remaining = accounts.filter((a) => a.id !== id);
  await writeSetting("local", "proxy.accounts", remaining, { projectDir });

  const wasActive = p.default_target === id;
  if (wasActive) {
    await writeSetting("local", "proxy.default_target", undefined, { projectDir });
  }
  await appendAudit(projectDir, { action: "remove", account: id }, nowIso);
  return { account: id, was_active: wasActive, credential_removed: credentialRemoved };
}

/**
 * Resolve the credential the proxy daemon should start with, as a single
 * `{ <env var name>: <secret> }` map for {@link startDetached}'s `env` argument.
 *
 * This is the mechanism that makes a stored credential actually reach the
 * proxy: the daemon is spawned from a minimal env (it does NOT inherit the
 * shell), so the CLI resolves the active account's credential from the OS store
 * and injects it under the var name the proxy's auth mapping reads. That var is
 * an INTERNAL handoff, not a configuration surface (Decision 47) — exporting it
 * by hand sets nothing, because the store no longer reads the environment.
 * Returns `{}` when nothing resolves — the proxy then forwards the client's own
 * auth as it always has, so this never breaks a keyless/inherit setup.
 *
 * **R9.1 — this resolves N credentials, not 1.** Every account referenced by a
 * target in `proxy.targets` (or derived from `proxy.accounts`) gets its key
 * injected under its own `perAccountEnvVar`, because with a target registry the
 * proxy may need any of them, not only the active one. No new secret mechanism
 * was required: `perAccountEnvVar` was already designed per-account (Decision
 * 47), and the CLI still owns resolution and injects at spawn.
 *
 * The accepted cost is a **wider blast radius**: the daemon's environment now
 * carries N credentials where it carried one. The keys are still never settings
 * and never on disk in plaintext, but a proxy compromise now exposes more. That
 * is recorded here deliberately rather than discovered later.
 *
 * Never logs a secret; the caller passes the map straight to spawn.
 */
export async function credentialEnvForProxy(
  projectDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  opts: { readonly store_backend?: CredentialStore } = {},
): Promise<Record<string, string>> {
  const { settings } = await loadConfig({ projectDir, env });
  const selected = settings.proxy.default_target ?? null;
  const defaultId = defaultAccountId(settings.proxy.upstream_provider);
  // The default top-level config is in force when nothing is selected or the
  // selection names the default id; its credential rides the plain var.
  const onDefault = selected === null || selected === defaultId;
  const activeStoreId = onDefault ? DEFAULT_STORE_ID : selected;
  const store = opts.store_backend ?? createCredentialStore({ userDir: defaultUserDir() });

  // The active account first — unchanged behaviour, so a single-upstream setup
  // spawns exactly as it did before this task.
  const out: Record<string, string> = {};
  const active = await store.resolve(activeStoreId);
  if (active !== null) out[envVarForAccount(activeStoreId)] = active.secret;

  // Then every account some target references. A missing credential is skipped
  // silently here, not thrown: an unkeyed target must not stop the proxy from
  // starting for the targets that ARE keyed. `golem target list` reports it.
  for (const accountId of accountsReferencedByTargets(settings.proxy)) {
    const varName = envVarForAccount(accountId);
    if (out[varName] !== undefined) continue;
    const hit = await store.resolve(accountId);
    if (hit !== null) out[varName] = hit.secret;
  }
  return out;
}

/** Human-readable rendering of {@link AccountsReport}. */
export function renderAccounts(report: AccountsReport): string {
  const lines: string[] = [];
  lines.push("Golem upstream accounts (credential values are never shown):");
  for (const a of report.accounts) {
    const mark = a.active ? "*" : " ";
    const key = a.key_set
      ? `key set — ${a.key_location ?? "stored"}`
      : `key MISSING (set it with: golem account login ${a.id})`;
    const model = a.model !== null ? ` model=${a.model}` : "";
    const tag = a.is_default === true ? " (default)" : "";
    lines.push(`  ${mark} ${a.id.padEnd(12)} ${a.provider} ${a.base_url}${model}`);
    lines.push(`        ${key}${tag}`);
    for (const f of a.key_faults ?? []) {
      lines.push(`        warning: ${f.backend} store error — ${f.message}`);
    }
  }
  lines.push("");
  if (report.active_unknown) {
    lines.push(
      "active: (default) — WARNING: proxy.active_account names an id not in proxy.accounts; " +
        "the proxy falls back to the top-level config (no silent switch to another account).",
    );
  } else {
    lines.push(`active: ${report.active}`);
  }
  return `${lines.join("\n")}\n`;
}
