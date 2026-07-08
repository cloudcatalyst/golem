/**
 * Proxy daemon lifecycle — pure helpers (pid file, alive/port checks, status).
 * The detached spawn is covered by a live CLI smoke, not here.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultProjectPort,
  isProcessAlive,
  PROXY_PORT_BASE,
  PROXY_PORT_SPAN,
  portInUse,
  proxyPidPath,
  proxyStatus,
  readProxyPid,
  removeProxyPid,
  stopProxy,
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

  it("falls back to a port probe when there is no usable pid file", async () => {
    const server = createServer();
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a bound TCP address");
      }
      const port = address.port;

      const st = await proxyStatus(dir, port, () => false);
      expect(st.running).toBe(true);
      expect(st.source).toBe("port");
      expect(st.port).toBe(port);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("defaultProjectPort", () => {
  it("is deterministic for the same project dir", () => {
    const a = defaultProjectPort("/some/project/path");
    const b = defaultProjectPort("/some/project/path");
    expect(a).toBe(b);
  });

  it("differs for two specific distinct project dirs", () => {
    const a = defaultProjectPort("/some/project/path-one");
    const b = defaultProjectPort("/some/project/path-two");
    expect(a).not.toBe(b);
  });

  it("is always within [PROXY_PORT_BASE, PROXY_PORT_BASE + PROXY_PORT_SPAN)", () => {
    for (const p of ["/a", "/b/c", "D:\\Personar\\Source\\repos\\golem", "", "z".repeat(500)]) {
      const port = defaultProjectPort(p);
      expect(port).toBeGreaterThanOrEqual(PROXY_PORT_BASE);
      expect(port).toBeLessThan(PROXY_PORT_BASE + PROXY_PORT_SPAN);
    }
  });
});

describe("stopProxy", () => {
  it("returns null and does nothing when there is no pid file", async () => {
    expect(await readProxyPid(dir)).toBeNull();
    const stopped = await stopProxy(dir);
    expect(stopped).toBeNull();
  });

  it("kills the process from the pid file, removes it, and returns its pid", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const pid = child.pid;
    if (pid === undefined) throw new Error("child process failed to spawn");

    try {
      // Wait until the child is actually up before we try to stop it.
      const deadline = Date.now() + 5000;
      while (!isProcessAlive(pid) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(isProcessAlive(pid)).toBe(true);

      await writeProxyPid(dir, { pid, port: 4653, ts: "t" });
      const stopped = await stopProxy(dir);
      expect(stopped).toBe(pid);
      expect(await readProxyPid(dir)).toBeNull();

      // Poll for death rather than a fixed sleep — avoids flakiness/races.
      const deadDeadline = Date.now() + 5000;
      let alive = isProcessAlive(pid);
      while (alive && Date.now() < deadDeadline) {
        await new Promise((r) => setTimeout(r, 25));
        alive = isProcessAlive(pid);
      }
      expect(alive).toBe(false);
    } finally {
      // Defensive cleanup in case the kill above didn't land.
      if (isProcessAlive(pid)) {
        try {
          child.kill();
        } catch {
          // already gone
        }
      }
    }
  });
});
