/**
 * R6.2 v1 + Decision 46 — `golem account` CLI (spec Decision 21d; ADR-0003, amended).
 *
 * Explicit switching between the user's own configured accounts/providers, plus
 * Golem-managed credentials. ADR-0003 invariants surfaced here:
 * - **No secret is ever printed or stored as a setting.** `list` reports only
 *   WHERE each account's credential resolves from (env var or OS store) and
 *   whether it resolves at all — never its value; switching writes only the
 *   non-secret `proxy.active_account` selector. Stored credentials live in the
 *   OS credential store (Decision 46), never in settings or `.golem/` state.
 * - **Fail-closed.** `use <id>` refuses an id that is not in `proxy.accounts`,
 *   and refuses to switch onto an account whose credential does not resolve
 *   unless you pass `--yes` (no silent switch to an un-credentialed account).
 * - **Audit.** Every switch, login, and logout is appended to
 *   `.golem/state/account-log.jsonl` (non-secret metadata only).
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
  DEFAULT_KEY_ENV,
  envVarForAccount,
  type StoreTarget,
} from "../credentials/index.js";
import { probeCredential } from "../credentials/probe.js";
import { PromptCancelled, promptSecret } from "../credentials/prompt.js";
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
  /** The env var carrying this account's secret (name only). */
  readonly key_env: string;
  /** Whether a credential resolves for this account (never the value). */
  readonly key_set: boolean;
  /**
   * Where the credential resolves from — the env var or the OS store — so the
   * user can see *why* a key is or isn't picked up (Decision 46). Absent when
   * `key_set` is false.
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
 * {@link DEFAULT_ACCOUNT_ID}, which maps to the plain `GOLEM_UPSTREAM_API_KEY`
 * env var — so a stored default credential and the legacy env var are the same
 * account.
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
 * values). `env` overrides the process environment used to detect env-carried
 * credentials, so tests can simulate a set/unset var without touching the real
 * environment (the OS-store backends are still consulted; on a machine with a
 * stored key the `key_set` flags may be true regardless).
 */
export async function collectAccounts(
  projectDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<AccountsReport> {
  const { settings } = await loadConfig({ projectDir, env });
  const userDir = defaultUserDir();
  const selected = settings.proxy.active_account ?? null;
  const accounts = settings.proxy.accounts ?? [];
  const defaultId = defaultAccountId(settings.proxy.upstream_provider);
  const store = createCredentialStore({ userDir, env });

  // The default is active whenever no named account is selected, or the
  // selection names the default id itself.
  const defaultActive = selected === null || selected === defaultId;
  const defStatus = await store.status(DEFAULT_STORE_ID);
  const defaultRow: AccountRow = {
    id: defaultId,
    provider: settings.proxy.upstream_provider,
    base_url: settings.proxy.upstream_base_url,
    model: settings.proxy.upstream_model ?? null,
    key_env: DEFAULT_KEY_ENV,
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
        key_env: envVarForAccount(a.id),
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
    const store = createCredentialStore({ userDir: defaultUserDir(), env });
    const hit = await store.resolve(target);
    if (hit === null) {
      const envVar = envVarForAccount(target);
      throw new InitError(
        `no credential resolves for "${target}" (checked env ${envVar} and the OS credential store). ` +
          `Set one first — either:\n` +
          `  • golem account login ${target}    (prompt and store it in the OS credential store), or\n` +
          `  • export ${envVar}=…\n` +
          `Then retry. To switch anyway (fail-closed override): golem account use ${target} --yes`,
      );
    }
  }

  // A single-leaf write: `undefined` deletes the key (revert to the default),
  // a string sets it. writeSetting validates against the schema.
  await writeSetting("project", "proxy.active_account", target ?? undefined, { projectDir });
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
 */
export async function loginAccount(
  projectDir: string,
  id: string,
  nowIso: string,
  opts: LoginOptions = {},
): Promise<{ readonly account: string; readonly stored_in: string; readonly probe: string }> {
  const { account, storeId } = await resolveAccountTarget(projectDir, id);
  const store = opts.store_backend ?? createCredentialStore({});

  // 1. Get the secret: the caller may supply it (tests/pipes); otherwise prompt.
  let secret = opts.secret;
  if (secret === undefined) {
    if (!canPrompt()) {
      throw new InitError(
        `cannot prompt for a credential: stdin is not a terminal. Either run this in an ` +
          `interactive terminal, or export ${envVarForAccount(storeId)}=… instead.`,
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
  if (opts.probe !== false) {
    const result = await probeCredential({
      provider: account.provider,
      baseUrl: account.base_url,
      authScheme: account.auth_scheme ?? "inherit",
      secret,
    });
    probeVerdict = result.verdict;
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
  return { account: id, stored_in: where.label, probe: probeVerdict };
}

/**
 * Remove an account's stored credential from every writable backend (the OS
 * store and any plaintext file). The env var, if set, cannot be unset by a
 * child process — that is reported, not attempted.
 */
export async function logoutAccount(
  projectDir: string,
  id: string,
  nowIso: string,
  opts: { readonly store_backend?: CredentialStore } = {},
): Promise<{
  readonly account: string;
  readonly removed: readonly string[];
  readonly env_note: string | null;
}> {
  const { storeId } = await resolveAccountTarget(projectDir, id);
  const store = opts.store_backend ?? createCredentialStore({});
  const removed = await store.forget(storeId);
  await appendAudit(projectDir, { action: "logout", account: storeId }, nowIso);
  const envVar = envVarForAccount(storeId);
  const envNote =
    process.env[envVar] !== undefined
      ? `note: ${envVar} is still set in this shell's environment — Golem cannot unset it; remove it from your profile if you want it gone.`
      : null;
  return { account: id, removed: removed.map((l) => l.label), env_note: envNote };
}

/**
 * Resolve the credential the proxy daemon should start with, as a single
 * `{ <env var name>: <secret> }` map for {@link startDetached}'s `env` argument.
 *
 * This is the mechanism that makes a stored credential actually reach the
 * proxy: the daemon is spawned from a minimal env (it does NOT inherit the
 * shell), so the CLI resolves the active account's credential from the store —
 * env var first, then the OS credential store — and injects it under exactly
 * the env var name the proxy's auth mapping already reads
 * (`GOLEM_UPSTREAM_API_KEY` for the default, `GOLEM_UPSTREAM_API_KEY__<ID>` for
 * a named account). Returns `{}` when nothing resolves — the proxy then
 * forwards the client's own auth as it always has, so this never breaks a
 * keyless/inherit setup.
 *
 * Never logs the secret; the caller passes the map straight to spawn.
 */
export async function credentialEnvForProxy(
  projectDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Record<string, string>> {
  const { settings } = await loadConfig({ projectDir, env });
  const selected = settings.proxy.active_account ?? null;
  const defaultId = defaultAccountId(settings.proxy.upstream_provider);
  // The default top-level config is in force when nothing is selected or the
  // selection names the default id; its credential rides the plain var.
  const onDefault = selected === null || selected === defaultId;
  const storeId = onDefault ? DEFAULT_STORE_ID : selected;
  const store = createCredentialStore({ userDir: defaultUserDir(), env });
  const hit = await store.resolve(storeId);
  if (hit === null) return {};
  return { [envVarForAccount(storeId)]: hit.secret };
}

/** Human-readable rendering of {@link AccountsReport}. */
export function renderAccounts(report: AccountsReport): string {
  const lines: string[] = [];
  lines.push("Golem upstream accounts (credential values are never shown):");
  for (const a of report.accounts) {
    const mark = a.active ? "*" : " ";
    const key = a.key_set
      ? `key set — ${a.key_location ?? a.key_env}`
      : `key MISSING (set via: golem account login ${a.id}  |  export ${a.key_env}=…)`;
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
