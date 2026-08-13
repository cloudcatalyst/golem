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

import type { GatewayEntry } from "./gateways.js";
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
  /**
   * R9.23: which `proxy.gateways` entry backs this target. The gateway entry
   * carries the provider, base_url, and credential reference; several targets
   * may share one gateway (one key backing several model ids).
   */
  readonly gateway: string;
  /** Model id to send. Omit on a byte-faithful target to forward the client's own id. */
  readonly model?: string;
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
  /** Derived from a `proxy.gateways` entry (was `proxy.accounts` in R9.22 and earlier). */
  | "gateway"
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
   * The `proxy.gateways` id whose credential backs this target, or null when it
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
  /** R9.23: renamed from `accounts`. */
  readonly gateways?: readonly GatewayEntry[];
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
  // R10.8: `llamacpp` joins `ollama` here — both are model servers the user runs
  // themselves, so the honest trust level is a property of WHERE it is, never of
  // the provider name. The same `llama-server` binary is `local` on loopback and
  // `lan` on `http://gpubox.lan:8080`; hardcoding "llamacpp = local" would hand
  // an unredacted prompt to a box across the room on the strength of a config
  // string. The URL decides, and the dispatcher re-checks loopback independently
  // before it honours `trust: "local"` at all.
  if (provider === "ollama" || provider === "llamacpp") {
    const host = hostOf(baseUrl);
    return host !== undefined && LOOPBACK_HOSTS.has(host) ? "local" : "lan";
  }
  if (provider === "anthropic") return "vendor";
  return "third-party";
}

/**
 * The id of the synthetic default target — the top-level `proxy.upstream_*`
 * config. It is the provider name (e.g. `anthropic`), matching the synthetic
 * default gateway id so the two registries agree on what the cleared state is
 * called rather than inventing a second name for one thing.
 */
export function defaultTargetId(provider: UpstreamProvider): string {
  return provider;
}

/** Look up a gateway by id; returns undefined when missing. */
function lookupGateway(
  gateways: readonly GatewayEntry[] | undefined,
  id: string,
): GatewayEntry | undefined {
  return gateways?.find((g) => g.id === id);
}

/**
 * Find targets by model name across all gateways. Case-insensitive substring
 * match (e.g. `"qwen3"` matches `"qwen/qwen3.7-flash"` and
 * `"qwen/qwen3-14b"`). Returns all matching targets, or empty array.
 */
export function resolveModel(
  settings: TargetRegistrySettings,
  name: string,
): readonly ResolvedTarget[] {
  const targets = listTargets(settings);
  const lower = name.toLowerCase();
  return targets.filter((t) => t.model?.toLowerCase().includes(lower) === true);
}

/**
 * Build a ResolvedTarget from a gateway + optional model override.
 * The target's id is `<gateway>:<model>` when a model is given, else `<gateway>`.
 */
function toResolved(
  id: string,
  gateway: GatewayEntry,
  model: string | undefined,
  trust: TargetTrust | undefined,
  origin: TargetOrigin,
): ResolvedTarget {
  return {
    id,
    provider: gateway.provider,
    baseUrl: gateway.base_url,
    model: model ?? gateway.models?.[0],
    authScheme: resolveAuthScheme(gateway.provider, gateway.auth_scheme ?? "inherit"),
    trust: trust ?? defaultTrustFor(gateway.provider, gateway.base_url),
    accountId: gateway.id,
    origin,
  };
}

/**
 * The whole registry, in display order: the synthetic default, then every
 * target derived from `proxy.gateways`, then every explicit `proxy.targets` entry.
 *
 * **Gateways are surfaced as targets so an existing config needs no edit.** A
 * gateway with `models: ["claude-sonnet-5", "claude-haiku-5"]` produces two
 * derived targets (one per model). A gateway with no models or omitted models
 * produces one derived target with no fixed model (the old single-account
 * behaviour).
 *
 * An explicit `proxy.targets` entry **replaces** a derived row of the same id,
 * in place, so adopting a target for a gateway you already have does not
 * duplicate it or reorder the table.
 */
export function listTargets(settings: TargetRegistrySettings): readonly ResolvedTarget[] {
  const rows: ResolvedTarget[] = [];

  // 1. Synthetic default from the top-level config
  rows.push({
    ...toResolved(
      defaultTargetId(settings.upstream_provider),
      {
        id: defaultTargetId(settings.upstream_provider),
        provider: settings.upstream_provider,
        base_url: settings.upstream_base_url,
        auth_scheme: settings.upstream_auth_scheme,
        // Default target has no explicit models — it forwards the client's own id
      },
      settings.upstream_model,
      undefined, // default trust computed from provider + base_url
      "default",
    ),
    // The synthetic default uses the legacy global env var, not per-gateway creds
    accountId: null,
  });

  // 2. One target per model per gateway
  for (const gateway of settings.gateways ?? []) {
    if (gateway.models !== undefined && gateway.models.length > 0) {
      for (const model of gateway.models) {
        rows.push(toResolved(`${gateway.id}:${model}`, gateway, model, undefined, "gateway"));
      }
    } else {
      // No explicit models — derive a single target from the gateway itself
      rows.push(toResolved(gateway.id, gateway, undefined, undefined, "gateway"));
    }
  }

  // 3. Explicit proxy.targets entries (may replace derived rows)
  for (const entry of settings.targets ?? []) {
    const gw = lookupGateway(settings.gateways, entry.gateway);
    if (gw === undefined) {
      // Unknown gateway reference — skip; the CLI warns at startup
      continue;
    }
    const resolved = toResolved(entry.id, gw, entry.model, entry.trust, "target");
    const existing = rows.findIndex((r) => r.id === entry.id);
    if (existing >= 0) rows[existing] = resolved;
    else rows.push(resolved);
  }

  return rows;
}

/**
 * Which target is used when a request names none.
 *
 * R9.6: the `active_account` fallback that used to live here is now a declarative
 * entry in `src/config/migrations.ts`, applied by the loader — so this reads one
 * key and the rename is handled in exactly one place.
 *
 * R9.23: `default_target` may reference a gateway id (e.g. `"openrouter"`) rather
 * than a full compound target id (e.g. `"openrouter:qwen/qwen3-14b"`). It may
 * also be a bare model name (e.g. `"qwen3"`) which is resolved via
 * {@link resolveModel}. When the selector does not match any target id directly,
 * it is resolved to the first target derived from that gateway. This preserves
 * backward compatibility for settings files that name a gateway.
 */
export function resolveDefaultTargetId(settings: TargetRegistrySettings): string {
  const raw = settings.default_target ?? defaultTargetId(settings.upstream_provider);
  // Try the raw value as a target id first (fast path for compound ids).
  // This does NOT call listTargets unconditionally to avoid an extra list pass
  // when no resolution is needed.
  if (settings.default_target !== undefined && settings.gateways !== undefined) {
    const targets = listTargets(settings);
    if (!targets.some((t) => t.id === raw)) {
      // Raw value is not a target id — check if it's a gateway id
      const first = targets.find((t) => t.accountId === raw);
      if (first !== undefined) return first.id;
    }
  }
  return raw;
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
      `unknown target "${id}" — it is in neither proxy.targets nor proxy.gateways. ` +
      `Configured targets: ${known.join(", ") || "(none)"}. No substitute was used.`,
    known,
  };
}

/**
 * Every `proxy.gateways` id referenced by some target (plus the resolved default
 * target's own gateway, if it has one).
 *
 * This is what generalizes the spawn-time credential preflight from the single
 * active account to N: `perGatewayEnvVar` (was `perAccountEnvVar`, renamed in
 * R9.23) was already designed per-gateway (Decision 47), so no new secret
 * mechanism is needed — the CLI still owns resolution and injects at spawn. The
 * daemon's environment does now carry N credentials instead of 1; that is
 * accepted, and recorded as a widened blast radius rather than discovered later.
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
