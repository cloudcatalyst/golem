/**
 * Per-project proxy port (deterministic) + persisted desired-run-state (§47).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultProjectPort,
  PROXY_PORT_BASE,
  PROXY_PORT_SPAN,
} from "../../../src/cli/proxy-daemon.js";
import { readProxyDesired, writeProxyDesired } from "../../../src/cli/proxy-state.js";
import { rmTemp } from "../../helpers/tmp.js";

describe("defaultProjectPort", () => {
  it("is deterministic and inside the range", () => {
    const a = defaultProjectPort("/home/me/projA");
    expect(a).toBe(defaultProjectPort("/home/me/projA"));
    expect(a).toBeGreaterThanOrEqual(PROXY_PORT_BASE);
    expect(a).toBeLessThan(PROXY_PORT_BASE + PROXY_PORT_SPAN);
  });
  it("differs across projects (so they don't collide on one port)", () => {
    expect(defaultProjectPort("/home/me/projA")).not.toBe(defaultProjectPort("/home/me/projB"));
  });
});

describe("proxy desired-run-state", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "golem-pstate-"));
  });
  afterEach(async () => {
    await rm(dir, rmTemp);
  });

  it("is null before anything is written", async () => {
    expect(await readProxyDesired(dir)).toBeNull();
  });

  it("round-trips running/stopped", async () => {
    await writeProxyDesired(dir, "running", "2026-07-06T00:00:00Z");
    expect(await readProxyDesired(dir)).toBe("running");
    await writeProxyDesired(dir, "stopped", "2026-07-06T00:01:00Z");
    expect(await readProxyDesired(dir)).toBe("stopped");
  });
});
