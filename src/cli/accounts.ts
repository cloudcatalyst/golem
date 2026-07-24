/**
 * R6.2 v1 — `golem account` CLI (spec Decision 21d; ADR-0003).
 *
 * Explicit switching between the user's own configured accounts/providers.
 * ADR-0003 invariants surfaced here:
 * - **No secret is ever printed or stored by these commands.** `list` reports
 *   only whether each account's credential env var is SET (a boolean), never its
 *   value; switching writes only the non-secret `proxy.active_account` selector.
 * - **Fail-closed.** `use <id>` refuses an id that is not in `proxy.accounts`
 *   (no silent creation / no switch to a non-existent account).
 * - **Audit.** Every switch is appended to `.golem/state/account-log.jsonl`.
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { loadConfig, writeSetting } from "../config/index.js";
import { perAccountEnvVar } from "../providers/index.js";
import { InitError } from "./init.js";

export interface AccountRow {
  readonly id: string;
  readonly provider: string;
  readonly base_url: string;
  readonly model: string | null;
  /** The env var carrying this account's secret (name only). */
  readonly key_env: string;
  /** Whether that env var is currently set (never the value). */
  readonly key_set: boolean;
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

/** The env var carrying the legacy/default single-account credential. */
const DEFAULT_KEY_ENV = "GOLEM_UPSTREAM_API_KEY";

/** Read the account registry + which is active (best-effort; never reads secrets' values). */
export async function collectAccounts(
  projectDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<AccountsReport> {
  const { settings } = await loadConfig({ projectDir });
  const selected = settings.proxy.active_account ?? null;
  const accounts = settings.proxy.accounts ?? [];
  const defaultId = defaultAccountId(settings.proxy.upstream_provider);

  // The default is active whenever no named account is selected, or the
  // selection names the default id itself.
  const defaultActive = selected === null || selected === defaultId;
  const defaultKey = env[DEFAULT_KEY_ENV];
  const defaultRow: AccountRow = {
    id: defaultId,
    provider: settings.proxy.upstream_provider,
    base_url: settings.proxy.upstream_base_url,
    model: settings.proxy.upstream_model ?? null,
    key_env: DEFAULT_KEY_ENV,
    key_set: defaultKey !== undefined && defaultKey !== "",
    active: defaultActive,
    is_default: true,
  };

  const namedRows: AccountRow[] = accounts.map((a) => {
    const keyEnv = perAccountEnvVar(a.id);
    const v = env[keyEnv];
    return {
      id: a.id,
      provider: a.provider,
      base_url: a.base_url,
      model: a.model ?? null,
      key_env: keyEnv,
      key_set: v !== undefined && v !== "",
      active: a.id === selected,
    };
  });

  // Unknown = a selection that is neither the default id nor a known named
  // account (a genuine misconfig — the proxy falls back to the top-level config).
  const activeUnknown =
    selected !== null && selected !== defaultId && !accounts.some((a) => a.id === selected);
  const active = defaultActive || activeUnknown ? defaultId : selected;

  return { active, active_unknown: activeUnknown, accounts: [defaultRow, ...namedRows] };
}

/** Append a switch event to the audit log (ADR-0003). Fire-and-forget safe. */
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
 */
export async function useAccount(
  projectDir: string,
  id: string | null,
  nowIso: string,
): Promise<{ readonly active: string | null }> {
  // Resolve the target: null / the default id both mean "clear active_account
  // and revert to the top-level config". Any other id must be a known account.
  let target = id;
  if (id !== null) {
    const { settings } = await loadConfig({ projectDir });
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
  await writeSetting("project", "proxy.active_account", target ?? undefined, { projectDir });
  await appendAudit(
    projectDir,
    { action: target === null ? "clear" : "use", account: target },
    nowIso,
  );
  return { active: target };
}

/** Human-readable rendering of {@link AccountsReport}. */
export function renderAccounts(report: AccountsReport): string {
  const lines: string[] = [];
  lines.push("Golem upstream accounts (secrets live in env, never shown):");
  for (const a of report.accounts) {
    const mark = a.active ? "*" : " ";
    const key = a.key_set ? "key set" : `key MISSING (${a.key_env})`;
    const model = a.model !== null ? ` model=${a.model}` : "";
    const tag = a.is_default === true ? " (default)" : "";
    lines.push(`  ${mark} ${a.id.padEnd(12)} ${a.provider} ${a.base_url}${model} [${key}]${tag}`);
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
