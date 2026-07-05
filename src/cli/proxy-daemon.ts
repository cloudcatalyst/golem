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
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";

export interface ProxyPidInfo {
  readonly pid: number;
  readonly port: number;
  readonly ts: string;
}

export function proxyPidPath(projectDir: string): string {
  return path.join(projectDir, ".golem", "proxy.pid");
}

export async function readProxyPid(projectDir: string): Promise<ProxyPidInfo | null> {
  try {
    const j: unknown = JSON.parse(await readFile(proxyPidPath(projectDir), "utf8"));
    if (typeof j !== "object" || j === null) return null;
    const o = j as Record<string, unknown>;
    if (typeof o.pid !== "number" || typeof o.port !== "number") return null;
    return { pid: o.pid, port: o.port, ts: typeof o.ts === "string" ? o.ts : "" };
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

/** Poll until the port is accepting connections, or timeout. */
export async function waitForPort(port: number, timeoutMs = 8000): Promise<boolean> {
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
    return { running: true, pid: info.pid, port: info.port, source: "pidfile" };
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
 */
export async function startDetached(
  projectDir: string,
  port: number,
  scriptPath: string,
): Promise<number | null> {
  const args = ["proxy", "start", "--dir", projectDir, "--port", String(port)];
  const child = spawn(process.execPath, [scriptPath, ...args], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  const up = await waitForPort(port);
  if (!up) return null;
  // The child writes its own pid file on listen; report that pid if present.
  const info = await readProxyPid(projectDir);
  return info?.pid ?? child.pid ?? null;
}
