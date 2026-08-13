/**
 * R9.1 — `golem target` (proposal `multi-target-routing.md`; ADR-0003).
 *
 * The reporting and registration half of the target registry. The resolution
 * logic itself is a pure function in `src/providers/targets.ts`; this module is
 * the layer that may touch the credential store and the settings files, and it
 * keeps ADR-0003's invariants at that boundary:
 *
 * - **A target holds no secret.** `add` writes non-secret identity only; the
 *   credential still comes from `golem gateway login <account>` and lives in the
 *   OS store. `list` reports only WHERE a credential resolves from and whether
 *   it resolves at all — never its value.
 * - **Fail-closed.** An unknown target id is an error naming the ids that do
 *   exist, never a quiet fallback to another target.
 * - **Audit.** Registrations append to the same `.golem/state/account-log.jsonl`
 *   the account commands use — one log, because "which endpoint did my context
 *   go to" is the same question whichever registry answered it.
 *
 * Nothing here changes proxy behaviour. In R9.1 the registry is inert
 * configuration; R9.2 routes on it and R9.3 dispatches `coder` through it.
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { defaultUserDir, loadConfig, writeSetting } from "../config/index.js";
import type { ProxySettings } from "../config/schema.js";
import {
  type CredentialFault,
  type CredentialStore,
  createCredentialStore,
  DEFAULT_GATEWAY_ID,
} from "../credentials/index.js";
import { probeCredential } from "../credentials/probe.js";
import {
  isKeylessProvider,
  listTargets,
  type ResolvedTarget,
  resolveDefaultTargetId,
  resolveTarget,
  TARGET_TRUST_LEVELS,
  type TargetEntry,
  type TargetOrigin,
  type TargetTrust,
  targetWarnings,
  withDefaultTarget,
} from "../providers/index.js";
import { InitError } from "./init.js";

/** One row of `golem target list` — non-secret throughout. */
export interface TargetRow {
  readonly id: string;
  readonly provider: string;
  readonly base_url: string;
  readonly model: string | null;
  readonly trust: TargetTrust;
  readonly origin: TargetOrigin;
  /** The account id backing this target, or null when it inherits the client's auth. */
  readonly account: string | null;
  /** Whether a credential resolves for this target's account (never the value). */
  readonly key_set: boolean;
  readonly key_location?: string;
  readonly key_faults?: readonly CredentialFault[];
  readonly is_default: boolean;
  /** Misconfigurations to surface — empty when the target is sound. */
  readonly warnings: readonly string[];
}

export interface TargetsReport {
  /** The id serving requests that name no target. */
  readonly default_target: string;
  /** True when the resolved default names an id that is not in the registry (misconfig). */
  readonly default_unknown: boolean;
  readonly targets: readonly TargetRow[];
}

/** Append a non-secret event to the shared account audit log (ADR-0003 invariant 5). */
async function appendAudit(
  projectDir: string,
  entry: { readonly action: string; readonly target: string },
  nowIso: string,
): Promise<void> {
  const file = path.join(projectDir, ".golem", "state", "account-log.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify({ ts: nowIso, ...entry })}\n`, "utf8");
}

/**
 * The credential-store id to consult for a target: its referenced account, or
 * the reserved default-account id for the synthetic top-level target (whose key
 * is stored under one stable name regardless of which provider it currently
 * points at).
 */
function storeIdFor(target: ResolvedTarget): string {
  return target.accountId ?? DEFAULT_GATEWAY_ID;
}

/**
 * Read the whole registry, with per-target credential status and warnings.
 * Never reads a secret value — only whether one resolves and from where.
 */
export async function collectTargets(
  projectDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  opts: { readonly store_backend?: CredentialStore } = {},
): Promise<TargetsReport> {
  const { settings } = await loadConfig({ projectDir, env });
  const proxy = settings.proxy;
  const targets = listTargets(proxy);
  // R9.23: default_target moved to inference, but proxy may still carry it
  // via the migration table (proxy.active_account → proxy.default_target).
  const defaultId = resolveDefaultTargetId(withDefaultTarget(settings));
  const store = opts.store_backend ?? createCredentialStore({ userDir: defaultUserDir() });

  // Config-level warnings are computed once for the whole registry, then
  // attached to the target they belong to.
  const configWarnings = targetWarnings(proxy);

  const rows: TargetRow[] = await Promise.all(
    targets.map(async (t) => {
      const status = await store.status(storeIdFor(t));
      const warnings = configWarnings.filter((w) => w.targetId === t.id).map((w) => w.message);
      // A target that names an account with no stored credential cannot
      // authenticate. The synthetic default is exempt: it may legitimately run
      // keyless, because `inherit` forwards the client's own auth.
      //
      // R10.8: so is a model server the user runs themselves (`ollama`,
      // `llamacpp`). It is not that a missing key is tolerable there — it is
      // that a key is not part of how you reach it, so reporting its absence as
      // a defect and telling the user to run `gateway login` is advice their
      // server would ignore. Keyless is the CORRECT state for these, not a
      // degraded one.
      if (t.accountId !== null && !status.present && !isKeylessProvider(t.provider)) {
        warnings.push(
          `no credential is stored for account "${t.accountId}" — set one with: ` +
            `golem gateway login ${t.accountId}`,
        );
      }
      return {
        id: t.id,
        provider: t.provider,
        base_url: t.baseUrl,
        model: t.model ?? null,
        trust: t.trust,
        origin: t.origin,
        account: t.accountId,
        key_set: status.present,
        ...(status.location !== undefined ? { key_location: status.location.label } : {}),
        ...(status.faults.length > 0 ? { key_faults: status.faults } : {}),
        is_default: t.id === defaultId,
        warnings,
      };
    }),
  );

  return {
    default_target: defaultId,
    default_unknown: !targets.some((t) => t.id === defaultId),
    targets: rows,
  };
}

/** Full detail for one target. Fail-closed on an unknown id. */
export async function showTarget(
  projectDir: string,
  id: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  opts: { readonly store_backend?: CredentialStore } = {},
): Promise<TargetRow> {
  const report = await collectTargets(projectDir, env, opts);
  const row = report.targets.find((t) => t.id === id);
  if (row === undefined) {
    const ids = report.targets.map((t) => t.id).join(", ") || "(none configured)";
    throw new InitError(`unknown target "${id}"; configured targets: ${ids}`);
  }
  return row;
}

/** Input for {@link addTarget}. All fields are NON-SECRET (ADR-0003 invariant 1). */
export interface NewTarget {
  readonly id: string;
  /**
   * R9.23: which `proxy.gateways` entry backs this target. The gateway entry
   * carries the provider, base_url, auth_scheme, models, and credential reference.
   */
  readonly gateway: string;
  readonly model?: string;
  readonly trust?: TargetTrust;
}

/**
 * Register a target in `proxy.targets`.
 *
 * Written to the **local** scope for the same reason `addAccount` is: the proxy
 * reads the merged config, and an array leaf in a higher-precedence layer
 * wholesale-replaces lower ones, so writing anywhere lower would let a
 * pre-existing local-layer `targets` silently mask the change.
 *
 * Fail-closed on a duplicate explicit id and on a `gateway` reference that does
 * not exist — a target pointing at a missing gateway can never authenticate, and
 * catching that here is much cheaper than a 401 on the first routed request.
 * Overriding a GATEWAY-derived row of the same id is allowed and reported:
 * that is the documented way to adopt an existing gateway as a target (adding
 * a `trust` level or a different model) without restating its credential.
 */
export async function addTarget(
  projectDir: string,
  input: NewTarget,
  nowIso: string,
): Promise<{ readonly target: string; readonly overrides_gateway: boolean }> {
  const { settings } = await loadConfig({ projectDir });
  const proxy: ProxySettings = settings.proxy;
  const targets = [...(proxy.targets ?? [])];

  if (targets.some((t) => t.id === input.id)) {
    throw new InitError(
      `target "${input.id}" already exists in proxy.targets. Edit it directly, or remove it ` +
        "and re-add.",
    );
  }
  if (!(proxy.gateways ?? []).some((g) => g.id === input.gateway)) {
    const ids = (proxy.gateways ?? []).map((g) => g.id).join(", ") || "(none configured)";
    throw new InitError(
      `target "${input.id}" references gateway "${input.gateway}", which is not in ` +
        `proxy.gateways; configured gateways: ${ids}. Register it first with ` +
        `\`golem gateway add ${input.gateway} …\`, then \`golem gateway login ${input.gateway}\`.`,
    );
  }

  // R9.23: detect if the new target's id matches a GATEWAY-DERIVED target
  // (compound id `<gateway>/<model>`). The gateway-derived target is what
  // `listTargets` produces, so use it to determine whether this add overrides.
  const derived = listTargets(proxy);
  const overridesGateway = derived.some((t) => t.id === input.id && t.origin === "gateway");
  const entry: TargetEntry = {
    id: input.id,
    gateway: input.gateway,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.trust !== undefined ? { trust: input.trust } : {}),
  };
  // writeSetting validates the WHOLE array against the targets leaf schema.
  await writeSetting("local", "proxy.targets", [...targets, entry], { projectDir });
  await appendAudit(projectDir, { action: "target-add", target: input.id }, nowIso);
  return { target: input.id, overrides_gateway: overridesGateway };
}

/** The verdict from {@link testTarget} — a credential probe scoped to one target. */
export interface TargetTestResult {
  readonly target: string;
  readonly verdict: string;
  readonly detail?: string;
  readonly request_url?: string;
  readonly config_warning?: string;
}

/**
 * Probe one target's credential against its own endpoint, reusing the existing
 * `account login` probe path rather than inventing a second notion of "does this
 * work". Fail-closed on an unknown id.
 *
 * A target with no resolvable credential is reported as `no-credential` rather
 * than probed: sending an unauthenticated request would produce a 401 that says
 * nothing about whether the *stored* key is good.
 */
export async function testTarget(
  projectDir: string,
  id: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  opts: { readonly store_backend?: CredentialStore } = {},
): Promise<TargetTestResult> {
  const { settings } = await loadConfig({ projectDir, env });
  const lookup = resolveTarget(settings.proxy, id);
  if (!lookup.ok) throw new InitError(lookup.reason);
  const target = lookup.target;

  const store = opts.store_backend ?? createCredentialStore({ userDir: defaultUserDir() });
  const hit = await store.resolve(storeIdFor(target));
  // R10.8: for a server the user runs themselves there is no credential to
  // report missing — but there IS something worth testing, namely whether the
  // endpoint answers at all. Probe it keyless rather than returning a verdict
  // about a key that was never part of reaching it.
  if (hit === null && !isKeylessProvider(target.provider)) {
    return {
      target: id,
      verdict: "no-credential",
      detail:
        target.accountId === null
          ? "this target inherits the client's own auth, so there is nothing stored to probe."
          : `no credential is stored for account "${target.accountId}" — ` +
            `set one with: golem gateway login ${target.accountId}`,
    };
  }

  const result = await probeCredential({
    provider: target.provider,
    baseUrl: target.baseUrl,
    authScheme: target.authScheme,
    secret: hit?.secret ?? "",
  });
  return {
    target: id,
    verdict: result.verdict,
    ...(result.detail !== undefined ? { detail: result.detail } : {}),
    ...(result.requestUrl !== undefined ? { request_url: result.requestUrl } : {}),
    ...(result.configWarning !== undefined ? { config_warning: result.configWarning } : {}),
  };
}

const ORIGIN_TAG: Readonly<Record<TargetOrigin, string>> = {
  target: "",
  gateway: " (from gateway)",
  default: " (default upstream config)",
};

/** Human-readable rendering of {@link TargetsReport}. */
export function renderTargets(report: TargetsReport): string {
  const lines: string[] = [];
  lines.push("Golem targets (credential values are never shown):");
  for (const t of report.targets) {
    const mark = t.is_default ? "*" : " ";
    const model = t.model !== null ? ` model=${t.model}` : "";
    lines.push(`  ${mark} ${t.id.padEnd(28)} ${t.provider} ${t.base_url}${model}`);
    const key = t.key_set
      ? `key set — ${t.key_location ?? "stored"}`
      : t.account === null
        ? "no stored key (inherits the client's auth)"
        : "key MISSING";
    lines.push(
      `        trust=${t.trust} account=${t.account ?? "(inherit)"} ${key}${ORIGIN_TAG[t.origin]}`,
    );
    for (const f of t.key_faults ?? []) {
      lines.push(`        warning: ${f.backend} store error — ${f.message}`);
    }
    for (const w of t.warnings) lines.push(`        warning: ${w}`);
  }
  lines.push("");
  if (report.default_unknown) {
    lines.push(
      `default target: ${report.default_target} — WARNING: that id is in neither ` +
        "proxy.targets nor proxy.gateways. Requests naming no target fail closed rather " +
        "than silently using a different one.",
    );
  } else {
    lines.push(`default target: ${report.default_target}`);
  }
  lines.push(`trust levels: ${TARGET_TRUST_LEVELS.join(" | ")} (stored now, enforced in R9.3)`);
  return `${lines.join("\n")}\n`;
}
