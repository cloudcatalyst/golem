/**
 * R6.2 v1 + Decisions 46/47 — `golem gateway` CLI (spec Decision 21d; ADR-0003, amended).
 *
 * Explicit switching between the user's own configured gateways/providers, plus
 * Golem-managed credentials. ADR-0003 invariants surfaced here:
 * - **No secret is ever printed or stored as a setting.** `list` reports only
 *   WHERE each gateway's credential resolves from (the OS store, or an opted-in
 *   plaintext file) and whether it resolves at all — never its value; switching
 *   writes only the non-secret `inference.default_target` selector. Stored
 *   credentials live in the OS credential store (Decision 46), never in
 *   settings, `.golem/` state, or an environment variable (Decision 47).
 * - **Fail-closed.** `use <id>` refuses an id that is not in `proxy.gateways`,
 *   and refuses to switch onto a gateway whose credential does not resolve
 *   unless you pass `--yes` (no silent switch to an un-credentialed gateway).
 * - **Audit.** Every switch, login, and logout is appended to
 *   `.golem/state/account-log.jsonl` (non-secret metadata only).
 * - **No orphaned secrets.** `remove <id>` logs the account out first, so
 *   de-registering a gateway never leaves its key behind in the OS store.
 */

import { defaultUserDir, loadConfig, writeSetting } from "../config/index.js";
import { type CredentialStore, createCredentialStore } from "../credentials/index.js";
import { doubledVersionSegment, isTranslatingProvider } from "../providers/index.js";
import { clearServedModel } from "../proxy/index.js";
import { logoutGateway } from "./gateways/credentials.js";
import {
  appendAudit,
  DEFAULT_STORE_ID,
  defaultGatewayId,
  type RegistryGateway,
} from "./gateways/registry.js";
import { InitError } from "./init.js";

/* The registry and credential halves are re-exported so `./gateways.js` stays
 * the one import path for this CLI surface: every caller and test that imported
 * from here before the split keeps working unchanged. */
export {
  credentialEnvForProxy,
  type LoginOptions,
  loginGateway,
  logoutGateway,
} from "./gateways/credentials.js";
export {
  collectGateways,
  defaultGatewayId,
  type GatewayRow,
  type GatewaysReport,
  type GatewayTarget,
  renderGateways,
} from "./gateways/registry.js";

/**
 * Switch the active account. `id: null`, `"none"` (handled by the caller), or
 * the synthetic default id (the top-level provider) all clear `inference.default_target`
 * and revert to the top-level config. Any other id must be in `proxy.gateways`
 * (fail-closed — an unknown id is rejected). Records an audit line.
 *
 * **Credential preflight (Decision 46).** Before switching, resolve the target's
 * credential. If none resolves, fail closed with the remediation
 * (`golem gateway login <id>` or exporting the env var) unless `assumeYes` —
 * there is no silent switch onto an account that cannot authenticate. This is
 * the check that turns "set the key first" from advice into a guarantee.
 */
export async function useGateway(
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

  // Resolve the target: null / the default id both mean "clear inference.default_target
  // and revert to the top-level config". Any other id must be a known account.
  let target = id;
  if (id !== null) {
    if (id === defaultGatewayId(settings.proxy.upstream_provider)) {
      target = null; // selecting the synthetic default = clear
    } else {
      const known = (settings.proxy.gateways ?? []).some((g) => g.id === id);
      if (!known) {
        const ids =
          (settings.proxy.gateways ?? []).map((g) => g.id).join(", ") || "(none configured)";
        throw new InitError(`unknown gateway "${id}"; configured gateways: ${ids}`);
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
          `  golem gateway login ${target}    (prompts, verifies it, stores it in the OS credential store)\n` +
          `Then retry. To switch anyway (fail-closed override): golem gateway use ${target} --yes`,
      );
    }
  }

  // A single-leaf write: `undefined` deletes the key (revert to the default),
  // a string sets it. writeSetting validates against the schema.
  await writeSetting("local", "inference.default_target", target ?? undefined, { projectDir });
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

/** Input for {@link addGateway}. All fields are NON-SECRET (ADR-0003 invariant 1). */
export interface NewGateway {
  readonly id: string;
  readonly provider: RegistryGateway["provider"];
  readonly base_url: string;
  readonly models?: readonly string[];
  readonly auth_scheme?: RegistryGateway["auth_scheme"];
}

/**
 * Register a new account in `proxy.gateways`. This is the registration leg the
 * credential commands depend on: until an id exists here, `account login <id>`
 * and `account use <id>` both reject it as unknown.
 *
 * Written to the **local** scope (`settings.local.json`) — the top file layer —
 * because the proxy reads the MERGED config and a `proxy.gateways` array in any
 * higher-precedence layer wholesale-replaces lower ones. Writing anywhere lower
 * would let a pre-existing local-layer `gateways` mask the change. Local scope
 * also keeps machine-specific account registrations out of the committable
 * project settings file.
 *
 * Fail-closed and non-destructive: refuses a duplicate id, refuses to shadow
 * the synthetic default's id, preserves every existing entry and its key order
 * (read-modify-write of the whole array through the schema-validated
 * `proxy.gateways` leaf). Never touches a credential — that is `account login`'s
 * job. Audit-logged.
 */
export async function addGateway(
  projectDir: string,
  input: NewGateway,
  nowIso: string,
): Promise<{ readonly account: string }> {
  const { settings } = await loadConfig({ projectDir });
  const p = settings.proxy;
  const gateways = [...(p.gateways ?? [])];

  if (input.id === defaultGatewayId(p.upstream_provider) || input.id === DEFAULT_STORE_ID) {
    throw new InitError(
      `"${input.id}" is the default gateway (the top-level upstream config) — it is not a ` +
        `registered gateway and needs no \`account add\`. Set its credential with ` +
        `\`golem gateway login ${input.id}\` or edit proxy.upstream_* directly.`,
    );
  }
  if (gateways.some((g) => g.id === input.id)) {
    throw new InitError(
      `gateway "${input.id}" already exists. To change it, \`golem gateway remove ${input.id}\` ` +
        `and re-add, or edit proxy.gateways directly.`,
    );
  }

  // R9.23: gateways carry `models[]` instead of a single `model`. The warning
  // about a byte-faithful provider applies to each model individually.
  const models = input.models;
  if (models !== undefined && models.length > 0 && !isTranslatingProvider(input.provider)) {
    process.stderr.write(
      `warning: provider "${input.provider}" is byte-faithful (it forwards the client's own ` +
        `model id unchanged), so model(s) "${models.join(", ")}" will be IGNORED on the wire — ` +
        "they are recorded for display only. To pin a model, use a translating provider " +
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
  const entry: RegistryGateway = {
    id: input.id,
    provider: input.provider,
    base_url: input.base_url,
    ...(models !== undefined && models.length > 0 ? { models } : {}),
    ...(input.auth_scheme !== undefined ? { auth_scheme: input.auth_scheme } : {}),
  };
  // writeSetting validates the WHOLE array against the gateways leaf schema
  // (id/provider/base_url required, models/auth_scheme optional) before writing.
  await writeSetting("local", "proxy.gateways", [...gateways, entry], { projectDir });
  await appendAudit(projectDir, { action: "add", account: input.id }, nowIso);
  return { account: input.id };
}

/**
 * Remove an account from `proxy.gateways` (local scope — see {@link addGateway}
 * for why local, not project). Fail-closed on an unknown id; if the removed
 * gateway was active, clears `inference.default_target` back to the default rather than
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
export async function removeGateway(
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
  const inf = settings.inference;
  const gateways = p.gateways ?? [];
  if (id === defaultGatewayId(p.upstream_provider) || id === DEFAULT_STORE_ID) {
    throw new InitError(
      `"${id}" is the default gateway (the top-level upstream config) — remove it by editing ` +
        `proxy.upstream_* directly, not via \`account remove\`.`,
    );
  }
  if (!gateways.some((g) => g.id === id)) {
    const ids = gateways.map((g) => g.id).join(", ") || "(none configured)";
    throw new InitError(`unknown gateway "${id}"; configured gateways: ${ids}`);
  }

  // Log out BEFORE de-registering: logoutGateway resolves the credential's store
  // id from the registry entry, which is about to disappear.
  let credentialRemoved: readonly string[] = [];
  if (opts.keepCredential !== true) {
    const logout = await logoutGateway(projectDir, id, nowIso, {
      ...(opts.store_backend !== undefined ? { store_backend: opts.store_backend } : {}),
    });
    credentialRemoved = logout.removed;
  }

  const remaining = gateways.filter((g) => g.id !== id);
  await writeSetting("local", "proxy.gateways", remaining, { projectDir });

  const wasActive = inf.default_target === id;
  if (wasActive) {
    await writeSetting("local", "inference.default_target", undefined, { projectDir });
  }
  await appendAudit(projectDir, { action: "remove", account: id }, nowIso);
  return { account: id, was_active: wasActive, credential_removed: credentialRemoved };
}
