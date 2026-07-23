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
}

export interface AccountsReport {
  /** The active account id, null if none, or a `{unknown}` marker string if it names a missing id. */
  readonly active: string | null;
  /** True when `active_account` is set but not present in the registry (misconfig). */
  readonly active_unknown: boolean;
  readonly accounts: readonly AccountRow[];
}

/** Read the account registry + which is active (best-effort; never reads secrets' values). */
export async function collectAccounts(
  projectDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<AccountsReport> {
  const { settings } = await loadConfig({ projectDir });
  const active = settings.proxy.active_account ?? null;
  const accounts = settings.proxy.accounts ?? [];
  const rows: AccountRow[] = accounts.map((a) => {
    const keyEnv = perAccountEnvVar(a.id);
    const v = env[keyEnv];
    return {
      id: a.id,
      provider: a.provider,
      base_url: a.base_url,
      model: a.model ?? null,
      key_env: keyEnv,
      key_set: v !== undefined && v !== "",
      active: a.id === active,
    };
  });
  const activeUnknown = active !== null && !accounts.some((a) => a.id === active);
  return { active, active_unknown: activeUnknown, accounts: rows };
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
 * Switch the active account (or clear it with `id: null`). Fail-closed: a
 * non-null id that is not in `proxy.accounts` is rejected. Records an audit line.
 */
export async function useAccount(
  projectDir: string,
  id: string | null,
  nowIso: string,
): Promise<{ readonly active: string | null }> {
  if (id !== null) {
    const { settings } = await loadConfig({ projectDir });
    const known = (settings.proxy.accounts ?? []).some((a) => a.id === id);
    if (!known) {
      const ids =
        (settings.proxy.accounts ?? []).map((a) => a.id).join(", ") || "(none configured)";
      throw new InitError(`unknown account "${id}"; configured accounts: ${ids}`);
    }
  }
  await writeSetting("project", "proxy.active_account", id ?? undefined, { projectDir });
  await appendAudit(projectDir, { action: id === null ? "clear" : "use", account: id }, nowIso);
  return { active: id };
}

/** Human-readable rendering of {@link AccountsReport}. */
export function renderAccounts(report: AccountsReport): string {
  const lines: string[] = [];
  if (report.accounts.length === 0) {
    lines.push("No accounts configured (proxy.accounts). Using the top-level upstream config.");
    lines.push("Add accounts in .golem/settings.json, then: golem account use <id>");
    return `${lines.join("\n")}\n`;
  }
  lines.push("Golem upstream accounts (secrets live in env, never shown):");
  for (const a of report.accounts) {
    const mark = a.active ? "*" : " ";
    const key = a.key_set ? "key set" : `key MISSING (${a.key_env})`;
    const model = a.model !== null ? ` model=${a.model}` : "";
    lines.push(`  ${mark} ${a.id.padEnd(12)} ${a.provider} ${a.base_url}${model} [${key}]`);
  }
  lines.push("");
  if (report.active === null) {
    lines.push("active: (none) — using the top-level upstream config.");
  } else if (report.active_unknown) {
    lines.push(
      `active: "${report.active}" — WARNING: not in proxy.accounts; the proxy falls back to the ` +
        "top-level config (no silent switch to another account).",
    );
  } else {
    lines.push(`active: ${report.active}`);
  }
  return `${lines.join("\n")}\n`;
}
