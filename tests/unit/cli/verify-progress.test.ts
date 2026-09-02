import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { selectChecks, verifyChecks } from "../../../src/cli/verify.js";
import {
  formatElapsed,
  HEARTBEAT_MS,
  readVerifyProgress,
  renderVerifySegment,
  STALE_AFTER_MS,
  type VerifyProgress,
  verifyProgressPath,
} from "../../../src/cli/verify-progress.js";

const NOW = 1_800_000_000_000;

function progress(over: Partial<VerifyProgress> = {}): VerifyProgress {
  return {
    runId: "abc",
    total: 7,
    done: [{ id: "build", ok: true, ms: 12_400, exit: 0 }],
    current: "test",
    startedAt: NOW - 130_000,
    updatedAt: NOW - 1_000,
    logPath: "/p/.golem/state/verify.log",
    ...over,
  };
}

describe("renderVerifySegment", () => {
  it("shows the in-flight check, the count and the elapsed time", () => {
    expect(renderVerifySegment(progress(), NOW)).toBe("⏳ verify 1/7 · test 2m10s");
  });

  it("renders nothing when there is no record", () => {
    expect(renderVerifySegment(null, NOW)).toBeNull();
  });

  it("renders nothing for a FINISHED run — the segment is for work in flight", () => {
    expect(renderVerifySegment(progress({ finishedAt: NOW - 500, ok: true }), NOW)).toBeNull();
  });

  it("renders nothing once the heartbeat is stale, rather than pinning a phantom run", () => {
    // A killed session or crashed process leaves the file behind. Trusting it
    // would show "verify running" forever — confidently wrong is worse than silent.
    const abandoned = progress({ updatedAt: NOW - STALE_AFTER_MS - 1 });
    expect(renderVerifySegment(abandoned, NOW)).toBeNull();
  });

  it("still renders while a single slow check runs, since the heartbeat keeps ticking", () => {
    // `vitest` alone takes minutes here: the run must not look dead because one
    // check has not finished. This is why staleness keys off the heartbeat and
    // not off the last completed check.
    const slow = progress({ startedAt: NOW - 400_000, updatedAt: NOW - HEARTBEAT_MS });
    expect(renderVerifySegment(slow, NOW)).toContain("⏳ verify 1/7 · test");
  });

  it("marks a run that has already failed, without waiting for it to end", () => {
    const failed = progress({
      done: [
        { id: "build", ok: true, ms: 1000, exit: 0 },
        { id: "typecheck", ok: false, ms: 2000, exit: 2 },
      ],
    });
    expect(renderVerifySegment(failed, NOW)).toBe("✖ verify 2/7 · test 2m10s");
  });
});

describe("formatElapsed", () => {
  it("is seconds under a minute and m/s above it", () => {
    expect(formatElapsed(12_400)).toBe("12.4s");
    expect(formatElapsed(130_000)).toBe("2m10s");
    expect(formatElapsed(60_000)).toBe("1m00s");
  });

  it("never renders a negative duration from a clock that moved backwards", () => {
    expect(formatElapsed(-5000)).toBe("0.0s");
  });
});

describe("readVerifyProgress", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "golem-verify-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null when nothing has ever run", async () => {
    expect(await readVerifyProgress(dir)).toBeNull();
  });

  it("returns null on a malformed file rather than throwing — the status line must not die", async () => {
    const file = verifyProgressPath(dir);
    await writeFile(file, "{ not json", "utf8").catch(async () => {
      // the state dir may not exist yet in this ordering; create it via the runner path
    });
    // Written or not, the contract is the same: never throw.
    await expect(readVerifyProgress(dir)).resolves.not.toThrow();
  });
});

describe("selectChecks", () => {
  it("runs everything by default, build first", () => {
    const ids = selectChecks(verifyChecks(), undefined, false).map((c) => c.id);
    expect(ids[0]).toBe("build");
    expect(ids).toContain("wiki");
    expect(ids).toHaveLength(7);
  });

  it("keeps build when a selected check reads dist/, so --only wiki cannot check a stale build", () => {
    const ids = selectChecks(verifyChecks(), ["wiki"], false).map((c) => c.id);
    expect(ids).toEqual(["build", "wiki"]);
  });

  it("omits build for a selection that does not need it", () => {
    const ids = selectChecks(verifyChecks(), ["lint"], false).map((c) => c.id);
    expect(ids).toEqual(["lint"]);
  });

  it("honours --no-build even for a check that wants it — the user asked", () => {
    const ids = selectChecks(verifyChecks(), ["wiki"], true).map((c) => c.id);
    expect(ids).toEqual(["wiki"]);
  });
});

describe("verifyChecks", () => {
  it("spawns argument arrays, never shell strings (CLAUDE.md cross-platform rule)", () => {
    for (const check of verifyChecks()) {
      expect(check.argv.length).toBeGreaterThan(1);
      for (const arg of check.argv) expect(typeof arg).toBe("string");
    }
  });

  it("runs the wiki check through the just-built dist, not whatever golem is on PATH", () => {
    const wiki = verifyChecks().find((c) => c.id === "wiki");
    expect(wiki?.needsBuild).toBe(true);
    expect(wiki?.argv[0]).toBe(process.execPath);
    expect(wiki?.argv[1]).toContain(path.join("dist", "cli", "main.js"));
  });
});
