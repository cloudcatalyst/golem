/**
 * Credential backends (ADR-0003 amendment; spec Decision 46; Decision 47).
 *
 * One API key per account id, stored in the best mechanism the platform
 * actually offers. Two backends, in resolution order:
 *
 * - `keychain` — the OS-backed store, shelling out to a tool that ships with
 *              the platform (no native dependency, per CLAUDE.md):
 *              macOS `security`, Linux `secret-tool`, Windows DPAPI via
 *              `powershell.exe`.
 * - `file`   — plaintext, mode 0600. **Never selected automatically** (see
 *              store.ts); an explicit opt-out for headless boxes with no
 *              secret service, and labelled honestly as unencrypted.
 *
 * **There is no `env` backend (Decision 47).** An environment variable is no
 * longer a way to *set* a credential: `GOLEM_UPSTREAM_API_KEY[__<ID>]` was
 * removed as a user-facing mechanism because it produced exactly the
 * "works in one terminal, not another" failure Decision 46 set out to end.
 * The name survives only as the internal CLI→daemon handoff channel — see
 * {@link envVarForGateway} — and is not documented to users as configuration.
 *
 * Two invariants hold throughout:
 *
 * 1. **A secret never appears in argv.** Process arguments are readable by
 *    other processes; every write pipes the secret through **stdin** instead.
 * 2. **A secret is never logged or thrown.** Error messages carry the backend
 *    and the tool's own stderr, never the value or the caller's stdin.
 *
 * Windows note: there is no *readable* Windows Credential Manager without a
 * native module (`cmdkey /list` returns target + user, never the password;
 * WinRT `PasswordVault` will not load in PowerShell 7). So Windows uses DPAPI,
 * which is an encrypted *file* bound to the current user + machine — and
 * {@link CredentialLocation.label} says exactly that rather than claiming
 * "Credential Manager". Even DPAPI is only reachable by shelling out to a
 * PowerShell host, and **which host works is machine-dependent**: on some
 * machines the inbox `powershell.exe` (5.1) cannot autoload its Security module
 * when spawned from Node, while `pwsh` (PS7, an optional install) can
 * (verification-notes §82). The backend therefore DETECTS a working host rather
 * than assuming `powershell.exe` is safe, and degrades honestly when none is.
 */

import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { perGatewayEnvVar } from "../providers/index.js";

/** Which mechanism a credential lives in. */
export type CredentialBackendId = "keychain" | "file";

/**
 * How well a stored credential is actually protected. Deliberately granular so
 * display surfaces can be honest: `os-keychain` (a real secret service) is not
 * the same claim as `dpapi-user` (user+machine-bound encrypted file), which is
 * not the same claim as `file-permissions` (plaintext, perms only).
 */
export type CredentialProtection = "os-keychain" | "dpapi-user" | "file-permissions";

/** Where a credential lives, and an honest description of its protection. */
export interface CredentialLocation {
  readonly backend: CredentialBackendId;
  /** Human-readable, never overstated — shown by `golem gateway list`. */
  readonly label: string;
  readonly protection: CredentialProtection;
}

/**
 * A credential store. `get` resolves `null` for "simply absent" and throws only
 * on a genuine backend failure (tool broken, keychain access denied), so a
 * missing key and a broken store are never confused.
 */
export interface CredentialBackend {
  readonly id: CredentialBackendId;
  /** Can this backend be used on this machine at all? Never throws. */
  available(): Promise<boolean>;
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  remove(account: string): Promise<void>;
  describe(): CredentialLocation;
  /**
   * R9.20 — read several accounts in ONE backend round trip.
   *
   * Optional: a backend with a cheap per-account helper (`security`,
   * `secret-tool`) gains nothing and omits it, and the store then loops `get`.
   * It exists for Windows DPAPI, where each read is a PowerShell **process
   * start**: measured at ~0.94s per stored account plus a one-time ~2.6s host
   * self-test, i.e. **6668ms — 98% of everything the proxy daemon did before
   * `listen()`** on a project with two keyed gateways.
   *
   * Resolves per-account outcomes rather than throwing, so one unreadable blob
   * cannot deny the proxy the credentials that ARE readable. See
   * {@link BatchedRead}.
   */
  getMany?(accounts: readonly string[]): Promise<Map<string, BatchedRead>>;
}

/**
 * One account's outcome in a {@link CredentialBackend.getMany} batch.
 *
 * Three states, and the distinction matters: an ABSENT credential is normal (the
 * gateway simply has no key stored and the proxy starts without it), while a
 * FAULT is a real backend failure that display surfaces must report rather than
 * render as "not set". An empty object is "absent" — the same meaning `get`'s
 * `null` carries.
 */
export interface BatchedRead {
  readonly secret?: string;
  readonly fault?: Error;
}

/**
 * The reserved account id for the top-level upstream config — the one
 * `proxy.upstream_*` describes when no named account is active. Its stored
 * credential and internal handoff var are the plain, un-suffixed ones.
 */
export const DEFAULT_GATEWAY_ID = "default";

/** The internal handoff var for the top-level account's credential. */
export const DEFAULT_KEY_ENV = "GOLEM_UPSTREAM_API_KEY";

/**
 * The environment variable the CLI injects account `id`'s secret into when it
 * spawns the proxy — an INTERNAL transport, not a user-facing setting
 * (Decision 47). There is no `env` credential backend any more, so exporting
 * this by hand configures nothing: a credential is set with
 * `golem gateway login <id>` and read back out of the OS store.
 *
 * It still exists because the proxy daemon is detached and may have no desktop
 * session, which is where every OS keychain is least reliable (ADR-0003) — so
 * the CLI resolves the secret and hands it to the child process here rather
 * than making the daemon reach for the keychain itself.
 *
 * {@link DEFAULT_GATEWAY_ID} maps to plain `GOLEM_UPSTREAM_API_KEY`; every
 * other id delegates to {@link perGatewayEnvVar} so there is exactly ONE
 * definition of the `GOLEM_UPSTREAM_API_KEY__<ID>` spelling in the codebase
 * (a divergence here would break the handoff silently).
 */
export function envVarForGateway(id: string): string {
  return id === DEFAULT_GATEWAY_ID ? DEFAULT_KEY_ENV : perGatewayEnvVar(id);
}

/** Filesystem-safe form of an account id, for the on-disk backends. */
function safeFileName(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9._-]/g, "_");
}

/** `<userDir>/credentials` — the directory the on-disk backends write into. */
export function credentialsDir(userDir: string): string {
  return path.join(userDir, "credentials");
}

interface RunResult {
  /** Exit code, or null when the process could not be spawned at all. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the binary is missing / could not be executed (ENOENT etc.). */
  readonly spawnFailed: boolean;
}

/**
 * Spawn `cmd` with an ARGUMENT ARRAY (never a shell string — CLAUDE.md
 * cross-platform rule) and optionally feed `stdin`. Resolves for every outcome
 * including a nonzero exit and a failed spawn, so callers branch on data rather
 * than exceptions. `stdin` is never echoed into the result.
 */
async function run(cmd: string, args: readonly string[], stdin?: string): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const child = spawn(cmd, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (err: Error) => {
      resolve({ code: null, stdout: "", stderr: err.message, spawnFailed: true });
    });
    child.once("close", (code) => {
      resolve({ code, stdout, stderr, spawnFailed: false });
    });
    // Always close stdin: a helper that reads to EOF would otherwise hang.
    child.stdin?.end(stdin ?? "", "utf8");
  });
}

/** Trim the one trailing newline a CLI helper adds, without touching the secret. */
function trimOutput(s: string): string {
  return s.replace(/\r?\n$/, "").trim();
}

// ---------------------------------------------------------------------------
// keychain — OS-backed, one implementation per platform, no native deps
// ---------------------------------------------------------------------------

/** macOS keychain service name for account `id`. */
function macService(id: string): string {
  return `golem:${id}`;
}

function macKeychain(): CredentialBackend {
  const ACCOUNT = "golem";
  return {
    id: "keychain",
    available: async () => {
      // A harmless read: succeeds on any Mac with a keychain configured.
      const r = await run("security", ["list-keychains"]);
      return !r.spawnFailed && r.code === 0;
    },
    get: async (account) => {
      const r = await run("security", [
        "find-generic-password",
        "-s",
        macService(account),
        "-a",
        ACCOUNT,
        "-w",
      ]);
      if (r.spawnFailed) throw new Error(`macOS keychain unavailable: ${r.stderr}`);
      if (r.code === 0) {
        const v = trimOutput(r.stdout);
        return v === "" ? null : v;
      }
      // 44 = "The specified item could not be found in the keychain."
      if (r.code === 44 || /could not be found/i.test(r.stderr)) return null;
      // Anything else is a real failure (e.g. the user denied the ACL prompt).
      throw new Error(`macOS keychain read failed (exit ${r.code}): ${trimOutput(r.stderr)}`);
    },
    set: async (account, secret) => {
      // `-w` with no value reads the password from stdin, so it stays out of argv.
      // `-U` updates an existing item instead of erroring.
      const r = await run(
        "security",
        ["add-generic-password", "-s", macService(account), "-a", ACCOUNT, "-U", "-w"],
        secret,
      );
      if (r.spawnFailed || r.code !== 0) {
        throw new Error(`macOS keychain write failed (exit ${r.code}): ${trimOutput(r.stderr)}`);
      }
    },
    remove: async (account) => {
      const r = await run("security", [
        "delete-generic-password",
        "-s",
        macService(account),
        "-a",
        ACCOUNT,
      ]);
      // Absent is success for a delete.
      if (r.spawnFailed) throw new Error(`macOS keychain unavailable: ${r.stderr}`);
      if (r.code !== 0 && r.code !== 44 && !/could not be found/i.test(r.stderr)) {
        throw new Error(`macOS keychain delete failed (exit ${r.code}): ${trimOutput(r.stderr)}`);
      }
    },
    describe: () => ({
      backend: "keychain",
      label: "macOS Keychain (login keychain, via security(1))",
      protection: "os-keychain",
    }),
  };
}

function linuxKeychain(): CredentialBackend {
  const attrs = (account: string): readonly string[] => ["service", "golem", "account", account];
  return {
    id: "keychain",
    available: async () => {
      const r = await run("secret-tool", ["--help"]);
      return !r.spawnFailed && r.code === 0;
    },
    get: async (account) => {
      const r = await run("secret-tool", ["lookup", ...attrs(account)]);
      if (r.spawnFailed) {
        throw new Error("secret-tool not available (install libsecret-tools)");
      }
      if (r.code === 0) {
        // secret-tool prints the secret with NO trailing newline.
        const v = r.stdout.trim();
        return v === "" ? null : v;
      }
      // Not found: exit 1 with nothing on stderr. A real failure (no D-Bus
      // session, locked keyring) prints a diagnostic.
      if (trimOutput(r.stderr) === "") return null;
      throw new Error(`libsecret read failed (exit ${r.code}): ${trimOutput(r.stderr)}`);
    },
    set: async (account, secret) => {
      const r = await run(
        "secret-tool",
        ["store", "--label=Golem upstream credential", ...attrs(account)],
        secret,
      );
      if (r.spawnFailed || r.code !== 0) {
        throw new Error(`libsecret write failed (exit ${r.code}): ${trimOutput(r.stderr)}`);
      }
    },
    remove: async (account) => {
      const r = await run("secret-tool", ["clear", ...attrs(account)]);
      if (r.spawnFailed) throw new Error("secret-tool not available");
      if (r.code !== 0 && trimOutput(r.stderr) !== "") {
        throw new Error(`libsecret delete failed (exit ${r.code}): ${trimOutput(r.stderr)}`);
      }
    },
    describe: () => ({
      backend: "keychain",
      label: "Linux keyring (libsecret / Secret Service, via secret-tool)",
      protection: "os-keychain",
    }),
  };
}

/**
 * DPAPI encrypt/decrypt one-liners. `$ErrorActionPreference='Stop'` plus an
 * explicit try/catch is required: PowerShell's non-terminating errors leave the
 * exit code at 0, so without this a failed decrypt would look like success with
 * empty output. Exit 2 distinguishes "nothing on stdin" from a real error.
 */
const DPAPI_ENCRYPT =
  "$ErrorActionPreference='Stop'; try { " +
  "$s=[Console]::In.ReadToEnd().Trim(); if ($s.Length -eq 0) { exit 2 }; " +
  "ConvertTo-SecureString $s -AsPlainText -Force | ConvertFrom-SecureString; exit 0 " +
  "} catch { exit 1 }";

const DPAPI_DECRYPT =
  "$ErrorActionPreference='Stop'; try { " +
  "$b=[Console]::In.ReadToEnd().Trim(); if ($b.Length -eq 0) { exit 2 }; " +
  "$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR((ConvertTo-SecureString $b)); " +
  "[Runtime.InteropServices.Marshal]::PtrToStringAuto($p); exit 0 " +
  "} catch { exit 1 }";

/**
 * R9.20 — decrypt EVERY blob in one PowerShell invocation.
 *
 * Protocol: one base64 DPAPI blob per stdin line, one result per stdout line, in
 * the same order. `=<base64 of the UTF-8 secret>` on success, `!` on failure.
 *
 * Three properties this shape is chosen for:
 *
 * - **Secrets stay off the command line**, exactly as the single-blob path
 *   requires — everything crosses on stdin/stdout, nothing in argv.
 * - **Base64 out** guarantees one line per result whatever the secret contains,
 *   so a key with an unexpected byte cannot desynchronise the mapping back onto
 *   accounts. It also keeps the plaintext out of any accidental capture of this
 *   process's stdout.
 * - **The exit code reports the HOST, not the blobs.** 0 when at least one blob
 *   decrypted, 3 when there were blobs and none did, 2 for empty input. That is
 *   the distinction {@link tryDpapiHosts} needs: a PowerShell whose Security
 *   module fails to autoload throws on every line, and if that exited 0 the
 *   caller would believe the host worked and report every credential missing.
 */
const DPAPI_DECRYPT_BATCH =
  "$ErrorActionPreference='Stop'; " +
  "$lines=@(); while ($null -ne ($l=[Console]::In.ReadLine())) { $lines+=$l }; " +
  "if ($lines.Count -eq 0) { exit 2 }; " +
  "$ok=0; " +
  "foreach ($b in $lines) { " +
  "$t=$b.Trim(); if ($t.Length -eq 0) { Write-Output '!'; continue }; " +
  "try { " +
  "$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR((ConvertTo-SecureString $t)); " +
  "$s=[Runtime.InteropServices.Marshal]::PtrToStringAuto($p); " +
  "[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p); " +
  "Write-Output ('=' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s))); " +
  "$ok++ " +
  "} catch { Write-Output '!' } }; " +
  "if ($ok -eq 0) { exit 3 }; exit 0";

function powershellArgs(command: string): readonly string[] {
  return ["-NoProfile", "-NonInteractive", "-Command", command];
}

/**
 * PowerShell hosts that can run DPAPI, in preference order. `pwsh` (PS7) is
 * first because it is the one verified to load `ConvertTo-SecureString` reliably
 * under a Node spawn; the inbox Windows PowerShell 5.1 is kept as a fallback
 * because on some machines it works and on others its Security module fails to
 * autoload (§82).
 */
const DPAPI_HOSTS = ["pwsh.exe", "powershell.exe"] as const;

/**
 * Windows DPAPI backend: an encrypted *file* per account under
 * `<userDir>/credentials/`, bound to the current user + machine. The mechanism
 * is only as available as a working PowerShell host, so {@link CredentialBackend.available}
 * performs a real encrypt→decrypt self-test rather than assuming `powershell.exe`
 * is safe to call — and `set`/`get` throw a *remediable* error (pointing at the
 * fix) when no host works, instead of silently storing nothing or failing with a
 * raw PowerShell diagnostic.
 */
function windowsDpapi(userDir: string): CredentialBackend {
  const blobPath = (account: string): string =>
    path.join(credentialsDir(userDir), `${safeFileName(account)}.dpapi`);

  /** Cached resolution of the first host that round-trips DPAPI. */
  let hostPromise: Promise<string | null> | null = null;
  const findHost = (): Promise<string | null> => {
    hostPromise ??= (async () => {
      for (const bin of DPAPI_HOSTS) {
        const enc = await run(bin, powershellArgs(DPAPI_ENCRYPT), "golem-dpapi-selftest");
        if (enc.spawnFailed || enc.code !== 0 || trimOutput(enc.stdout) === "") continue;
        const dec = await run(bin, powershellArgs(DPAPI_DECRYPT), trimOutput(enc.stdout));
        if (dec.code === 0 && trimOutput(dec.stdout) === "golem-dpapi-selftest") return bin;
      }
      return null;
    })();
    return hostPromise;
  };

  /**
   * The host that has already done real work in this process, so the second
   * operation does not re-discover it.
   */
  let provenHost: string | null = null;

  /**
   * R9.20 — run `script` on the first host that SUCCEEDS AT THE REAL WORK, rather
   * than on the first host a self-test blessed.
   *
   * This is what removes the ~2.6s self-test from every read, and it does so
   * without introducing a cached positive that can go stale — the measurement the
   * task warned about. A successful decrypt of an actual blob is strictly stronger
   * evidence than an encrypt→decrypt of a fixed string, and it is evidence we were
   * about to gather anyway. The self-test therefore stops being a precondition of
   * reading and becomes what it should always have been: the answer to
   * {@link CredentialBackend.available}, and the diagnostic that distinguishes
   * "no working PowerShell" from "this blob belongs to another user or machine"
   * once the real attempt has already failed.
   *
   * Resolves the first exit-0 result; failing that, the last result from a host
   * that at least RAN (so the caller can report its exit code); `null` only when
   * no host could be spawned at all.
   */
  async function tryDpapiHosts(
    script: string,
    stdin: string,
  ): Promise<{ readonly host: string; readonly result: RunResult } | null> {
    const order =
      provenHost === null
        ? DPAPI_HOSTS
        : [provenHost, ...DPAPI_HOSTS.filter((h) => h !== provenHost)];
    let ranButFailed: { host: string; result: RunResult } | null = null;
    for (const bin of order) {
      const result = await run(bin, powershellArgs(script), stdin);
      if (result.spawnFailed) continue; // host not installed — try the next
      if (result.code === 0) {
        provenHost = bin;
        return { host: bin, result };
      }
      ranButFailed ??= { host: bin, result };
    }
    return ranButFailed;
  }

  const NO_HOST =
    "DPAPI needs a working PowerShell host, and none was found: the inbox " +
    "`powershell.exe` could not load its security module here and `pwsh` (PowerShell 7) " +
    "is not installed. Fixes, best first: (1) install PowerShell 7 " +
    "(`winget install Microsoft.PowerShell`); (2) opt into UNENCRYPTED file storage with " +
    "`golem gateway login <id> --store file`.";

  /** Read one account's blob, or null when there is nothing stored. */
  async function readBlob(account: string): Promise<string | null> {
    let blob: string;
    try {
      blob = await readFile(blobPath(account), "utf8");
    } catch {
      return null; // no stored credential
    }
    return blob.trim() === "" ? null : blob.trim();
  }

  /**
   * The error for a decrypt that a WORKING host refused — i.e. the blob itself is
   * unreadable here. Only reached once the self-test has confirmed a host exists,
   * so it can say plainly which of the two problems this is.
   */
  function blobBoundElsewhere(account: string, code: number | null): Error {
    return new Error(
      `DPAPI decrypt failed (exit ${code}) — the stored blob is bound to the user and machine ` +
        `that created it, so a copied or roamed ${path.basename(blobPath(account))} cannot be ` +
        `read here. Re-run: golem gateway login ${account}`,
    );
  }

  return {
    id: "keychain",
    available: async () => (await findHost()) !== null,
    get: async (account) => {
      const blob = await readBlob(account);
      if (blob === null) return null;
      const attempt = await tryDpapiHosts(DPAPI_DECRYPT, blob);
      if (attempt !== null && attempt.result.code === 0) {
        const v = trimOutput(attempt.result.stdout);
        return v === "" ? null : v;
      }
      // The real attempt failed. NOW pay for the self-test, purely to say which of
      // the two failures this is — a diagnostic, not a precondition (R9.20).
      if ((await findHost()) === null) throw new Error(NO_HOST);
      throw blobBoundElsewhere(account, attempt?.result.code ?? null);
    },
    getMany: async (accounts) => {
      const out = new Map<string, BatchedRead>();
      // Read the blobs first: an account with nothing stored costs a failed file
      // open (~1ms) and must never reach PowerShell at all.
      const pending: { account: string; blob: string }[] = [];
      for (const account of accounts) {
        const blob = await readBlob(account);
        if (blob === null) out.set(account, {});
        else pending.push({ account, blob });
      }
      if (pending.length === 0) return out;

      // ONE process for every stored credential — the whole point of R9.20.
      const attempt = await tryDpapiHosts(
        DPAPI_DECRYPT_BATCH,
        `${pending.map((p) => p.blob).join("\n")}\n`,
      );
      if (attempt === null || attempt.result.code !== 0) {
        // Same diagnostic split as `get`, applied once for the whole batch.
        const fault =
          (await findHost()) === null
            ? new Error(NO_HOST)
            : blobBoundElsewhere(pending[0]?.account ?? "", attempt?.result.code ?? null);
        for (const p of pending) out.set(p.account, { fault });
        return out;
      }

      // Results are positional, so a length mismatch means the protocol broke and
      // the mapping cannot be trusted. Fault every account rather than risk
      // handing one gateway another gateway's key.
      const lines = attempt.result.stdout.split(/\r?\n/).filter((l) => l !== "");
      if (lines.length !== pending.length) {
        const fault = new Error(
          `DPAPI batch decrypt returned ${lines.length} results for ${pending.length} blobs; ` +
            "refusing to map them. Re-run `golem gateway login <id>` for the affected gateways.",
        );
        for (const p of pending) out.set(p.account, { fault });
        return out;
      }
      for (const [i, p] of pending.entries()) {
        const line = (lines[i] ?? "").trim();
        if (!line.startsWith("=")) {
          // One blob among several failed: a fault for THAT account only, so the
          // proxy still starts with the credentials that did resolve.
          out.set(p.account, { fault: blobBoundElsewhere(p.account, attempt.result.code) });
          continue;
        }
        const secret = Buffer.from(line.slice(1), "base64").toString("utf8").trim();
        out.set(p.account, secret === "" ? {} : { secret });
      }
      return out;
    },
    set: async (account, secret) => {
      const attempt = await tryDpapiHosts(DPAPI_ENCRYPT, secret);
      if (attempt === null) throw new Error(NO_HOST);
      if (attempt.result.code !== 0) {
        if ((await findHost()) === null) throw new Error(NO_HOST);
        throw new Error(`DPAPI encrypt failed (exit ${attempt.result.code})`);
      }
      const r = attempt.result;
      const blob = trimOutput(r.stdout);
      if (blob === "") throw new Error("DPAPI encrypt produced no output");
      const file = blobPath(account);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${blob}\n`, { encoding: "utf8", mode: 0o600 });
    },
    remove: async (account) => {
      await rm(blobPath(account), { force: true });
    },
    describe: () => ({
      backend: "keychain",
      // Deliberately NOT called "Windows Credential Manager": it is not that.
      label: "DPAPI-encrypted file (decryptable only by this user on this machine)",
      protection: "dpapi-user",
    }),
  };
}

/**
 * The OS-backed backend for `platform`, or `null` on a platform with no
 * supported mechanism (callers then ask the user to opt into
 * {@link fileBackend} explicitly — there is no env fallback, Decision 47).
 */
export function keychainBackend(
  platform: NodeJS.Platform,
  userDir: string,
): CredentialBackend | null {
  switch (platform) {
    case "darwin":
      return macKeychain();
    case "linux":
      return linuxKeychain();
    case "win32":
      return windowsDpapi(userDir);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// file — plaintext, explicit opt-in only
// ---------------------------------------------------------------------------

/**
 * Plaintext credential file, mode 0600. ADR-0003 rejected plaintext-on-disk as
 * a *default* ("a worse posture than env") and that still holds — the store
 * never selects this automatically. It exists so a headless Linux box with no
 * Secret Service has a documented, honestly-labelled option instead of a dead
 * end.
 */
export function fileBackend(
  userDir: string,
  platform: NodeJS.Platform = process.platform,
): CredentialBackend {
  const keyPath = (account: string): string =>
    path.join(credentialsDir(userDir), `${safeFileName(account)}.key`);

  return {
    id: "file",
    available: async () => true,
    get: async (account) => {
      try {
        const v = (await readFile(keyPath(account), "utf8")).trim();
        return v === "" ? null : v;
      } catch {
        return null;
      }
    },
    set: async (account, secret) => {
      const file = keyPath(account);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
      // `mode` on writeFile only applies when the file is CREATED, so re-assert
      // it for an overwrite. A no-op on Windows (POSIX bits are not enforced) —
      // which is why describe() calls the guarantee best-effort there.
      await chmod(file, 0o600).catch(() => {});
    },
    remove: async (account) => {
      await rm(keyPath(account), { force: true });
    },
    describe: () => ({
      backend: "file",
      label:
        platform === "win32"
          ? "UNENCRYPTED file, permissions best-effort on Windows (NTFS ACLs are not set)"
          : "UNENCRYPTED file, protected only by 0600 permissions",
      protection: "file-permissions",
    }),
  };
}
