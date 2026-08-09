/**
 * R9.1 — the target registry (proposal `multi-target-routing.md`; ADR-0003).
 *
 * **One table for every model Golem can reach**, local or upstream. The pivot is
 * that a local model is an ordinary target whose provider is `ollama` — "optional
 * local coder" stops being a special case.
 *
 * The registry deliberately splits two concerns that `proxy.accounts` fused:
 *
 * | registry | answers | secrets? |
 * |---|---|---|
 * | `proxy.accounts` | *whose credential* — id → provider + OS-keychain reference | reference only |
 * | `proxy.targets`  | *which endpoint + model* — id → provider, base_url, model, `account` ref, `trust` | **none** |
 *
 * Several targets may reference one account (one OpenRouter key backing five
 * targets that name different models). **Because a target holds no secret, the
 * entire ADR-0003 threat model carries over untouched** — that property is what
 * keeps this small, and it must not be traded away for convenience. There is
 * deliberately no `key`/`api_key` field here; adding one would reintroduce
 * plaintext-secrets-as-settings, which ADR-0003 invariant 1 forbids outright.
 *
 * **This module is inert in R9.1.** Nothing routes on it yet: the proxy still
 * serves one upstream (R9.2 consumes the registry, R9.3 gives `coder` a target).
 * It is configuration and reporting only, which is what makes it safe to land
 * alone.
 *
 * Fail-closed, in the same spirit as `resolveActiveUpstream`: an unknown id
 * resolves to *nothing*, never to a different target. A routing layer that
 * silently substitutes a neighbour sends your context somewhere you did not ask
 * for, which is the one failure mode a target registry must not have.
 */

import type { UpstreamAccount } from "./accounts.js";
import {
  doubledVersionSegment,
  isTranslatingProvider,
  resolveAuthScheme,
  type UpstreamAuthScheme,
  type UpstreamProvider,
} from "./index.js";

/**
 * How much Golem trusts a target with context. Enumerated rather than free-form
 * (proposal open question 3) so the redaction floor it sets is auditable: a
 * reader can see every level that exists, and a typo is a config error instead
 * of a silently-unmatched string.
 *
 * - `vendor` — the user's own account with a first-party model vendor.
 * - `local` — a model on this machine; context never leaves the host.
 * - `lan` — a model on hardware the user controls, reached over the network.
 * - `third-party` — anyone else (aggregators, gateways, someone else's box).
 *
 * In R9.1 the field is **stored and surfaced only**. R9.3 consumes it as a
 * redaction floor, where a target may *raise* the floor and never lower it.
 */
export const TARGET_TRUST_LEVELS = ["vendor", "local", "lan", "third-party"] as const;

export type TargetTrust = (typeof TARGET_TRUST_LEVELS)[number];

/** A non-secret target entry (from `proxy.targets`). */
export interface TargetEntry {
  readonly id: string;
  readonly provider: UpstreamProvider;
  readonly base_url: string;
  /** Model id to send. Omit on a byte-faithful target to forward the client's own id. */
  readonly model?: string;
  /** `proxy.accounts` id whose stored credential backs this target. Omit to inherit client auth. */
  readonly account?: string;
  readonly auth_scheme?: UpstreamAuthScheme;
  /** Omit to take {@link defaultTrustFor}, which errs toward MORE redaction. */
  readonly trust?: TargetTrust;
  /**
   * R9.3 — whether the triggering conversation may pick this target for a
   * `coder` draft. **Default true.**
   *
   * Selectable-by-default is the right polarity because declaring a target is
   * already a deliberate act; requiring a second opt-in on each one is ceremony
   * without safety. Setting this false opts ONE target out, for the case that
   * actually matters: an expensive target (your main vendor account) you want
   * reachable by an explicit route but never picked for a draft.
   *
   * The real guardrail is not this flag — it is that a selection can never reach
   * anything the user did not declare, and that every non-local dispatch is
   * redacted at the target's trust floor.
   */
  readonly agent_selectable?: boolean;
}

/** Where a row in the resolved registry came from. */
export type TargetOrigin =
  /** An explicit `proxy.targets` entry. */
  | "target"
  /** Derived from a `proxy.accounts` entry, so an existing config needs no edit. */
  | "account"
  /** The synthetic default: the top-level `proxy.upstream_*` config. */
  | "default";

/** A fully resolved target — non-secret throughout; the credential is never carried here. */
export interface ResolvedTarget {
  readonly id: string;
  readonly provider: UpstreamProvider;
  readonly baseUrl: string;
  readonly model: string | undefined;
  readonly authScheme: UpstreamAuthScheme;
  readonly trust: TargetTrust;
  /**
   * The `proxy.accounts` id whose credential backs this target, or null when it
   * inherits the client's own auth (the Anthropic default path).
   */
  readonly accountId: string | null;
  readonly origin: TargetOrigin;
}

/**
 * The proxy-settings shape this module reads — a structural subset of
 * `GolemSettings["proxy"]`, kept local so the providers module does not import
 * the config schema (same discipline as `UpstreamDisplaySettings`).
 */
export interface TargetRegistrySettings {
  readonly upstream_provider: UpstreamProvider;
  readonly upstream_base_url: string;
  readonly upstream_model?: string;
  readonly upstream_auth_scheme: UpstreamAuthScheme;
  readonly accounts?: readonly UpstreamAccount[];
  readonly active_account?: string;
  readonly targets?: readonly TargetEntry[];
  readonly default_target?: string;
}

/** Loopback hosts — the test for "this context never leaves the machine". */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

function hostOf(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * The trust level assumed when a target does not declare one.
 *
 * Deliberately pessimistic: anything that is not demonstrably the user's own
 * machine or their own vendor account is `third-party`, the level that will earn
 * the *most* redaction in R9.3. An omitted field must never buy a target more
 * of your context than it asked for.
 */
export function defaultTrustFor(provider: UpstreamProvider, baseUrl: string): TargetTrust {
  if (provider === "ollama") {
    const host = hostOf(baseUrl);
    return host !== undefined && LOOPBACK_HOSTS.has(host) ? "local" : "lan";
  }
  if (provider === "anthropic") return "vendor";
  return "third-party";
}

/**
 * The id of the synthetic default target — the top-level `proxy.upstream_*`
 * config. It is the provider name (e.g. `anthropic`), matching the synthetic
 * default *account* id so the two registries agree on what the cleared state is
 * called rather than inventing a second name for one thing.
 */
export function defaultTargetId(provider: UpstreamProvider): string {
  return provider;
}

function toResolved(
  entry: TargetEntry,
  origin: TargetOrigin,
  accountId: string | null,
): ResolvedTarget {
  return {
    id: entry.id,
    provider: entry.provider,
    baseUrl: entry.base_url,
    model: entry.model,
    authScheme: resolveAuthScheme(entry.provider, entry.auth_scheme ?? "inherit"),
    trust: entry.trust ?? defaultTrustFor(entry.provider, entry.base_url),
    accountId,
    origin,
  };
}

/**
 * The whole registry, in display order: the synthetic default, then every
 * `proxy.accounts` entry, then every explicit `proxy.targets` entry.
 *
 * **Accounts are surfaced as targets so an existing config needs no edit.** This
 * is not a greenfield registry — a real `.golem/settings.local.json` already
 * holds several accounts that are exactly the shape a target expresses (five
 * sharing one OpenRouter credential while naming different models, which is
 * precisely the many-targets-one-account case the split exists for). Deriving
 * them means `golem target list` is honest on day one instead of reporting an
 * empty table while the proxy happily serves those accounts.
 *
 * An explicit `proxy.targets` entry **replaces** a derived row of the same id,
 * in place, so adopting a target for an account you already have does not
 * duplicate it or reorder the table.
 */
export function listTargets(settings: TargetRegistrySettings): readonly ResolvedTarget[] {
  const rows: ResolvedTarget[] = [];

  rows.push(
    toResolved(
      {
        id: defaultTargetId(settings.upstream_provider),
        provider: settings.upstream_provider,
        base_url: settings.upstream_base_url,
        ...(settings.upstream_model !== undefined ? { model: settings.upstream_model } : {}),
        auth_scheme: settings.upstream_auth_scheme,
      },
      "default",
      null,
    ),
  );

  for (const account of settings.accounts ?? []) {
    rows.push(
      toResolved(
        {
          id: account.id,
          provider: account.provider,
          base_url: account.base_url,
          ...(account.model !== undefined ? { model: account.model } : {}),
          ...(account.auth_scheme !== undefined ? { auth_scheme: account.auth_scheme } : {}),
        },
        "account",
        account.id,
      ),
    );
  }

  for (const entry of settings.targets ?? []) {
    // An explicit target with no `account` still needs a credential story: fall
    // back to an account of the same id when one exists, so `[[proxy.targets]]`
    // can adopt an already-logged-in account without restating the reference.
    const accountId =
      entry.account ?? ((settings.accounts ?? []).some((a) => a.id === entry.id) ? entry.id : null);
    const resolved = toResolved(entry, "target", accountId);
    const existing = rows.findIndex((r) => r.id === entry.id);
    if (existing >= 0) rows[existing] = resolved;
    else rows.push(resolved);
  }

  return rows;
}

/**
 * Which target is used when a request names none.
 *
 * `default_target` is the new selector; `active_account` is the R6.2 one. Reading
 * the old key when the new one is unset **is** the migration shim (Decision 21d
 * → per-target selection): an existing config keeps working with no edit and no
 * rewrite of the user's settings file.
 */
export function resolveDefaultTargetId(settings: TargetRegistrySettings): string {
  return (
    settings.default_target ??
    settings.active_account ??
    defaultTargetId(settings.upstream_provider)
  );
}

/** The outcome of a lookup. Fail-closed: an unknown id yields no target at all. */
export type TargetLookup =
  | { readonly ok: true; readonly target: ResolvedTarget }
  | { readonly ok: false; readonly reason: string; readonly known: readonly string[] };

/**
 * Look up one target by id.
 *
 * **Never substitutes.** An unknown id is an error carrying the list of ids that
 * do exist — not a quiet fallback to the default. Falling back would mean a
 * typo'd or stale target id silently ships the request (and the context) to a
 * different model than the one named, which is exactly the failure ADR-0003's
 * fail-closed rule exists to prevent for accounts.
 */
export function resolveTarget(settings: TargetRegistrySettings, id: string): TargetLookup {
  const targets = listTargets(settings);
  const found = targets.find((t) => t.id === id);
  if (found !== undefined) return { ok: true, target: found };
  const known = targets.map((t) => t.id);
  return {
    ok: false,
    reason:
      `unknown target "${id}" — it is in neither proxy.targets nor proxy.accounts. ` +
      `Configured targets: ${known.join(", ") || "(none)"}. No substitute was used.`,
    known,
  };
}

/**
 * Every `proxy.accounts` id referenced by some target (plus the resolved default
 * target's own account, if it has one).
 *
 * This is what generalizes the spawn-time credential preflight from the single
 * active account to N: `perAccountEnvVar` was already designed per-account
 * (Decision 47), so no new secret mechanism is needed — the CLI still owns
 * resolution and injects at spawn. The daemon's environment does now carry N
 * credentials instead of 1; that is accepted, and recorded as a widened blast
 * radius rather than discovered later.
 */
export function accountsReferencedByTargets(settings: TargetRegistrySettings): readonly string[] {
  const ids = new Set<string>();
  for (const target of listTargets(settings)) {
    if (target.accountId !== null) ids.add(target.accountId);
  }
  return [...ids];
}

/** A misconfiguration on one target, surfaced at startup rather than on the first request. */
export interface TargetWarning {
  readonly targetId: string;
  readonly message: string;
}

/**
 * Non-credential misconfigurations, per target. Startup warns for **every**
 * target rather than only the active one — a broken target that is not yet
 * routed to is still broken, and the whole point of a registry is that you find
 * that out before you route to it.
 *
 * Credential presence is deliberately NOT checked here: this module never reads
 * the credential store (it stays a pure function of non-secret config). The CLI
 * layer, which owns store access, adds the missing-credential warning.
 */
export function targetWarnings(settings: TargetRegistrySettings): readonly TargetWarning[] {
  const warnings: TargetWarning[] = [];
  for (const target of listTargets(settings)) {
    // A translating provider must be told which model to ask for — the client
    // sends a `claude-*` id the upstream does not have (Decision 48).
    if (isTranslatingProvider(target.provider) && target.model === undefined) {
      warnings.push({
        targetId: target.id,
        message:
          `provider "${target.provider}" translates the request, so it needs a model id, ` +
          `but target "${target.id}" declares none — the client's own claude-* id would be ` +
          "sent to an upstream that does not have it.",
      });
    }
    const doubled = doubledVersionSegment(target.provider, target.baseUrl);
    if (doubled !== undefined) {
      warnings.push({
        targetId: target.id,
        message:
          `base URL "${target.baseUrl}" composes into ${doubled} — the API version segment is ` +
          "repeated, so requests will 404. Drop the trailing version segment.",
      });
    }
  }
  return warnings;
}
