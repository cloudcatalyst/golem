/**
 * Proxy daemon lifecycle — reliable start/stop/restart/status.
 *
 * The pain we're solving: a proxy started as a child of a transient shell dies
 * with that shell. So the detached start path (`golem proxy restart`, and the SessionStart
 * hook) spawns a DETACHED process
 * (survives its parent), and a PID file (`<project>/.golem/proxy.pid`) plus a
 * port check make start idempotent and stop/restart deterministic.
 *
 * The pure helpers (pid file read/write/parse, alive check, port check) are
 * unit-tested; the spawn/poll glue is exercised by a live integration smoke.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";
// `../version.js`, not `../index.js`: this module is on the per-prompt
// statusline path and the barrel re-exports every interface.
import { VERSION } from "../version.js";

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
  /**
   * The Golem version the RUNNING daemon was built from, stamped when it starts
   * listening.
   *
   * A daemon reads its config once at startup and then keeps serving whatever
   * code it was launched with, so `npm run build` does not change what a live
   * proxy does — it only changes what the NEXT one will do. Without this stamp
   * there is nothing to compare, and "the proxy is running" reads as "the proxy
   * is current" when it may be hours of rebuilds behind.
   *
   * Optional because a daemon started before this field existed has no stamp.
   * Absent is treated as stale (it is, by definition, an older build) — see
   * {@link ProxyStatus.stale}.
   */
  readonly version?: string;
  /**
   * Decision 56: this listener is the redaction-only bypass SHIM, not the full
   * pipeline. `golem proxy stop` replaces the daemon with it so the port stays
   * bound — Claude Code's `ANTHROPIC_BASE_URL` cannot be un-set without a window
   * reload (verification-notes §112b), so a released port is a dead socket the
   * user cannot escape from.
   */
  readonly shim?: boolean;
  /**
   * R10.13 — {@link buildFingerprint} of the daemon's entry script at the moment
   * it started listening. Lets a rebuild that leaves `VERSION` untouched still be
   * reported as stale. Optional: absent for a daemon started before this existed,
   * which the version check already treats as older.
   */
  readonly build?: string;
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
      // Absent in a pid file written before the stamp existed; left undefined
      // rather than defaulted, so "unknown build" stays distinguishable from
      // "some particular build".
      ...(typeof o.version === "string" ? { version: o.version } : {}),
      ...(o.shim === true ? { shim: true } : {}),
      ...(typeof o.build === "string" ? { build: o.build } : {}),
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

/**
 * R10.13 — a cheap stamp of the CODE the daemon is running, so a rebuild that
 * does not change `VERSION` is still detectable.
 *
 * `mtimeMs` + `size` of the daemon's own entry script, hashed. Deliberately not
 * a hash of all of `dist/`: `proxyStatus` is on `golem status`, the status line
 * and the VS Code poll (R10.10 measured that path carefully), and hashing every
 * file there would trade this bug for a latency regression.
 *
 * **What this does not catch:** a rebuild that changes only a leaf module and
 * leaves the entry script byte-identical with the same mtime. `tsc` rewrites
 * every emitted file on a normal build, so the common `npm run build` loop is
 * covered; a surgical single-file copy into `dist/` is not. Undefined when the
 * script cannot be stat'd, which degrades to the version-only check rather than
 * reporting a false positive.
 */
export function buildFingerprint(scriptPath: string = process.argv[1] ?? ""): string | undefined {
  if (scriptPath === "") return undefined;
  try {
    const st = statSync(scriptPath);
    return createHash("sha256")
      .update(`${Math.trunc(st.mtimeMs)}:${st.size}`, "utf8")
      .digest("hex")
      .slice(0, 16);
  } catch {
    return undefined;
  }
}

/**
 * Is the daemon described by `info` running something other than this build?
 *
 * Version first: a daemon from a different release is stale regardless of any
 * fingerprint, and a daemon with NO stamp predates the stamp, so it is older by
 * definition. The fingerprint is what closes the local dev loop, where every
 * `npm run build` leaves `VERSION` untouched — the blind spot that let a daemon
 * serve two-hour-old code while `golem status` called it current (R10.13).
 *
 * When either side has no fingerprint, fall back to the version comparison
 * rather than guessing: an unknown build is not evidence of a stale one.
 */
export function isStaleDaemon(
  info: ProxyPidInfo,
  currentVersion: string,
  currentFingerprint?: string,
): boolean {
  if (info.version !== currentVersion) return true;
  if (currentFingerprint === undefined || info.build === undefined) return false;
  return info.build !== currentFingerprint;
}

export interface ProxyStatus {
  readonly running: boolean;
  readonly pid?: number;
  readonly port?: number;
  readonly source: "pidfile" | "port" | "none";
  /**
   * The version the running daemon was built from, when it can be known.
   * Absent for a `source: "port"` hit (something is listening but wrote no pid
   * file) and for a daemon started before the stamp existed.
   */
  readonly version?: string;
  /**
   * True when the running daemon is NOT this build — either its stamp differs
   * from {@link VERSION}, or it has no stamp at all (which means it predates
   * the stamp, so it is older by definition).
   *
   * Undefined when nothing is running. A stale daemon still answers a port
   * probe and still looks healthy in every other check, which is exactly why
   * this is reported separately from {@link running}: it serves old code with
   * the config it read at startup, so a rebuild or a settings change since then
   * has had no effect on it.
   */
  readonly stale?: boolean;
  /**
   * Decision 56: what is listening is the bypass shim (pipeline off, redaction
   * still on), not the full pipeline. Distinct from {@link running}, which stays
   * true — that is what lets a surface reading only `running` degrade to the old
   * display rather than an incorrect one.
   */
  readonly shim?: boolean;
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
 * R9.20 — set by the parent when it has already resolved and injected the
 * daemon's credentials, so the child does not resolve them a second time.
 *
 * The proxy paid the credential cost TWICE per restart: the parent resolved to
 * build the child's env, and the child then resolved again on startup — even
 * though its own injection is `process.env[name] ??= secret`, so the second
 * result was discarded every time. At the measured 6668ms that was ~13.3s of an
 * ~18s restart spent finding the same secrets twice.
 *
 * A marker rather than inference: "some `GOLEM_UPSTREAM_API_KEY*` var is set"
 * cannot distinguish "the parent injected everything" from "the parent injected
 * one of three", and guessing wrong would silently start the proxy without a
 * credential it needs. The parent knows, so the parent says. An empty resolution
 * still sets it — "there was nothing to resolve" is an answer, and re-deriving it
 * costs the same as deriving it.
 *
 * Absent for a hand-run `golem proxy run`, which therefore resolves normally.
 */
export const CREDENTIALS_INJECTED_ENV = "GOLEM_CREDENTIALS_INJECTED";

/**
 * Is a Golem proxy running for this project, and is it THIS build? Prefers the
 * PID file (exact), falls back to a port probe (catches a proxy started without
 * a pid file).
 *
 * The second question is not decoration. A daemon keeps serving the code it was
 * launched with and the config it read at startup, so "running" alone answered
 * "yes" for an 18-hour-old process that was routing every request to a target
 * the current config no longer names — while every other check looked healthy.
 * {@link ProxyStatus.stale} is that gap, reported rather than inferred.
 */
export async function proxyStatus(
  projectDir: string,
  port: number,
  aliveFn: (pid: number) => boolean = isProcessAlive,
  currentVersion: string = VERSION,
  currentFingerprint: string | undefined = buildFingerprint(),
): Promise<ProxyStatus> {
  const info = await readProxyPid(projectDir);
  if (info && aliveFn(info.pid)) {
    return {
      running: true,
      pid: info.pid,
      port: info.port,
      source: "pidfile",
      ...(info.version !== undefined ? { version: info.version } : {}),
      ...(info.shim === true ? { shim: true } : {}),
      stale: isStaleDaemon(info, currentVersion, currentFingerprint),
    };
  }
  // A port hit tells us something is listening, not what it is. Unknowable
  // rather than assumed-good: reported as stale so a daemon that lost its pid
  // file cannot masquerade as current.
  if (await portInUse(port)) return { running: true, port, source: "port", stale: true };
  return { running: false, source: "none" };
}

/**
 * Stop the proxy recorded in the pid file (best-effort). Returns the pid stopped,
 * if any.
 *
 * On POSIX the daemon is spawned `detached`, which makes it a process-GROUP
 * leader, so a negative pid signals the daemon and everything it launched in one
 * call. That matters because the daemon may own child processes (R10.3's
 * Headroom sidecars among them) that a signal to the daemon alone would strand
 * if it died before passing the signal on. Falls back to signalling just the
 * daemon when there is no group to signal (a foreground-started proxy) — and on
 * Windows, which has no process groups: there, the children's own parent-death
 * watchdogs are what reap them, precisely because nothing in a
 * `TerminateProcess`-ed parent gets to run.
 */
export async function stopProxy(projectDir: string): Promise<number | null> {
  const info = await readProxyPid(projectDir);
  await removeProxyPid(projectDir);
  if (info && isProcessAlive(info.pid)) {
    let signalled = false;
    if (process.platform !== "win32") {
      try {
        process.kill(-info.pid);
        signalled = true;
      } catch {
        // not a group leader (foreground start) — fall through to the plain kill
      }
    }
    if (!signalled) {
      try {
        process.kill(info.pid);
      } catch {
        // already gone / no permission
      }
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
 * {@link buildSpawnEnv}), so a credential stored via `golem gateway login`
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
  opts: { readonly shim?: boolean; readonly waitMs?: number } = {},
): Promise<number | null> {
  const args = ["proxy", "start", "--dir", projectDir, "--port", String(port)];
  // Decision 56: the bypass shim is the same daemon with the pipeline pinned to
  // level 1, so it is a flag rather than a second entry point — one lifecycle,
  // one pid file, one port.
  if (opts.shim === true) args.push("--shim");
  // R9.8: keep the daemon's diagnostics instead of discarding them. Falls back
  // to "ignore" if the log cannot be opened — a proxy that will not start
  // because of a log file would be a worse bug than the one being fixed.
  const log = await openProxyLog(projectDir);
  const child = spawn(process.execPath, [scriptPath, ...args], {
    detached: true,
    stdio: log === null ? "ignore" : ["ignore", log.fd, log.fd],
    windowsHide: true,
    // R9.20: the marker rides with the credentials it describes, so the two can
    // never disagree — a caller cannot inject one without the other.
    env: buildSpawnEnv(process.env, { ...env, [CREDENTIALS_INJECTED_ENV]: "1" }),
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
