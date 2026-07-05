/**
 * Proxy daemon lifecycle — pure helpers (pid file, alive/port checks, status).
 * The detached spawn is covered by a live CLI smoke, not here.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isProcessAlive,
  portInUse,
  proxyPidPath,
  proxyStatus,
  readProxyPid,
  removeProxyPid,
  writeProxyPid,
} from "../../../src/cli/proxy-daemon.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "golem-daemon-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("pid file", () => {
  it("round-trips and removes", async () => {
    expect(await readProxyPid(dir)).toBeNull();
    await writeProxyPid(dir, { pid: 4242, port: 4653, ts: "2026-07-04T00:00:00Z" });
    expect(await readProxyPid(dir)).toStrictEqual({
      pid: 4242,
      port: 4653,
      ts: "2026-07-04T00:00:00Z",
    });
    await removeProxyPid(dir);
    expect(await readProxyPid(dir)).toBeNull();
  });

  it("returns null on a corrupt pid file", async () => {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.dirname(proxyPidPath(dir)), { recursive: true });
    await fs.writeFile(proxyPidPath(dir), "{bad", "utf8");
    expect(await readProxyPid(dir)).toBeNull();
  });
});

describe("isProcessAlive", () => {
  it("is true for this process, false for a certainly-dead pid", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2_000_000_000)).toBe(false);
  });
});

describe("portInUse", () => {
  it("is false for a port nothing is listening on", async () => {
    expect(await portInUse(1, 200)).toBe(false);
  });
});

describe("proxyStatus", () => {
  it("reports not-running when no pid file and port free", async () => {
    const st = await proxyStatus(dir, 1, () => false);
    expect(st.running).toBe(false);
    expect(st.source).toBe("none");
  });

  it("reports running from the pid file when the pid is alive", async () => {
    await writeProxyPid(dir, { pid: 4242, port: 4653, ts: "t" });
    const st = await proxyStatus(dir, 4653, (pid) => pid === 4242);
    expect(st.running).toBe(true);
    expect(st.pid).toBe(4242);
    expect(st.source).toBe("pidfile");
  });

  it("ignores a stale pid file whose process is dead", async () => {
    await writeProxyPid(dir, { pid: 4242, port: 1, ts: "t" });
    const st = await proxyStatus(dir, 1, () => false); // pid dead + port free
    expect(st.running).toBe(false);
  });
});
