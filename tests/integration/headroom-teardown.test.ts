/**
 * R10.3 — a Headroom sidecar must not outlive the process that spawned it.
 *
 * The defect these cover, measured before the fix: 24 orphaned Python workers on
 * one machine, the oldest five days old, still burning CPU with no parent left.
 * Three separate holes produced it, and there is a test here for each:
 *
 * 1. The proxy's shutdown handler stopped only the SEMANTIC sidecar, so the
 *    memory sidecar leaked even on a clean POSIX shutdown → one teardown must
 *    reap every kind of worker.
 * 2. The worker is not the direct child. `uv run` puts a launcher (and on
 *    Windows a trampoline Python) in between, so killing the pid Node holds does
 *    not kill the worker → teardown must reach a grandchild.
 * 3. Nothing in a parent killed with `TerminateProcess` runs at all → the worker
 *    itself must exit when its stdin pipe closes, with no cooperation from the
 *    parent whatsoever.
 *
 * Everything runs against the Node fake worker (which mirrors the Python
 * watchdog), so no Python/uv/headroom is needed.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  HeadroomMemorySidecar,
  HeadroomSidecar,
  selectHeadroomOrphans,
  stopAllHeadroomWorkers,
} from "../../src/compression/headroom-adapter.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const FAKE_WORKER = path.join(FIXTURES, "fake-headroom-worker.mjs");
const FAKE_MEMORY_WORKER = path.join(FIXTURES, "fake-headroom-memory-worker.mjs");
const FAKE_LAUNCHER = path.join(FIXTURES, "fake-headroom-launcher.mjs");

/** `kill(pid, 0)` throws ESRCH once the process is gone. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForDeath(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** Sidecar whose worker runs as a GRANDCHILD, the way `uv run` really launches it. */
function launchedSidecar(): HeadroomSidecar {
  return new HeadroomSidecar({
    command: process.execPath,
    launchArgs: [FAKE_LAUNCHER],
    workerPath: FAKE_WORKER,
    startupTimeoutMs: 15_000,
    requestTimeoutMs: 5000,
    log: () => {},
  });
}

const started: Array<{ stop: () => void }> = [];
const strayPids: number[] = [];

afterEach(async () => {
  for (const s of started.splice(0)) s.stop();
  for (const pid of strayPids.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      // already gone — which is what the tests assert anyway
    }
  }
  await new Promise((r) => setTimeout(r, 50));
});

describe("one teardown reaps every sidecar (hole 1)", () => {
  it("stopAllHeadroomWorkers stops the semantic AND the memory sidecar", async () => {
    const semantic = new HeadroomSidecar({
      command: process.execPath,
      launchArgs: [],
      workerPath: FAKE_WORKER,
      startupTimeoutMs: 15_000,
      log: () => {},
    });
    const memory = new HeadroomMemorySidecar({
      command: process.execPath,
      launchArgs: [],
      workerPath: FAKE_MEMORY_WORKER,
      startupTimeoutMs: 15_000,
      log: () => {},
    });
    started.push(semantic, memory);

    expect(await semantic.start()).toBe(true);
    expect(await memory.start()).toBe(true);
    // The memory sidecar reports its pid on /health; the semantic one via health().
    const semanticPid = (await semantic.health())?.pid;
    expect(typeof semanticPid).toBe("number");

    // ONE call — the caller does not enumerate sidecar classes. Before R10.3 the
    // proxy called `semantic?.stop()` and the memory worker was simply never
    // stopped by anything, ever.
    stopAllHeadroomWorkers();

    expect(semantic.isRunning()).toBe(false);
    expect(memory.isRunning()).toBe(false);
    expect(await waitForDeath(semanticPid as number)).toBe(true);
  });
});

describe("teardown reaches the real worker, not just the direct child (hole 2)", () => {
  it("the adapter turns the parent-death watchdog on in the spawned worker", async () => {
    const sc = launchedSidecar();
    started.push(sc);
    expect(await sc.start()).toBe(true);
    // Reported by the fake worker from GOLEM_HEADROOM_PARENT_PIPE: proves the
    // adapter asked for the watchdog and that the request survived the launcher.
    expect((await sc.health())?.stdin_watch).toBe(true);
  });

  it("stop() kills a worker that is a GRANDCHILD of the process Node spawned", async () => {
    const sc = launchedSidecar();
    started.push(sc);
    expect(await sc.start()).toBe(true);

    const workerPid = (await sc.health())?.pid as number;
    expect(typeof workerPid).toBe("number");
    strayPids.push(workerPid);
    expect(isAlive(workerPid)).toBe(true);

    sc.stop();

    // The pid Node holds is the launcher's. Killing only that used to leave this
    // process alive and serving with nothing above it — an orphan.
    expect(await waitForDeath(workerPid)).toBe(true);
  });
});

describe("the worker exits on its own when the parent's pipe closes (hole 3)", () => {
  it("dies on stdin EOF with nobody killing it", async () => {
    // No adapter and no signals here on purpose: this is the property that has to
    // hold when the parent is killed with TerminateProcess and NOTHING in it runs.
    const chain = spawn(process.execPath, [FAKE_LAUNCHER, FAKE_WORKER, "--port", "0"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, GOLEM_HEADROOM_PARENT_PIPE: "1", FAKE_MODE: "ok" },
    });
    const launcherPid = chain.pid as number;
    strayPids.push(launcherPid);

    // Wait for the worker to announce itself, so we know it is fully up.
    const listening = await new Promise<boolean>((resolve) => {
      let buf = "";
      const timer = setTimeout(() => resolve(false), 15_000);
      chain.stdout.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        if (/GOLEM_HEADROOM_LISTENING \d+/.test(buf)) {
          clearTimeout(timer);
          resolve(true);
        }
      });
    });
    expect(listening).toBe(true);

    // Close the write end — exactly what the OS does to a dead parent's handles.
    chain.stdin.end();
    chain.stdin.destroy();

    // The launcher exits because its child did; the whole chain unwinds without a
    // single kill being issued.
    expect(await waitForDeath(launcherPid)).toBe(true);
  });
});

describe("the orphan sweep is scoped to one project", () => {
  const dir = "D:\\Personar\\Source\\repos\\golem";
  const rows = [
    // This project, repo-local install: the script itself lives under the project.
    {
      pid: 101,
      commandLine:
        '"C:\\uv\\python.exe" D:\\Personar\\Source\\repos\\golem\\dist\\compression\\headroom-worker.py --port 0',
    },
    // This project, global install: only the stamp identifies it.
    {
      pid: 102,
      commandLine:
        "python /opt/golem/dist/compression/headroom-memory-worker.py --port 0 --golem-project D:/Personar/Source/repos/golem",
    },
    // ANOTHER project's worker, same global install — three were alive on the
    // machine where this was measured. Killing these is the accident to avoid.
    {
      pid: 201,
      commandLine:
        "python /opt/golem/dist/compression/headroom-worker.py --port 0 --golem-project D:/Personar/Source/repos/other",
    },
    {
      pid: 202,
      commandLine:
        "python D:\\Personar\\Source\\repos\\golem2\\dist\\compression\\headroom-worker.py --port 0",
    },
    // Not a Headroom worker at all.
    {
      pid: 301,
      commandLine: "python D:\\Personar\\Source\\repos\\golem\\scripts\\something-else.py",
    },
  ];

  it("selects this project's workers and nothing else", () => {
    expect(selectHeadroomOrphans(rows, { projectDir: dir }).sort()).toEqual([101, 102]);
  });

  it("never selects the current process or an excluded pid", () => {
    expect(selectHeadroomOrphans(rows, { projectDir: dir, excludePids: [101] })).toEqual([102]);
    const self = [
      { pid: process.pid, commandLine: `python ${dir}\\dist\\compression\\headroom-worker.py` },
    ];
    expect(selectHeadroomOrphans(self, { projectDir: dir })).toEqual([]);
  });

  it("selects nothing when the project directory is empty", () => {
    expect(selectHeadroomOrphans(rows, { projectDir: "" })).toEqual([]);
  });
});
