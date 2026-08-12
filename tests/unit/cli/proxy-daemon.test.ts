/**
 * Proxy daemon lifecycle — pure helpers (pid file, alive/port checks, status,
 * port-wait polling) plus a real-process smoke test of the detached spawn
 * (startDetached). The full `golem proxy start/stop` CLI flow is covered by a
 * live CLI smoke test elsewhere, not here.
 */

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  startDetached,
  stopProxy,
  waitForPort,
  waitForPortFree,
  writeProxyPid,
} from "../../../src/cli/proxy-daemon.js";
import { useTempDirs } from "../../helpers/tmp.js";

/** Grab a currently-free loopback port by letting the OS assign one, then releasing it. */
async function getFreePort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected a bound TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

let dir: string;
const newTempDir = useTempDirs("golem-daemon-");

beforeEach(async () => {
  dir = await newTempDir();
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

  // The incident this exists to prevent: a daemon that started 18 hours and
  // several rebuilds ago answers every probe, reports `running`, and looks
  // healthy on every other field — while serving the code AND the config it
  // started with. "Running" and "current" are different questions.
  describe("which BUILD is answering", () => {
    it("is not stale when the running daemon's stamp matches this build", async () => {
      await writeProxyPid(dir, { pid: 4242, port: 4653, ts: "t", version: "9.9.9" });
      const st = await proxyStatus(dir, 4653, (pid) => pid === 4242, "9.9.9");
      expect(st.running).toBe(true);
      expect(st.version).toBe("9.9.9");
      expect(st.stale).toBe(false);
    });

    it("is stale when the running daemon was built from a different version", async () => {
      await writeProxyPid(dir, { pid: 4242, port: 4653, ts: "t", version: "0.17.0" });
      const st = await proxyStatus(dir, 4653, (pid) => pid === 4242, "0.18.0");
      expect(st.running).toBe(true);
      expect(st.version).toBe("0.17.0");
      expect(st.stale).toBe(true);
    });

    it("is stale when the pid file carries no stamp at all", async () => {
      // Written before the stamp existed, so it is older than this build by
      // definition. Unknown must not read as fine.
      await writeProxyPid(dir, { pid: 4242, port: 4653, ts: "t" });
      const st = await proxyStatus(dir, 4653, (pid) => pid === 4242, "0.18.0");
      expect(st.running).toBe(true);
      expect(st.version).toBeUndefined();
      expect(st.stale).toBe(true);
    });

    it("round-trips the stamp through the pid file", async () => {
      await writeProxyPid(dir, { pid: 1, port: 2, ts: "t", version: "1.2.3" });
      expect((await readProxyPid(dir))?.version).toBe("1.2.3");
    });
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

describe("waitForPort", () => {
  it("resolves true once something actually starts listening on the port", async () => {
    const port = await getFreePort();
    const promise = waitForPort(port, 5000);
    const server = createServer();
    try {
      // Give the poll loop a couple of misses before anything is listening.
      await new Promise((r) => setTimeout(r, 200));
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve());
      });
      expect(await promise).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns false (does not throw/reject) when nothing ever listens before the timeout", async () => {
    const port = await getFreePort(); // freed immediately; nothing rebinds it
    await expect(waitForPort(port, 300)).resolves.toBe(false);
  });
});

describe("waitForPortFree", () => {
  it("resolves true once an occupied port becomes free", async () => {
    const port = await getFreePort();
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });

    const promise = waitForPortFree(port, 5000);
    // Give the poll loop a couple of misses before the port is freed.
    await new Promise((r) => setTimeout(r, 200));
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(await promise).toBe(true);
  });

  it("resolves true right away when the port is already free", async () => {
    const port = await getFreePort();
    await expect(waitForPortFree(port, 2000)).resolves.toBe(true);
  });
});

describe("startDetached", () => {
  // A minimal stand-in for the real `golem proxy start --dir <dir> --port <port>`
  // CLI: it parses the same flags, binds the port, writes the same pid-file shape
  // proxy-daemon.ts reads back, then self-terminates so a missed cleanup can never
  // leak a background process. CommonJS (`.cjs`) so it runs regardless of the
  // temp dir's module type.
  const FAKE_PROXY_SCRIPT = `"use strict";
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
function argVal(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

const port = Number(argVal("--port"));
const dir = argVal("--dir");

const server = net.createServer();
server.listen(port, "127.0.0.1", () => {
  if (dir) {
    const pidDir = path.join(dir, ".golem");
    fs.mkdirSync(pidDir, { recursive: true });
    fs.writeFileSync(
      path.join(pidDir, "proxy.pid"),
      JSON.stringify({ pid: process.pid, port: port, ts: new Date().toISOString() }) + "\\n",
      "utf8",
    );
  }
});

setTimeout(() => process.exit(0), 4000);
`;

  it("spawns a detached, unref'd child and resolves with its pid once it is listening", async () => {
    const scriptPath = path.join(dir, "fake-proxy.cjs");
    await writeFile(scriptPath, FAKE_PROXY_SCRIPT, "utf8");
    const port = await getFreePort();

    // Spy on the real ChildProcess prototype (shared singleton class, however it
    // is required/imported) to observe that the spawned child is unref'd, while
    // still letting the actual spawn/unref run for real — nothing here is faked.
    const cp = createRequire(import.meta.url)(
      "node:child_process",
    ) as typeof import("node:child_process");
    const unrefSpy = vi.spyOn(cp.ChildProcess.prototype, "unref");

    let pid: number | null = null;
    try {
      pid = await startDetached(dir, port, scriptPath);
      expect(pid).not.toBeNull();
      expect(typeof pid).toBe("number");
      expect(await portInUse(port)).toBe(true);
      expect(unrefSpy).toHaveBeenCalled();
    } finally {
      unrefSpy.mockRestore();
      if (pid !== null) {
        try {
          process.kill(pid);
        } catch {
          // already gone / no permission
        }
      }
    }
  });

  it("returns null when nothing ever comes up on the port", async () => {
    const scriptPath = path.join(dir, "fake-proxy-noop.cjs");
    // Never binds the port and exits almost immediately.
    await writeFile(scriptPath, `"use strict";\nprocess.exit(0);\n`, "utf8");
    const port = await getFreePort();

    // Short budget on purpose: the production default is deliberately generous
    // (R9.18 — a tight one reported healthy daemons as failed), and waiting it
    // out here would both slow this test and starve the parallel suite.
    const pid = await startDetached(dir, port, scriptPath, {}, { waitMs: 1_000 });
    expect(pid).toBeNull();
  }, 10_000);
});
