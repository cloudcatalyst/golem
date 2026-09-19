/**
 * R14.x — `startPersonaWatcher`: the live half of persona-artifact sync (see
 * src/cli/persona-watcher.ts). Mirrors `tests/unit/knowledge/file-watcher.test.ts`'s
 * fake-timer idiom — the watcher does real fs work (`stat`, `syncPersonaArtifacts`)
 * inside each poll, so only `setTimeout`/`clearTimeout` are faked and a cycle
 * counter is the wait condition, not a fixed `setImmediate` drain.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InitAction } from "../../../src/cli/init.js";
import type { PersonaWatcher } from "../../../src/cli/persona-watcher.js";
import { personaSettingsPaths, startPersonaWatcher } from "../../../src/cli/persona-watcher.js";
import { useTempDirs } from "../../helpers/tmp.js";

let watcher: PersonaWatcher | undefined;

const newTempDir = useTempDirs("golem-persona-watch-");

afterEach(() => {
  watcher?.close();
  watcher = undefined;
  vi.useRealTimers();
});

async function writeSettings(projectDir: string, value: unknown): Promise<void> {
  await mkdir(path.join(projectDir, ".golem"), { recursive: true });
  await writeFile(
    path.join(projectDir, ".golem", "settings.json"),
    JSON.stringify(value, null, 2),
    "utf8",
  );
}

/** Spin the real event loop until `done()` holds, under fake timers — see file-watcher.test.ts. */
async function waitUntil(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setImmediate(r));
  }
}

async function advanceOnePoll(w: PersonaWatcher, pollMs: number): Promise<void> {
  const before = w.cycles;
  await vi.advanceTimersByTimeAsync(pollMs);
  await waitUntil(() => w.cycles > before, `poll cycle ${before + 1} to complete`);
}

describe("personaSettingsPaths", () => {
  it("names exactly the two settings files, never a directory", async () => {
    const projectDir = await newTempDir();
    const paths = personaSettingsPaths(projectDir).map((p) => p.replace(/\\/gu, "/"));
    expect(paths).toEqual([
      `${projectDir.replace(/\\/gu, "/")}/.golem/settings.json`,
      `${projectDir.replace(/\\/gu, "/")}/.golem/settings.local.json`,
    ]);
  });
});

describe("startPersonaWatcher", () => {
  it("syncs once immediately on start, before any poll", async () => {
    const projectDir = await newTempDir();
    await writeSettings(projectDir, {
      inference: { personas: { coder: { model: "claude-sonnet-5" } } },
    });

    const syncs: (readonly InitAction[])[] = [];
    watcher = await startPersonaWatcher(projectDir, {
      pollMs: 60,
      debounceMs: 150,
      onSync: (actions) => syncs.push(actions),
    });

    expect(syncs).toHaveLength(1);
    await expect(
      readFile(path.join(projectDir, ".claude", "agents", "golem-coder.md"), "utf8"),
    ).resolves.toContain("model: claude-sonnet-5");
  });

  it("does not throw and keeps polling when settings.local.json is missing entirely", async () => {
    const projectDir = await newTempDir();
    // Neither settings file exists yet.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const syncs: (readonly InitAction[])[] = [];
    watcher = await startPersonaWatcher(projectDir, {
      pollMs: 60,
      debounceMs: 150,
      onSync: (actions) => syncs.push(actions),
    });
    expect(syncs).toHaveLength(1); // the immediate startup sync still ran

    await advanceOnePoll(watcher, 60);
    await advanceOnePoll(watcher, 60);
    // No settings ever appeared — no further sync beyond the startup one.
    expect(syncs).toHaveLength(1);
  });

  it("collapses a burst of edits across both files into one sync", async () => {
    const projectDir = await newTempDir();
    await writeSettings(projectDir, { inference: { personas: {} } });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const syncs: (readonly InitAction[])[] = [];
    watcher = await startPersonaWatcher(projectDir, {
      pollMs: 60,
      debounceMs: 150,
      onSync: (actions) => syncs.push(actions),
    });
    expect(syncs).toHaveLength(1); // startup sync

    // Edit settings.json, then settings.local.json, each detected on its own
    // poll — distinct byte lengths so the mtimeMs:size signal actually moves.
    await writeSettings(projectDir, {
      inference: { personas: { coder: { model: "claude-sonnet-5" } } },
    });
    await advanceOnePoll(watcher, 60); // detects, arms debounce

    await mkdir(path.join(projectDir, ".golem"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".golem", "settings.local.json"),
      JSON.stringify({ note: "machine-local" }),
      "utf8",
    );
    await advanceOnePoll(watcher, 60); // detects again, RESETS the debounce

    // Still just the one startup sync — the debounce hasn't fired yet.
    expect(syncs).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(150);
    await waitUntil(() => syncs.length > 1, "the debounce to flush its sync");
    expect(syncs).toHaveLength(2); // one flush for both edits, not two
  });

  it("does not throw on malformed JSON, and the poll loop continues", async () => {
    const projectDir = await newTempDir();
    await writeSettings(projectDir, { inference: { personas: {} } });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const syncs: (readonly InitAction[])[] = [];
    watcher = await startPersonaWatcher(projectDir, {
      pollMs: 60,
      debounceMs: 150,
      onSync: (actions) => syncs.push(actions),
    });
    expect(syncs).toHaveLength(1);

    await mkdir(path.join(projectDir, ".golem"), { recursive: true });
    await writeFile(path.join(projectDir, ".golem", "settings.json"), "{ not valid json", "utf8");
    await advanceOnePoll(watcher, 60);
    await vi.advanceTimersByTimeAsync(150);
    await waitUntil(() => syncs.length > 1, "the debounce to flush despite malformed JSON");
    expect(syncs).toHaveLength(2); // resolveDesiredAgents reports a conflict, doesn't throw

    // The loop is still alive: a further, valid edit is still picked up.
    await writeSettings(projectDir, {
      inference: { personas: { coder: { model: "claude-sonnet-5" } } },
    });
    await advanceOnePoll(watcher, 60);
    await vi.advanceTimersByTimeAsync(150);
    await waitUntil(() => syncs.length > 2, "a later valid edit to flush");
    expect(syncs).toHaveLength(3);
  });

  it("close() stops the poll loop", async () => {
    const projectDir = await newTempDir();
    await writeSettings(projectDir, { inference: { personas: {} } });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const syncs: (readonly InitAction[])[] = [];
    const w = await startPersonaWatcher(projectDir, {
      pollMs: 60,
      debounceMs: 150,
      onSync: (actions) => syncs.push(actions),
    });
    const cyclesAtClose = w.cycles;
    w.close();

    await writeSettings(projectDir, {
      inference: { personas: { coder: { model: "claude-sonnet-5" } } },
    });
    await vi.advanceTimersByTimeAsync(500);
    // No further cycles, no further sync beyond the one startup call.
    expect(w.cycles).toBe(cyclesAtClose);
    expect(syncs).toHaveLength(1);
  });
});
