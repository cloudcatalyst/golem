/**
 * R5.4 — the gate decision matrix + its default-deny invariants (ADR-0002).
 */

import { describe, expect, it } from "vitest";
import type { ActionClass, AutonomyLevel } from "../../../src/autonomy/index.js";
import { decideGate, decidePermissionRequest } from "../../../src/autonomy/index.js";

const LEVELS: AutonomyLevel[] = ["manual", "assisted", "outcome"];

describe("decideGate matrix", () => {
  it("manual auto-approves nothing (all silent except never-auto set)", () => {
    expect(decideGate("manual", "read").emit).toBeNull();
    expect(decideGate("manual", "write").emit).toBeNull();
    expect(decideGate("manual", "unknown").emit).toBeNull();
  });

  it("assisted auto-allows reads only", () => {
    expect(decideGate("assisted", "read").emit).toBe("allow");
    expect(decideGate("assisted", "write").emit).toBeNull();
    expect(decideGate("assisted", "unknown").emit).toBeNull();
  });

  it("outcome auto-allows reads and writes, gates unknown", () => {
    expect(decideGate("outcome", "read").emit).toBe("allow");
    expect(decideGate("outcome", "write").emit).toBe("allow");
    expect(decideGate("outcome", "unknown").emit).toBe("ask");
  });
});

describe("default-deny invariants", () => {
  it("NEVER auto-allows destructive or outward at any level", () => {
    for (const level of LEVELS) {
      for (const action of ["destructive", "outward"] as ActionClass[]) {
        const d = decideGate(level, action);
        expect(d.emit).toBe("ask"); // mandatory human approval
        expect(d.emit).not.toBe("allow");
      }
    }
  });

  it("only ever emits allow for read/write, never for unknown/destructive/outward", () => {
    for (const level of LEVELS) {
      for (const action of [
        "read",
        "write",
        "destructive",
        "outward",
        "unknown",
      ] as ActionClass[]) {
        const d = decideGate(level, action);
        if (d.emit === "allow") expect(["read", "write"]).toContain(action);
      }
    }
  });

  it("gated decisions carry a reason", () => {
    expect(decideGate("outcome", "destructive").reason).toMatch(/destructive/i);
    expect(decideGate("manual", "outward").reason).toMatch(/reverse|approval/i);
  });
});

describe("decidePermissionRequest (R12.12)", () => {
  it("denies exactly the never-auto set", () => {
    expect(decidePermissionRequest("destructive")?.behavior).toBe("deny");
    expect(decidePermissionRequest("outward")?.behavior).toBe("deny");
  });

  it("defers everything else — including `unknown`", () => {
    expect(decidePermissionRequest("read")).toBeNull();
    expect(decidePermissionRequest("write")).toBeNull();
    // `unknown` earns an `ask` at PreToolUse (fail-closed = make the human
    // decide). Denying it here would decide FOR them, one event earlier.
    expect(decidePermissionRequest("unknown")).toBeNull();
  });

  it("never returns a behavior other than deny", () => {
    for (const action of ["read", "write", "destructive", "outward", "unknown"] as ActionClass[]) {
      const d = decidePermissionRequest(action);
      if (d !== null) expect(d.behavior).toBe("deny");
    }
  });

  it("quotes the same reason text decideGate puts on the ask", () => {
    for (const action of ["destructive", "outward"] as ActionClass[]) {
      for (const level of LEVELS) {
        expect(decidePermissionRequest(action)?.message).toBe(decideGate(level, action).reason);
      }
    }
  });
});
