/**
 * R14.6 — the delegation ledger and the close-out gate it feeds.
 *
 * The gate exists because a delegated model is good at the SHAPE of the work and
 * unreliable on its SPECIFICS: three runs during R14.1 produced seven factual
 * errors between them, all fluent. So the properties worth testing are the ones
 * that stop the gate being ceremonial — it must not expire, it must not report
 * success for a no-op, and waiving must leave a reason behind.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  appendDelegation,
  type DelegationLedger,
  delegationLedgerPath,
  markReviewed,
  readDelegationLedger,
  unreviewedDelegations,
  unreviewedRefusal,
  waiveReview,
  writeDelegationLedger,
} from "../../../src/hooks/delegation-ledger.js";
import { useTempDirs } from "../../helpers/tmp.js";

let projectDir: string;
const newTempDir = useTempDirs("golem-delegations-");

beforeEach(async () => {
  projectDir = await newTempDir();
});

const EMPTY: DelegationLedger = { delegations: [] };
const NOW = "2026-08-30T12:00:00.000Z";
const LATER = "2026-08-30T13:00:00.000Z";

describe("appendDelegation", () => {
  it("records what was dispatched, with a usable id", () => {
    const ledger = appendDelegation(EMPTY, { at: NOW, agentType: "golem-scribe" });
    expect(ledger.delegations).toHaveLength(1);
    expect(ledger.delegations[0]?.agentType).toBe("golem-scribe");
    expect(ledger.delegations[0]?.id).toContain("golem-scribe");
  });

  it("gives each delegation a distinct id", () => {
    let ledger = appendDelegation(EMPTY, { at: NOW, agentType: "golem-scribe" });
    ledger = appendDelegation(ledger, { at: NOW, agentType: "golem-scribe" });
    expect(ledger.delegations[0]?.id).not.toBe(ledger.delegations[1]?.id);
  });
});

describe("unreviewedDelegations", () => {
  it("counts a fresh delegation as owing a review", () => {
    const ledger = appendDelegation(EMPTY, { at: NOW, agentType: "golem-coder" });
    expect(unreviewedDelegations(ledger)).toHaveLength(1);
  });

  it("does NOT expire — an obligation cannot be waited out", () => {
    // The headroom ledger prunes on a 6h TTL because it answers a different
    // question. A review gate that expired would simply be outlasted, which is
    // the one failure mode a gate must not have.
    const ancient = { delegations: [{ id: "x", at: "2020-01-01T00:00:00.000Z", agentType: "a" }] };
    expect(unreviewedDelegations(ancient)).toHaveLength(1);
  });

  it("is empty once reviewed", () => {
    const ledger = appendDelegation(EMPTY, { at: NOW, agentType: "golem-coder" });
    const { ledger: after } = markReviewed(ledger, LATER);
    expect(unreviewedDelegations(after)).toEqual([]);
  });

  it("is empty once waived", () => {
    const ledger = appendDelegation(EMPTY, { at: NOW, agentType: "golem-coder" });
    const { ledger: after } = waiveReview(ledger, LATER, "trivial rename");
    expect(unreviewedDelegations(after)).toEqual([]);
  });
});

describe("markReviewed", () => {
  it("reports how many it actually changed, so a no-op cannot look like success", () => {
    expect(markReviewed(EMPTY, LATER).changed).toBe(0);
  });

  it("marks only the named delegation", () => {
    let ledger = appendDelegation(EMPTY, { at: NOW, agentType: "golem-coder" });
    ledger = appendDelegation(ledger, { at: NOW, agentType: "golem-scribe" });
    const target = ledger.delegations[0]?.id as string;
    const { ledger: after, changed } = markReviewed(ledger, LATER, target);
    expect(changed).toBe(1);
    expect(unreviewedDelegations(after)).toHaveLength(1);
    expect(unreviewedDelegations(after)[0]?.agentType).toBe("golem-scribe");
  });

  it("marks every outstanding one when no id is given", () => {
    let ledger = appendDelegation(EMPTY, { at: NOW, agentType: "a" });
    ledger = appendDelegation(ledger, { at: NOW, agentType: "b" });
    expect(markReviewed(ledger, LATER).changed).toBe(2);
  });

  it("does not re-mark something already reviewed", () => {
    const ledger = appendDelegation(EMPTY, { at: NOW, agentType: "a" });
    const first = markReviewed(ledger, LATER);
    expect(markReviewed(first.ledger, LATER).changed).toBe(0);
  });
});

describe("waiveReview", () => {
  it("records the reason — a waiver without one leaves no account of itself", () => {
    const ledger = appendDelegation(EMPTY, { at: NOW, agentType: "a" });
    const { ledger: after } = waiveReview(ledger, LATER, "output discarded");
    expect(after.delegations[0]?.waivedAt).toBe(LATER);
    expect(after.delegations[0]?.waivedReason).toBe("output discarded");
  });
});

describe("unreviewedRefusal", () => {
  it("names each outstanding run and how to clear it", () => {
    const ledger = appendDelegation(EMPTY, {
      at: NOW,
      agentType: "golem-scribe",
      description: "write the debrief",
    });
    const msg = unreviewedRefusal(unreviewedDelegations(ledger));
    expect(msg).toContain("golem-scribe");
    expect(msg).toContain("write the debrief");
    expect(msg).toContain("golem task review");
    expect(msg).toContain("--waive");
  });
});

describe("persistence", () => {
  it("round-trips through disk", async () => {
    const ledger = appendDelegation(EMPTY, { at: NOW, agentType: "golem-coder" });
    await writeDelegationLedger(projectDir, ledger);
    expect(await readDelegationLedger(projectDir)).toEqual(ledger);
  });

  it("treats a missing ledger as empty rather than an error", async () => {
    // Read from a hook on the critical path of every spawn — failing there would
    // break the session over a bookkeeping file.
    expect(await readDelegationLedger(projectDir)).toEqual(EMPTY);
  });

  it("treats a corrupt ledger as empty rather than an error", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const file = delegationLedgerPath(projectDir);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{not json", "utf8");
    expect(await readDelegationLedger(projectDir)).toEqual(EMPTY);
  });
});
