/**
 * Task `subagent-park` — the spawn gate.
 *
 * The gate exists because the usage-limit park cannot reach a subagent: the child
 * dies on a model request, before it can propose a tool call to be denied. What
 * is testable — and what these tests pin — is the parent's decision at the one
 * point it still owns: the spawn.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPAWN_COST_FRACTION,
  decideSpawnGate,
  isSpawnTool,
  NO_READING,
  readSpawnGateState,
  recordSpawn,
  SPAWN_RECORD_TTL_MS,
  spawnBlindReason,
  spawnRefusalReason,
  writeSpawnGateState,
} from "../../../src/hooks/spawn-gate.js";
import type { LimitPrediction } from "../../../src/proxy/limit-prediction.js";
import { useTempDirs } from "../../helpers/tmp.js";

const NOW_MS = Date.parse("2026-08-22T12:00:00.000Z");
const OBSERVED = "2026-08-22T11:59:30.000Z";

const prediction = (utilization: number, observedAtIso = OBSERVED): LimitPrediction => ({
  observedAtIso,
  fiveHour: { utilization, resetAtIso: "2026-08-22T14:00:00.000Z" },
});

describe("isSpawnTool", () => {
  it("matches both names Claude Code's spawn tool has shipped with", () => {
    expect(isSpawnTool("Task")).toBe(true);
    expect(isSpawnTool("Agent")).toBe(true);
  });

  it("does not match ordinary tools", () => {
    for (const tool of ["Read", "Bash", "TodoWrite", "mcp__golem__search"]) {
      expect(isSpawnTool(tool), tool).toBe(false);
    }
  });
});

describe("decideSpawnGate", () => {
  it("allows a spawn with room to finish", () => {
    const d = decideSpawnGate(prediction(0.5), {}, NOW_MS);
    expect(d.kind).toBe("allow");
  });

  it("refuses when the projected total passes the limit", () => {
    const d = decideSpawnGate(prediction(0.9), {}, NOW_MS);
    expect(d.kind).toBe("refuse");
    if (d.kind !== "refuse") return;
    expect(d.utilization).toBe(0.9);
    expect(d.projected).toBeCloseTo(0.9 + DEFAULT_SPAWN_COST_FRACTION, 10);
    expect(d.inFlight).toBe(0);
  });

  it("allows exactly at the boundary (projection == 1 still fits)", () => {
    const d = decideSpawnGate(prediction(0.8), {}, NOW_MS, { costFraction: 0.2 });
    expect(d.kind).toBe("allow");
  });

  /**
   * The three-at-once fan-out that lost two agents. Utilization already includes
   * what RUNNING children have spent, but not a sibling dispatched since the
   * reading was taken — so without this, every spawn in a batch reads the same
   * pre-batch number and each one looks affordable on its own.
   */
  it("charges for siblings dispatched since the reading was taken", () => {
    const state = {
      spawnsAtIso: ["2026-08-22T11:59:45.000Z", "2026-08-22T11:59:50.000Z"],
    };
    // 0.5 alone would be fine; 0.5 + 0.18 x 3 = 1.04 is not.
    expect(decideSpawnGate(prediction(0.5), {}, NOW_MS).kind).toBe("allow");
    const d = decideSpawnGate(prediction(0.5), state, NOW_MS);
    expect(d.kind).toBe("refuse");
    if (d.kind !== "refuse") return;
    expect(d.inFlight).toBe(2);
    expect(d.projected).toBeCloseTo(1.04, 10);
  });

  it("ignores spawns recorded BEFORE the reading — their spend is already in it", () => {
    const state = { spawnsAtIso: ["2026-08-22T11:00:00.000Z"] };
    const d = decideSpawnGate(prediction(0.5), state, NOW_MS);
    expect(d.kind).toBe("allow");
  });

  it("honours a configured cost fraction", () => {
    expect(decideSpawnGate(prediction(0.9), {}, NOW_MS, { costFraction: 0.05 }).kind).toBe("allow");
    expect(decideSpawnGate(prediction(0.5), {}, NOW_MS, { costFraction: 0.6 }).kind).toBe("refuse");
  });

  // --- never silently allow (ADR-0002 fail-closed) ---

  it("warns rather than assuming headroom when there is no reading at all", () => {
    const d = decideSpawnGate(null, {}, NOW_MS);
    expect(d.kind).toBe("blind");
    if (d.kind !== "blind") return;
    expect(d.reason).toBe("no-reading");
    expect(d.reading).toBe(NO_READING);
  });

  it("warns when the header feed has gone cold", () => {
    const stale = prediction(0.2, "2026-08-22T10:00:00.000Z"); // 2h old
    const d = decideSpawnGate(stale, {}, NOW_MS);
    expect(d.kind).toBe("blind");
    if (d.kind !== "blind") return;
    expect(d.reason).toBe("stale");
    expect(d.ageMinutes).toBe(120);
  });

  it("warns ONCE per reading — a re-issued spawn proceeds, so it never deadlocks", () => {
    expect(decideSpawnGate(null, { blindWarnedForReading: NO_READING }, NOW_MS).kind).toBe("allow");
    const stale = prediction(0.2, "2026-08-22T10:00:00.000Z");
    expect(
      decideSpawnGate(stale, { blindWarnedForReading: stale.observedAtIso }, NOW_MS).kind,
    ).toBe("allow");
  });

  it("treats an unparseable observedAtIso as blind, not as fresh", () => {
    const d = decideSpawnGate(prediction(0.1, "not-a-date"), {}, NOW_MS);
    expect(d.kind).toBe("blind");
  });

  /**
   * A refusal that does not say what it measured will be worked around — so the
   * numbers are part of the contract, not decoration.
   */
  it("puts the measured numbers and both escapes in the refusal", () => {
    const d = decideSpawnGate(prediction(0.9), {}, NOW_MS);
    if (d.kind !== "refuse") throw new Error("expected refuse");
    const reason = spawnRefusalReason(d);
    expect(reason).toContain("90%");
    expect(reason).toContain("18%");
    expect(reason).toContain("108%");
    expect(reason).toContain("2026-08-22T14:00:00.000Z");
    expect(reason).toContain("mcp__golem__snooze");
    expect(reason).toContain("GOLEM_SNOOZE_SPAWN_GATE=false");
  });

  it("names the sibling count in the refusal when there is one", () => {
    const d = decideSpawnGate(
      prediction(0.5),
      { spawnsAtIso: ["2026-08-22T11:59:45.000Z"] },
      NOW_MS,
      {
        costFraction: 0.4,
      },
    );
    if (d.kind !== "refuse") throw new Error("expected refuse");
    expect(spawnRefusalReason(d)).toContain("1 spawn dispatched since that reading");
  });

  it("tells the blind case to commit early, since a death is what it is warning about", () => {
    const d = decideSpawnGate(null, {}, NOW_MS);
    if (d.kind !== "blind") throw new Error("expected blind");
    const reason = spawnBlindReason(d);
    expect(reason).toContain("COMMIT working increments early");
    expect(reason).toContain("re-issue the spawn");
  });
});

describe("recordSpawn", () => {
  it("appends the new spawn", () => {
    const next = recordSpawn({}, NOW_MS, "2026-08-22T12:00:00.000Z");
    expect(next.spawnsAtIso).toEqual(["2026-08-22T12:00:00.000Z"]);
  });

  it("prunes entries older than the TTL and drops unparseable ones", () => {
    const old = new Date(NOW_MS - SPAWN_RECORD_TTL_MS - 1000).toISOString();
    const recent = new Date(NOW_MS - 60_000).toISOString();
    const next = recordSpawn(
      { spawnsAtIso: [old, "garbage", recent] },
      NOW_MS,
      "2026-08-22T12:00:00.000Z",
    );
    expect(next.spawnsAtIso).toEqual([recent, "2026-08-22T12:00:00.000Z"]);
  });

  it("preserves the blind-warning marker", () => {
    const next = recordSpawn(
      { blindWarnedForReading: NO_READING },
      NOW_MS,
      "2026-08-22T12:00:00.000Z",
    );
    expect(next.blindWarnedForReading).toBe(NO_READING);
  });
});

describe("spawn-gate state I/O", () => {
  const newTempDir = useTempDirs("golem-spawn-gate-");

  it("round-trips", async () => {
    const dir = await newTempDir();
    await writeSpawnGateState(dir, { spawnsAtIso: ["2026-08-22T12:00:00.000Z"] });
    expect(await readSpawnGateState(dir)).toEqual({ spawnsAtIso: ["2026-08-22T12:00:00.000Z"] });
  });

  it("returns {} for a missing file", async () => {
    const dir = await newTempDir();
    expect(await readSpawnGateState(dir)).toEqual({});
  });

  it("returns {} for a corrupt file rather than throwing in the gate", async () => {
    const dir = await newTempDir();
    await writeSpawnGateState(dir, {});
    const { writeFile } = await import("node:fs/promises");
    const { spawnGateStatePath } = await import("../../../src/hooks/spawn-gate.js");
    await writeFile(spawnGateStatePath(dir), "{ not json", "utf8");
    expect(await readSpawnGateState(dir)).toEqual({});
  });
});
