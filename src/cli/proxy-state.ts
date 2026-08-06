/**
 * Per-project proxy DESIRED state — the persisted intent "this project wants its
 * proxy running." Distinct from the pid file (which is "running right now"):
 * `golem proxy start`/`stop` record the intent here, and the SessionStart hook
 * reads it on project open to auto-start the proxy if it was previously running.
 * Lives under `<project>/.golem/state/proxy.json`. Best-effort; never throws.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Decision 56: `"stopped"` no longer means "no listener". Stopping the pipeline
 * leaves a redaction-only **shim** bound to the project port, so Claude Code —
 * whose `ANTHROPIC_BASE_URL` cannot be un-set without a window reload
 * (verification-notes §112b) — never dials a dead socket.
 *
 * - `running` — the full pipeline.
 * - `bypass`  — pipeline off, shim serving (what `golem proxy stop` now records).
 * - `stopped` — nothing listening. Reachable only via `golem proxy stop --hard`,
 *   and the one state in which a wired Claude Code will fail to connect.
 */
export type ProxyDesired = "running" | "bypass" | "stopped";

export function proxyStatePath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "proxy.json");
}

/** Read the persisted desired state, or null if never set / unreadable. */
export async function readProxyDesired(projectDir: string): Promise<ProxyDesired | null> {
  try {
    const j: unknown = JSON.parse(await readFile(proxyStatePath(projectDir), "utf8"));
    if (typeof j === "object" && j !== null) {
      const d = (j as Record<string, unknown>).desired;
      if (d === "running" || d === "bypass" || d === "stopped") return d;
    }
    return null;
  } catch {
    return null;
  }
}

/** Persist the desired state (called by proxy start/stop). Best-effort. */
export async function writeProxyDesired(
  projectDir: string,
  desired: ProxyDesired,
  nowIso: string,
): Promise<void> {
  try {
    const file = proxyStatePath(projectDir);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ desired, ts: nowIso }, null, 2)}\n`, "utf8");
  } catch {
    // a persisted preference is not worth failing a command over
  }
}
