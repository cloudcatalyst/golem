/**
 * R6.2 v1 + Decisions 46/47 — the `golem gateway` gateway REGISTRY (spec
 * Decision 21d; ADR-0003, amended). Extracted verbatim from `../gateways.ts`.
 *
 * The read/report half, plus the audit log every mutating command appends to.
 * ADR-0003 invariant 1 lives here: a gateway entry is NON-SECRET config, and
 * nothing in this module ever reads a credential VALUE. {@link collectGateways}
 * asks the store only for `status` — presence and location — so a row can say
 * *where* a key resolves from without the value ever entering a report, and
 * {@link renderGateways} therefore has no secret available to print.
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { defaultUserDir, loadConfig } from "../../config/index.js";
import type { ProxySettings } from "../../config/schema.js";
import {
  type CredentialFault,
  type CredentialStore,
  createCredentialStore,
  DEFAULT_GATEWAY_ID,
} from "../../credentials/index.js";
import { listTargets } from "../../providers/index.js";

/**
 * A non-secret gateway descriptor: either a named `proxy.gateways` entry or the
 * synthetic default built from the top-level `proxy.upstream_*` config. The
 * registry's gateway shape is not an exported schema type, so this is derived
 * from {@link ProxySettings} (adding the `id` the array element carries).
 */
export type RegistryGateway = NonNullable<ProxySettings["gateways"]>[number];
export interface GatewayTarget {
  readonly id: string;
  readonly provider: ProxySettings["upstream_provider"];
  readonly base_url: string;
  readonly model?: string;
  readonly auth_scheme: NonNullable<RegistryGateway["auth_scheme"]>;
}

export interface GatewayRow {
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
   * R10.24 — every model this gateway fronts, so a picker can offer them all.
   * `model` above is ONE of these (the active one when this gateway is active,
   * else the gateway's first), which is why it could not be the whole answer: a
   * gateway with a qwen and a deepseek entry rendered only the first, on every
   * surface, however the user had switched.
   */
  readonly models: readonly string[];
  /**
   * True for the synthetic DEFAULT account — the top-level upstream config the
   * proxy falls back to when no named account is active. It is not a
   * `proxy.gateways` entry; selecting it just clears `inference.default_target`.
   */
  readonly is_default?: boolean;
}

export interface GatewaysReport {
  /**
   * The active account id: a named account, or the synthetic default id (the
   * top-level provider, e.g. `anthropic`) when no named account is active.
   * Never null — the default is always a real, selectable identity.
   */
  readonly active: string;
  /**
   * R10.24 — the selection VERBATIM, which since R10.24 may be a target id
   * (`openrouter:deepseek/deepseek-v4-flash`) and not just a gateway id. `active`
   * stays the backing GATEWAY id so every existing consumer keeps its meaning;
   * this is the field that says which MODEL is selected. Null when nothing is
   * selected (the synthetic default) or the selection is unknown.
   */
  readonly active_target: string | null;
  /**
   * True when `inference.default_target` names an id that is neither a known
   * gateway nor a known target (misconfig).
   */
  readonly active_unknown: boolean;
  readonly gateways: readonly GatewayRow[];
}

/**
 * The id of the synthetic DEFAULT account — the top-level upstream config used
 * when no named account is active. It is simply the top-level provider name
 * (e.g. `anthropic`), so the cleared state reads as a real destination rather
 * than "(none)". Selecting it clears `inference.default_target`.
 */
export function defaultGatewayId(provider: string): string {
  return provider;
}

/**
 * The credential-store id for the synthetic default account. The display id is
 * the provider name (`anthropic`); the store id is the reserved
 * {@link DEFAULT_GATEWAY_ID}, so the top-level upstream config's credential is
 * stored under one stable key regardless of which provider it currently names.
 */
export const DEFAULT_STORE_ID = DEFAULT_GATEWAY_ID;

/**
 * Read the account registry + which is active (best-effort; never reads secret
 * values). `env` overrides the process environment used for the non-secret
 * `GOLEM_<SECTION>_<KEY>` settings overrides only — credentials come from the
 * OS store, never the environment (Decision 47), so on a machine with a stored
 * key the `key_set` flags are true regardless of what `env` says.
 */
export async function collectGateways(
  projectDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  opts: { readonly store_backend?: CredentialStore } = {},
): Promise<GatewaysReport> {
  const { settings } = await loadConfig({ projectDir, env });
  const selected = settings.inference.default_target ?? null;
  const gateways = settings.proxy.gateways ?? [];
  const defaultId = defaultGatewayId(settings.proxy.upstream_provider);
  const store = opts.store_backend ?? createCredentialStore({ userDir: defaultUserDir() });
  // R10.24: the selection may name a TARGET (one model of a gateway) rather than
  // the gateway itself. Resolve it once here — a target that resolves is not a
  // misconfiguration, and the gateway behind it is the one to mark active.
  const selectedTarget =
    selected === null ? undefined : listTargets(settings.proxy).find((t) => t.id === selected);

  // The default is active whenever no named gateway is selected, or the
  // selection names the default id itself.
  const defaultActive = selected === null || selected === defaultId;
  const defStatus = await store.status(DEFAULT_STORE_ID);
  const defaultRow: GatewayRow = {
    id: defaultId,
    provider: settings.proxy.upstream_provider,
    base_url: settings.proxy.upstream_base_url,
    model: settings.proxy.upstream_model ?? null,
    // The synthetic default forwards the client's own model id, so it fronts no
    // enumerable model list of its own.
    models: [],
    key_set: defStatus.present,
    ...(defStatus.location !== undefined ? { key_location: defStatus.location.label } : {}),
    ...(defStatus.faults.length > 0 ? { key_faults: defStatus.faults } : {}),
    active: defaultActive,
    is_default: true,
  };

  const namedRows: GatewayRow[] = await Promise.all(
    gateways.map(async (g) => {
      const st = await store.status(g.id);
      return {
        id: g.id,
        provider: g.provider,
        base_url: g.base_url,
        // R10.24: when a target of THIS gateway is selected, name the model that
        // is actually in force. This was always `models[0]`, so a gateway
        // fronting several models reported the first one whatever was selected.
        model:
          selectedTarget?.accountId === g.id
            ? (selectedTarget.model ?? null)
            : ((g.models ?? [])[0] ?? null),
        models: g.models ?? [],
        key_set: st.present,
        ...(st.location !== undefined ? { key_location: st.location.label } : {}),
        ...(st.faults.length > 0 ? { key_faults: st.faults } : {}),
        // Active either by its own id, or because the selected target is one of
        // its models.
        active: g.id === selected || selectedTarget?.accountId === g.id,
      };
    }),
  );

  // Unknown = a selection that is neither the default id, a known named gateway,
  // nor (R10.24) a known target — a genuine misconfig, and the proxy falls back
  // to the top-level config.
  const activeUnknown =
    selected !== null &&
    selected !== defaultId &&
    !gateways.some((g) => g.id === selected) &&
    selectedTarget === undefined;
  // `active` stays a GATEWAY id: the gateway itself when one was selected, the
  // gateway BEHIND a selected target, else the synthetic default.
  const active =
    defaultActive || activeUnknown
      ? defaultId
      : (selectedTarget?.accountId ?? selectedTarget?.id ?? selected);
  const activeTarget = activeUnknown || selectedTarget === undefined ? null : selectedTarget.id;

  return {
    active,
    active_target: activeTarget,
    active_unknown: activeUnknown,
    gateways: [defaultRow, ...namedRows],
  };
}

/** Append a non-secret event to the audit log (ADR-0003). Fire-and-forget safe. */
export async function appendAudit(
  projectDir: string,
  entry: { readonly action: string; readonly account: string | null },
  nowIso: string,
): Promise<void> {
  const file = path.join(projectDir, ".golem", "state", "account-log.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify({ ts: nowIso, ...entry })}\n`, "utf8");
}

/** Human-readable rendering of {@link GatewaysReport}. */
export function renderGateways(report: GatewaysReport): string {
  const lines: string[] = [];
  lines.push("Golem upstream gateways (credential values are never shown):");
  for (const a of report.gateways) {
    const mark = a.active ? "*" : " ";
    const key = a.key_set
      ? `key set — ${a.key_location ?? "stored"}`
      : `key MISSING (set it with: golem gateway login ${a.id})`;
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
      "active: (default) — WARNING: inference.default_target names an id not in proxy.gateways; " +
        "the proxy falls back to the top-level config (no silent switch to another gateway).",
    );
  } else {
    lines.push(`active: ${report.active}`);
  }
  return `${lines.join("\n")}\n`;
}
