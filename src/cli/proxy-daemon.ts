/**
 * Proxy daemon lifecycle — reliable start/stop/restart/status.
 *
 * The pain we're solving: a proxy started as a child of a transient shell dies
 * with that shell. So `golem proxy start --detach` spawns a DETACHED process
 * (survives its parent), and a PID file (`<project>/.golem/proxy.pid`) plus a
 * port check make start idempotent and stop/restart deterministic.
 *
 * The pure helpers (pid file read/write/parse, alive check, port check) are
 * unit-tested; the spawn/poll glue is exercised by a live integration smoke.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";

/** Base of the per-project proxy port range, and its span. */
export const PROXY_PORT_BASE = 4653;
export const PROXY_PORT_SPAN = 1000;

/**
 * A stable, per-project proxy port derived from the project path — so multiple
 * projects each get their own proxy without colliding on one shared port
 * (per-project-proxy model). Deterministic (same project → same port across
 * restarts); range PROXY_PORT_BASE..+SPAN. A user can always override via
 * `proxy.port` in the project's settings. Collisions across projects are highly
 * unlikely at 1000 ports and surface as a clear bind error rather than silent
 * cross-talk (the pid file, not the port, is the source of truth for "ours").
 */
export function defaultProjectPort(projectDir: string): number {
  const n = createHash("sha256").update(projectDir, "utf8").digest().readUInt32BE(0);
  return PROXY_PORT_BASE + (n % PROXY_PORT_SPAN);
}

export interface ProxyPidInfo {
  readonly pid: number;
  readonly port: number;
  readonly ts: string;
}

export function proxyPidPath(projectDir: string): string {
  return path.join(projectDir, ".golem", "proxy.pid");
}

/**
 * Where a detached daemon's stdout/stderr go (R9.8).
 *
 * The daemon used to spawn with `stdio: "ignore"`, which meant every diagnostic
 * the proxy prints was discarded in the mode people actually run it in: a
 * misconfigured target, a missing upstream credential, and — the case that
 * found this — `compression.headroom_config` keys the installed Headroom does
 * not accept. Those warnings exist precisely so a setting that does nothing
 * does not also say nothing, and none of them reached anybody.
 */
export function proxyLogPath(projectDir: string): string {
  return path.join(projectDir, ".golem", "proxy.log");
}

/** Bytes of {@link proxyLogPath} kept on each daemon start (tail-truncated). */
export const PROXY_LOG_MAX_BYTES = 1_000_000;

export async function readProxyPid(projectDir: string): Promise<ProxyPidInfo | null> {
  try {
    const j: unknown = JSON.parse(await readFile(proxyPidPath(projectDir), "utf8"));
    if (typeof j !== "object" || j === null) return null;
    const o = j as Record<string, unknown>;
    if (typeof o.pid !== "number" || typeof o.port !== "number") return null;
    return {
      pid: o.pid,
      port: o.port,
      ts: typeof o.ts === "string" ? o.ts : "",
    };
  } catch {
    return null;
  }
}

export async function writeProxyPid(projectDir: string, info: ProxyPidInfo): Promise<void> {
  const file = proxyPidPath(projectDir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(info)}\n`, "utf8");
}

export async function removeProxyPid(projectDir: string): Promise<void> {
  await rm(proxyPidPath(projectDir), { force: true });
}

/** Is a process alive? `kill(pid, 0)` throws ESRCH when dead, EPERM when alive-but-foreign. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Resolve true if something is accepting TCP connections on the loopback port. */
export function portInUse(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host: "127.0.0.1" });
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until the port is accepting connections, or timeout.
 *
 * R9.18: the budget was 8s, and daemon start-up on a project with several
 * configured accounts measured ~6.7s of credential resolution alone — close
 * enough that normal jitter reported "proxy did not come up" for a proxy that
 * came up a moment later. The resolution itself is now concurrent, but the
 * budget stays generous: being slow to declare failure costs a few seconds on a
 * genuinely broken start, while being quick to declare it lies about a working
 * one, and the lie sends people debugging a healthy daemon.
 */
export async function waitForPort(port: number, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portInUse(port)) return true;
    await sleep(150);
  }
  return false;
}

/** Poll until the port is free, or timeout. */
export async function waitForPortFree(port: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portInUse(port))) return true;
    await sleep(150);
  }
  return false;
}

export interface ProxyStatus {
  readonly running: boolean;
  readonly pid?: number;
  readonly port?: number;
  readonly source: "pidfile" | "port" | "none";
}

/**
 * The subset of the spawning process's environment that is always forwarded to
 * the daemon. Golem's settings resolution is env-driven (`GOLEM_<SECTION>_<KEY>`
 * beats the config file), so a daemon that inherits the *whole* shell env can
 * silently pick up a stray `GOLEM_*` var the user exported once in one terminal
 * and forgot — precisely the "works in one terminal, not another" trap. The
 * daemon instead starts from a minimal, predictable base (PATH + a home dir) and
 * receives everything else explicitly.
 */
const ENV_ALLOWLIST = ["PATH", "Path", "HOME", "USERPROFILE", "SYSTEMROOT", "SystemRoot"];

/**
 * Build the daemon's environment: the minimal allowlist above plus any
 * explicitly-injected `extra` vars (the resolved upstream credential chief among
 * them, by {@link startDetached}). Nothing else from the spawning shell leaks
 * through.
 */
export function buildSpawnEnv(
  base: Readonly<Record<string, string | undefined>> = process.env,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = base[key];
    if (value !== undefined && out[key] === undefined) out[key] = value;
  }
  return { ...out, ...extra };
}

/**
 * Is a Golem proxy running for this project? Prefers the PID file (exact),
 * falls back to a port probe (catches a proxy started without a pid file).
 */
export async function proxyStatus(
  projectDir: string,
  port: number,
  aliveFn: (pid: number) => boolean = isProcessAlive,
): Promise<ProxyStatus> {
  const info = await readProxyPid(projectDir);
  if (info && aliveFn(info.pid)) {
    return {
      running: true,
      pid: info.pid,
      port: info.port,
      source: "pidfile",
    };
  }
  if (await portInUse(port)) return { running: true, port, source: "port" };
  return { running: false, source: "none" };
}

/** Stop the proxy recorded in the pid file (best-effort). Returns the pid stopped, if any. */
export async function stopProxy(projectDir: string): Promise<number | null> {
  const info = await readProxyPid(projectDir);
  await removeProxyPid(projectDir);
  if (info && isProcessAlive(info.pid)) {
    try {
      process.kill(info.pid);
    } catch {
      // already gone / no permission
    }
    return info.pid;
  }
  return null;
}

/**
 * Spawn a DETACHED `golem proxy start` (foreground in the child) that outlives
 * this process, then wait until it is listening. Returns the child pid, or null
 * if it never came up.
 *
 * `env` is explicit extra environment for the daemon — the resolved upstream
 * credential, injected by the caller under its `GOLEM_UPSTREAM_API_KEY[_…]` var.
 * The daemon does NOT inherit the whole spawning shell's env (see
 * {@link buildSpawnEnv}), so a credential stored via `golem account login`
 * reaches the daemon deterministically and a stray `GOLEM_*` var in one
 * terminal can no longer silently un-configure a working daemon.
 */
/**
 * Open (creating, appending to) the daemon log and return its fd, or null when
 * it cannot be opened. Truncates from the front when the file has grown past
 * {@link PROXY_LOG_MAX_BYTES} so an always-on daemon cannot fill a disk.
 */
async function openProxyLog(projectDir: string): Promise<FileHandle | null> {
  const file = proxyLogPath(projectDir);
  try {
    await mkdir(path.dirname(file), { recursive: true });
    try {
      const info = await stat(file);
      if (info.size > PROXY_LOG_MAX_BYTES) {
        const kept = (await readFile(file, "utf8")).slice(-Math.floor(PROXY_LOG_MAX_BYTES / 2));
        await writeFile(file, kept, "utf8");
      }
    } catch {
      // No existing log (or unreadable) — `open` below creates it.
    }
    return await open(file, "a");
  } catch {
    return null;
  }
}

export async function startDetached(
  projectDir: string,
  port: number,
  scriptPath: string,
  env: Readonly<Record<string, string>> = {},
  opts: { readonly waitMs?: number } = {},
): Promise<number | null> {
  const args = ["proxy", "start", "--dir", projectDir, "--port", String(port)];
  // R9.8: keep the daemon's diagnostics instead of discarding them. Falls back
  // to "ignore" if the log cannot be opened — a proxy that will not start
  // because of a log file would be a worse bug than the one being fixed.
  const log = await openProxyLog(projectDir);
  const child = spawn(process.execPath, [scriptPath, ...args], {
    detached: true,
    stdio: log === null ? "ignore" : ["ignore", log.fd, log.fd],
    windowsHide: true,
    env: buildSpawnEnv(process.env, env),
  });
  // The child holds its own duplicate of the descriptor; ours is done.
  if (log !== null) await log.close().catch(() => {});
  child.unref();
  const up = await waitForPort(port, opts.waitMs);
  if (!up) return null;
  // The child writes its own pid file on listen; report that pid if present.
  const info = await readProxyPid(projectDir);
  return info?.pid ?? child.pid ?? null;
}
