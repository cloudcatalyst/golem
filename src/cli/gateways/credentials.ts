/**
 * R6.2 v1 + Decisions 46/47 — the `golem account` CREDENTIAL commands (spec
 * Decision 21d; ADR-0003, amended). Extracted verbatim from `../gateways.ts`.
 *
 * Everything that touches the credential store lives here and nowhere else:
 * login (prompt → probe → store), logout (forget from every backend), and the
 * resolution that injects the proxy daemon's keys at spawn. The secret is never
 * echoed, never logged, never written to a settings file, and never returned to
 * the registry half — only `appendAudit`'s non-secret metadata crosses back.
 */

import { defaultUserDir, loadConfig } from "../../config/index.js";
import {
  type CredentialStore,
  canPrompt,
  createCredentialStore,
  envVarForAccount,
  type StoreTarget,
} from "../../credentials/index.js";
import { probeCredential } from "../../credentials/probe.js";
import { PromptCancelled, promptSecret } from "../../credentials/prompt.js";
import { accountsReferencedByTargets } from "../../providers/index.js";
import { InitError } from "../init.js";
import { appendAudit, DEFAULT_STORE_ID, defaultAccountId, type GatewayTarget } from "./registry.js";

/**
 * Resolve the (provider, base_url, model, auth_scheme, store id) for an account
 * selection — either a named registry account or the synthetic default (the
 * top-level upstream config). Shared by the credential commands so they probe
 * and store against exactly what the proxy would use.
 */
async function resolveGatewayTarget(
  projectDir: string,
  id: string,
): Promise<{
  readonly storeId: string;
  readonly account: GatewayTarget;
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
  const found = (p.gateways ?? []).find((g) => g.id === id);
  if (found === undefined) {
    const ids = (p.gateways ?? []).map((g) => g.id).join(", ") || "(none configured)";
    throw new InitError(`unknown gateway "${id}"; configured gateways: ${ids}`);
  }
  return {
    storeId: found.id,
    isDefault: false,
    account: {
      id: found.id,
      provider: found.provider,
      base_url: found.base_url,
      // R9.23: gateways carry `models[]`, not a single `model`. For
      // account-level credential operations the first model is the display
      // default; pass `undefined` when none exists.
      ...(found.models !== undefined && found.models.length > 0 ? { model: found.models[0] } : {}),
      auth_scheme: found.auth_scheme ?? "inherit",
    },
  };
}

/** Options for {@link loginGateway}. */
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
export async function loginGateway(
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
  const { account, storeId } = await resolveGatewayTarget(projectDir, id);
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
export async function logoutGateway(
  projectDir: string,
  id: string,
  nowIso: string,
  opts: { readonly store_backend?: CredentialStore } = {},
): Promise<{
  readonly account: string;
  readonly removed: readonly string[];
}> {
  const { storeId } = await resolveGatewayTarget(projectDir, id);
  const store = opts.store_backend ?? createCredentialStore({});
  const removed = await store.forget(storeId);
  await appendAudit(projectDir, { action: "logout", account: storeId }, nowIso);
  return { account: id, removed: removed.map((l) => l.label) };
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
 * **R9.1 — this resolves N credentials, not 1.** Every gateway referenced by a
 * target in `proxy.targets` (or derived from `proxy.gateways`) gets its key
 * injected under its own `perGatewayEnvVar` (renamed from `perGatewayEnvVar` in
 * R9.23), because with a target registry the proxy may need any of them, not
 * only the active one. No new secret mechanism was required: `perGatewayEnvVar`
 * was already designed per-gateway (Decision 47), and the CLI still owns
 * resolution and injects at spawn.
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
  const selected = settings.inference.default_target ?? null;
  const defaultId = defaultAccountId(settings.proxy.upstream_provider);
  // The default top-level config is in force when nothing is selected or the
  // selection names the default id; its credential rides the plain var.
  const onDefault = selected === null || selected === defaultId;
  const activeStoreId = onDefault ? DEFAULT_STORE_ID : selected;
  const store = opts.store_backend ?? createCredentialStore({ userDir: defaultUserDir() });

  // Resolution stays SEQUENTIAL, deliberately. R9.18 measured this as the bulk
  // of proxy start-up — ~2.6s one-time for the DPAPI host self-test, then ~0.94s
  // per *stored* account (unstored ones cost ~1ms) — and tried resolving them
  // concurrently. That bought nothing on Windows, because concurrent PowerShell
  // startups contend rather than overlap, and the burst of processes was enough
  // to destabilise the test suite. The fix that actually removes the cost is one
  // batched decrypt in a single invocation: filed as R9.20, with the numbers.
  //
  // The active account first, so its credential wins the shared var; then every
  // account a target references. A missing credential is skipped silently rather
  // than thrown — an unkeyed target must not stop the proxy starting for the
  // targets that ARE keyed. `golem target list` reports it.
  const out: Record<string, string> = {};
  const active = await store.resolve(activeStoreId);
  if (active !== null) out[envVarForAccount(activeStoreId)] = active.secret;

  for (const accountId of accountsReferencedByTargets(settings.proxy)) {
    const varName = envVarForAccount(accountId);
    if (out[varName] !== undefined) continue;
    const hit = await store.resolve(accountId);
    if (hit !== null) out[varName] = hit.secret;
  }
  return out;
}
