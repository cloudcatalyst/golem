/**
 * HeadroomSidecar lifecycle + fail-open, tested against a fake worker (Node) that
 * speaks the worker protocol — so no Python/uv/headroom is needed in CI. A real
 * end-to-end run against the Python worker is a manual smoke (docs/DEVELOPMENT).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { HeadroomSidecar } from "../../src/compression/headroom-adapter.js";

const FAKE_WORKER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "fake-headroom-worker.mjs",
);

/** A sidecar that launches the fake worker via `node <fake>` instead of uv/python. */
function fakeSidecar(env: Record<string, string> = {}, startupTimeoutMs = 8000): HeadroomSidecar {
  return new HeadroomSidecar({
    command: process.execPath, // node
    launchArgs: [],
    workerPath: FAKE_WORKER,
    startupTimeoutMs,
    requestTimeoutMs: 5000,
    log: () => {}, // silence
    // env is applied by the fake worker via process.env; set it on this process
    // for the child to inherit (vitest runs serially per file by default).
    ...applyEnv(env),
  });
}

/** Set env vars the fake worker reads; return {} so it merges cleanly into options. */
function applyEnv(env: Record<string, string>): Record<string, never> {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return {};
}

const sidecars: HeadroomSidecar[] = [];
function track(s: HeadroomSidecar): HeadroomSidecar {
  sidecars.push(s);
  return s;
}

afterEach(() => {
  for (const s of sidecars.splice(0)) s.stop();
  process.env.FAKE_MODE = undefined as unknown as string;
  delete process.env.FAKE_MODE;
});

describe("HeadroomSidecar (fake worker)", () => {
  it("starts, health-checks, compresses, and returns parsed results", async () => {
    const sc = track(fakeSidecar());
    expect(await sc.start()).toBe(true);
    expect(sc.isRunning()).toBe(true);

    const messages = [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ];
    const result = await sc.compress(messages, "stale_turns");
    expect(result).not.toBeNull();
    expect(result?.tokensBefore).toBe(1000);
    expect(result?.tokensAfter).toBe(900);
    expect(result?.transformsApplied).toContain("read_lifecycle:stale:/x");
    // Fake worker drops the first message.
    expect(result?.messages).toHaveLength(2);
  });

  it("lazily starts on first compress() when start() was not called", async () => {
    const sc = track(fakeSidecar());
    const result = await sc.compress([{ role: "user", content: "x" }], "aggressive");
    expect(result).not.toBeNull();
    expect(sc.isRunning()).toBe(true);
  });

  it("fails open (null) when the launcher command does not exist", async () => {
    const sc = track(
      new HeadroomSidecar({
        command: "definitely-not-a-real-command-xyz",
        launchArgs: [],
        workerPath: FAKE_WORKER,
        startupTimeoutMs: 3000,
        log: () => {},
      }),
    );
    expect(await sc.start()).toBe(false);
    expect(await sc.compress([{ role: "user", content: "x" }], "stale_turns")).toBeNull();
    expect(sc.isRunning()).toBe(false);
  });

  it("fails open (null) when the worker returns a non-200 on /compress", async () => {
    const sc = track(fakeSidecar({ FAKE_MODE: "badstatus" }));
    expect(await sc.start()).toBe(true);
    expect(await sc.compress([{ role: "user", content: "x" }], "stale_turns")).toBeNull();
  });

  it("fails open (false) when the worker never announces a port (startup timeout)", async () => {
    const sc = track(fakeSidecar({ FAKE_MODE: "slowstart" }, 1200));
    expect(await sc.start()).toBe(false);
  });

  it("fails open (false) when the worker announces a port but never passes the health check", async () => {
    const sc = track(fakeSidecar({ FAKE_MODE: "unhealthy" }));
    expect(await sc.start()).toBe(false);
    expect(sc.isRunning()).toBe(false);
  });

  it("backs off on unexpected worker death and does not respawn immediately (R8.30)", async () => {
    // Use a short backoff base (100ms) so the test is fast but the delay is measurable.
    const sc = track(
      new HeadroomSidecar({
        command: process.execPath,
        launchArgs: [],
        workerPath: FAKE_WORKER,
        startupTimeoutMs: 8000,
        requestTimeoutMs: 5000,
        log: () => {},
        backoffBaseMs: 500,
      }),
    );
    // Apply the fake-worker mode to this process so the child inherits it.
    applyEnv({ FAKE_MODE: "die_after_healthy" });

    // Start the worker — it should succeed.
    expect(await sc.start()).toBe(true);
    expect(sc.isRunning()).toBe(true);

    // R10.2 — wait for the OBSERVED exit, not for a wall-clock guess. This used
    // to sleep 400ms against a worker that dies at 300ms, leaving 100ms for the
    // exit handler to run in; under load it had not, and `isRunning()` read true.
    // Polling asserts the same thing without budgeting for the machine's mood.
    await expect.poll(() => sc.isRunning(), { timeout: 10_000, interval: 10 }).toBe(false);

    // The exit handler armed a backoff from the death time. A start() issued now
    // must NOT respawn immediately — it must wait out the remainder.
    //
    // Asserted against the sidecar's OWN deadline rather than a hand-picked
    // margin: `nextSpawnAt` and `Date.now()` are two readings of one clock, so a
    // slow machine can only push the second one later, never make this fail. The
    // old form measured elapsed time against a 100ms floor and inherited every
    // scheduling delay between the death and the assertion.
    // TWO assertions, because either alone is passable by a broken implementation:
    //   1. the armed DELAY is the configured backoff — pure state, no clock, so it
    //      fails the moment the backoff stops being armed;
    //   2. start() did not return before the deadline that delay produced.
    // The deadline alone is not enough: with no backoff armed, `nextSpawnAt` is
    // already in the past and `Date.now() >= it` is vacuously true. That exact
    // hole was found by deliberately removing the backoff and watching this test
    // still pass (R10.2).
    const backoffUntil = sc.nextSpawnAt;
    expect(sc.respawnDelayMs).toBe(500); // === backoffBaseMs, first attempt
    expect(await sc.start()).toBe(true);
    expect(Date.now()).toBeGreaterThanOrEqual(backoffUntil); // waited it out

    // And after a successful restart, the worker is running again.
    expect(sc.isRunning()).toBe(true);
  });
});

/**
 * Decision 53 — the opaque `CompressConfig` passthrough. The point of these is
 * that Golem never enumerates Headroom's options: an unknown-to-Golem key must
 * still reach the worker, and a key the *worker* rejects must be reported rather
 * than silently dropped.
 */
describe("HeadroomSidecar config passthrough (Decision 53)", () => {
  function configuredSidecar(
    config: Readonly<Record<string, unknown>>,
    log: (m: string) => void = () => {},
  ): HeadroomSidecar {
    return track(
      new HeadroomSidecar({
        command: process.execPath,
        launchArgs: [],
        workerPath: FAKE_WORKER,
        startupTimeoutMs: 8000,
        requestTimeoutMs: 5000,
        config,
        log,
      }),
    );
  }

  const MESSAGES = [
    { role: "user", content: "one" },
    { role: "assistant", content: "two" },
  ];

  it("forwards a key Golem has never heard of, as long as the worker accepts it", async () => {
    // `kompress_model` is deliberately NOT referenced anywhere in Golem's TS.
    const sc = configuredSidecar({ kompress_model: "some-model" });
    expect(await sc.start()).toBe(true);
    const result = await sc.compress(MESSAGES, "stale_turns");
    expect(result).not.toBeNull();
    const health = await sc.health();
    expect(health?.supported_config).toContain("kompress_model");
  });

  it("sends no config key at all when the bag is empty", async () => {
    // An empty object must not become `config: {}` chatter on every request; the
    // worker's mode presets are the whole behaviour until a user reaches past them.
    const logs: string[] = [];
    const sc = configuredSidecar({}, (m) => logs.push(m));
    expect(await sc.start()).toBe(true);
    expect(await sc.compress(MESSAGES, "stale_turns")).not.toBeNull();
    // Startup chatter is expected; what must be absent is any config diagnostic.
    expect(logs.filter((l) => l.includes("headroom_config"))).toEqual([]);
  });

  it("warns once when the worker ignores an unsupported key, not once per request", async () => {
    const logs: string[] = [];
    const sc = configuredSidecar({ not_a_real_headroom_option: 1 }, (m) => logs.push(m));
    expect(await sc.start()).toBe(true);
    await sc.compress(MESSAGES, "stale_turns");
    await sc.compress(MESSAGES, "stale_turns");
    await sc.compress(MESSAGES, "stale_turns");
    const warnings = logs.filter((l) => l.includes("headroom_config"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not_a_real_headroom_option");
  });

  it("still compresses when a key is ignored — a bad option costs the option, not the stage", async () => {
    const sc = configuredSidecar({ not_a_real_headroom_option: 1 });
    expect(await sc.start()).toBe(true);
    const result = await sc.compress(MESSAGES, "stale_turns");
    expect(result?.messages).toHaveLength(MESSAGES.length - 1);
    expect(result?.tokensBefore).toBe(1000);
  });

  it("reports supported_config from the running worker, not from the pin", async () => {
    const sc = configuredSidecar({});
    expect(await sc.start()).toBe(true);
    const health = await sc.health();
    expect(health?.ok).toBe(true);
    expect(health?.supported_config).toEqual([
      "compress_user_messages",
      "kompress_model",
      "protect_recent",
    ]);
  });

  it("returns null from health() when the worker is not running", async () => {
    const sc = configuredSidecar({});
    expect(await sc.health()).toBeNull();
  });
});
