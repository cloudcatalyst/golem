/**
 * R14.x — e2e smoke: `startPersonaWatcher` (src/cli/persona-watcher.ts)
 * notices a REAL edit to a REAL project's `.golem/settings.json` and
 * regenerates `.claude/agents/golem-coder.md` — no subprocess, no fake
 * timers, just small real `pollMs`/`debounceMs` values so the whole thing
 * still finishes in well under a second of wall time.
 *
 * A previous attempt at this test concluded it would need to spawn a real
 * child process running the built CLI's `golem proxy start` (real Ollama
 * probing, telemetry, plugin loading, cert generation) and stopped rather
 * than build that. That conclusion doesn't hold: `startPersonaWatcher` is a
 * plain async function of `(projectDir, options)` with no dependency on the
 * CLI process, Ollama, telemetry, or certs — exactly the kind of "bits
 * `runProxyForeground` adds around" the core construction that
 * `golem-init-smoke.test.ts`'s own header comment describes for
 * `buildProxyFromSettings`. Same move here: call it directly, in-process,
 * against a temp project built with `golemInit` + a fake `InitProbe` (so no
 * real `claude` binary is touched — see below for the one piece of real-home
 * exposure this path still has, which is NOT sidestepped the same way).
 *
 * ## The real-home isolation gap this test found — now closed
 *
 * `startPersonaWatcher` → `syncPersonaArtifacts` → `resolveDesiredAgents`
 * (src/cli/persona-sync.ts) used to call `loadConfig({ projectDir })` with
 * NO `userDir` override — unlike `golem-init-smoke.test.ts`'s own `loadConfig`
 * call, which passes an explicit, never-populated `fakeUserDir` precisely to
 * keep the real `~/.golem/settings.json` out of the test. `inference.personas`
 * merges PER PERSONA ID across layers (`MERGE_PER_KEY_LEAVES` in
 * src/config/loader.ts), so a developer or CI image with a `coder` (or other)
 * entry in their real user-scope settings would have had it deep-merge
 * underneath this test's project-scope settings — a real gap, not a
 * false alarm, just invisible on whatever machine had no conflicting entry.
 *
 * All three functions now take an optional `userDir`, threaded straight to
 * `loadConfig` (real callers — `golem init`, every session start, the live
 * daemon watcher — never set it, so they keep resolving the real
 * `~/.golem` as intended). This test passes a never-populated `fakeUserDir`,
 * same as `golem-init-smoke.test.ts`, so it is now fully isolated from
 * whatever the real user happens to have configured.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { golemInit, type InitProbe } from "../../src/cli/init.js";
import { startPersonaWatcher } from "../../src/cli/persona-watcher.js";
import { useTempDirs } from "../helpers/tmp.js";

// Same R10.2 rationale as golem-init-smoke.test.ts: golemInit's filesystem
// work is virus-scanner-event-heavy on Windows under full parallel load, and
// this file does at least one golemInit() call plus a live poll loop.
vi.setConfig({ testTimeout: 90_000 });

const newTempDir = useTempDirs("golem-persona-watch-e2e");

// golemInit only ever consults this probe — never shells out to a real
// `claude` binary and never reads the real home directory.
const fakeProbe: InitProbe = {
  claudeCodeInstalled: () => Promise.resolve(true),
  headroomWrapActive: () => Promise.resolve(false),
};

let projectDir: string;
/** Never populated — proves the real `~/.golem` user layer is never read. */
let fakeUserDir: string;
const AGENT_REL = path.join(".claude", "agents", "golem-coder.md");

beforeEach(async () => {
  projectDir = await newTempDir();
  fakeUserDir = path.join(await newTempDir(), ".golem");
});

/** Write `.golem/settings.json` directly, the way a user's edit arrives on disk. */
async function writeGolemSettings(settings: Record<string, unknown>): Promise<void> {
  await mkdir(path.join(projectDir, ".golem"), { recursive: true });
  await writeFile(
    path.join(projectDir, ".golem", "settings.json"),
    JSON.stringify(settings, null, 2),
    "utf8",
  );
}

async function readAgent(): Promise<string | null> {
  try {
    return await readFile(path.join(projectDir, AGENT_REL), "utf8");
  } catch {
    return null;
  }
}

/** Spin the real event loop, on real wall-clock time, until `done()` holds. */
async function waitUntil(
  done: () => Promise<boolean> | boolean,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("startPersonaWatcher e2e smoke", () => {
  it("notices a real settings.json edit, regenerates golem-coder.md, and stops cleanly on close()", async () => {
    // 1. A real project, with the coder persona staffed — same shape
    // tests/integration/cli-init-coder-agent.test.ts already establishes.
    await writeGolemSettings({ inference: { personas: { coder: { model: "claude-sonnet-5" } } } });
    await golemInit({ projectDir, probe: fakeProbe });
    expect(await readAgent()).toContain("model: claude-sonnet-5");

    // Real timers throughout — the same order of magnitude
    // tests/unit/cli/persona-watcher.test.ts found workable for its own
    // (fake-timer) poll/debounce values, small enough that this whole test
    // still finishes in well under a second of real wall time.
    const pollMs = 60;
    const debounceMs = 150;
    const watcher = await startPersonaWatcher(projectDir, {
      pollMs,
      debounceMs,
      userDir: fakeUserDir,
    });
    try {
      // 3. A real disk edit — not an in-memory override — proving the REAL
      // poll loop notices a REAL file change. Different byte length than
      // "claude-sonnet-5" so the mtimeMs:size change signal moves even under
      // coarse filesystem mtime resolution (same reasoning the unit test's
      // own header comment gives for picking distinct-length values).
      await writeGolemSettings({ inference: { personas: { coder: { model: "claude-opus-5" } } } });

      // 4. Poll the actual artifact, not a fixed sleep, for the new model to
      // land — this is the real end-to-end assertion.
      await waitUntil(
        async () => (await readAgent())?.includes("model: claude-opus-5") ?? false,
        "the poll loop to notice the settings edit and regenerate golem-coder.md",
      );

      // 5. Clean shutdown: close() must stop the poll loop, not merely stop
      // firing onSync. `cycles` is the same idiom
      // tests/unit/cli/persona-watcher.test.ts uses to assert this in
      // isolation — proven here against a real, running poll loop instead.
      const cyclesAtClose = watcher.cycles;
      watcher.close();

      // A further real edit after close() must produce neither a new cycle
      // nor a new sync — give the loop several real poll intervals' worth of
      // wall time to prove nothing is still ticking.
      await writeGolemSettings({
        inference: { personas: { coder: { model: "claude-sonnet-5" } } },
      });
      await new Promise((resolve) => setTimeout(resolve, pollMs * 5));
      expect(watcher.cycles).toBe(cyclesAtClose);
      expect(await readAgent()).toContain("model: claude-opus-5"); // unchanged post-close
    } finally {
      watcher.close();
    }
  });
});
