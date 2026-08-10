/**
 * R9.1 — `golem target` (proposal `multi-target-routing.md`; ADR-0003).
 *
 * The reporting and registration half of the target registry. The resolution
 * logic itself is a pure function in `src/providers/targets.ts`; this module is
 * the layer that may touch the credential store and the settings files, and it
 * keeps ADR-0003's invariants at that boundary:
 *
 * - **A target holds no secret.** `add` writes non-secret identity only; the
 *   credential still comes from `golem account login <account>` and lives in the
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
  DEFAULT_ACCOUNT_ID,
} from "../credentials/index.js";
import { probeCredential } from "../credentials/probe.js";
import {
  doubledVersionSegment,
  isSpawnProvider,
  isTranslatingProvider,
  listTargets,
  type ResolvedTarget,
  resolveDefaultTargetId,
  resolveTarget,
  TARGET_TRUST_LEVELS,
  type TargetEntry,
  type TargetOrigin,
  type TargetTrust,
  targetWarnings,
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
  return target.accountId ?? DEFAULT_ACCOUNT_ID;
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
  const defaultId = resolveDefaultTargetId(proxy);
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
      if (t.accountId !== null && !status.present) {
        warnings.push(
          `no credential is stored for account "${t.accountId}" — set one with: ` +
            `golem account login ${t.accountId}`,
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
  readonly provider: TargetEntry["provider"];
  readonly base_url: string;
  readonly model?: string;
  readonly account?: string;
  readonly auth_scheme?: TargetEntry["auth_scheme"];
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
 * Fail-closed on a duplicate explicit id and on an `account` reference that does
 * not exist — a target pointing at a missing account can never authenticate, and
 * catching that here is much cheaper than a 401 on the first routed request.
 * Overriding an ACCOUNT-derived row of the same id is allowed and reported: that
 * is the documented way to adopt an existing account as a target (adding a
 * `trust` level or a different model) without restating its credential.
 */
export async function addTarget(
  projectDir: string,
  input: NewTarget,
  nowIso: string,
): Promise<{ readonly target: string; readonly overrides_account: boolean }> {
  const { settings } = await loadConfig({ projectDir });
  const proxy: ProxySettings = settings.proxy;
  const targets = [...(proxy.targets ?? [])];

  if (targets.some((t) => t.id === input.id)) {
    throw new InitError(
      `target "${input.id}" already exists in proxy.targets. Edit it directly, or remove it ` +
        "and re-add.",
    );
  }
  if (input.account !== undefined && !(proxy.accounts ?? []).some((a) => a.id === input.account)) {
    const ids = (proxy.accounts ?? []).map((a) => a.id).join(", ") || "(none configured)";
    throw new InitError(
      `target "${input.id}" references account "${input.account}", which is not in ` +
        `proxy.accounts; configured accounts: ${ids}. Register it first with ` +
        `\`golem account add ${input.account} …\`, then \`golem account login ${input.account}\`.`,
    );
  }

  // Same two registration-time checks `account add` makes, for the same reason:
  // both fail on the FIRST request otherwise, one of them with an HTML 404.
  // R9.15: `claude-cli` is neither byte-faithful nor translating — the model id
  // becomes the spawned client's `--model`, so it is very much used on the wire.
  // Without this exclusion `target add` printed a warning that was simply false.
  if (
    input.model !== undefined &&
    !isTranslatingProvider(input.provider) &&
    !isSpawnProvider(input.provider)
  ) {
    process.stderr.write(
      `warning: provider "${input.provider}" is byte-faithful (it forwards the client's own ` +
        `model id unchanged), so model "${input.model}" will be IGNORED on the wire — it is ` +
        "recorded for display only.\n",
    );
  }
  const doubled = doubledVersionSegment(input.provider, input.base_url);
  if (doubled !== undefined) {
    process.stderr.write(
      `warning: base URL "${input.base_url}" composes into ${doubled} — the API version ` +
        "segment is repeated, so requests will 404. Drop the trailing version segment.\n",
    );
  }

  const overridesAccount = (proxy.accounts ?? []).some((a) => a.id === input.id);
  const entry: TargetEntry = {
    id: input.id,
    provider: input.provider,
    base_url: input.base_url,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.account !== undefined ? { account: input.account } : {}),
    ...(input.auth_scheme !== undefined ? { auth_scheme: input.auth_scheme } : {}),
    ...(input.trust !== undefined ? { trust: input.trust } : {}),
  };
  // writeSetting validates the WHOLE array against the targets leaf schema.
  await writeSetting("local", "proxy.targets", [...targets, entry], { projectDir });
  await appendAudit(projectDir, { action: "target-add", target: input.id }, nowIso);
  return { target: input.id, overrides_account: overridesAccount };
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
  if (hit === null) {
    return {
      target: id,
      verdict: "no-credential",
      detail:
        target.accountId === null
          ? "this target inherits the client's own auth, so there is nothing stored to probe."
          : `no credential is stored for account "${target.accountId}" — ` +
            `set one with: golem account login ${target.accountId}`,
    };
  }

  const result = await probeCredential({
    provider: target.provider,
    baseUrl: target.baseUrl,
    authScheme: target.authScheme,
    secret: hit.secret,
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
  account: " (from account)",
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
        "proxy.targets nor proxy.accounts. Requests naming no target fail closed rather " +
        "than silently using a different one.",
    );
  } else {
    lines.push(`default target: ${report.default_target}`);
  }
  lines.push(`trust levels: ${TARGET_TRUST_LEVELS.join(" | ")} (stored now, enforced in R9.3)`);
  return `${lines.join("\n")}\n`;
}
