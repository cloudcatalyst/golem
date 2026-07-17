/**
 * R4.4 + LE2 — draft → critique → revise loop. Verifies the judge gates
 * revision on real (high/medium) issues, caps at one cycle, falls back to the
 * drafter as self-reviewer when no judge model is available, and returns an
 * explicit `status` for every no-op (never a silent skip — the LE2 defect).
 */

import { describe, expect, it } from "vitest";
import {
  CapabilityUnavailableError,
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
  type HardwareTier,
  type InferenceService,
  type Role,
  HardwareTier as Tier,
  type Vector,
} from "../../../src/interfaces/index.js";
import { refineDraft } from "../../../src/mcp/coder-refine.js";

/** A scriptable InferenceService: returns queued responses per role, records calls. */
class ScriptedInference implements InferenceService {
  readonly calls: Array<{ role: Role; messages: readonly ChatMessage[] }> = [];
  constructor(
    private readonly byRole: Partial<Record<Role, (n: number) => ChatResult | Promise<ChatResult>>>,
  ) {}
  async chat(
    role: Role,
    messages: readonly ChatMessage[],
    _opts?: ChatOptions,
  ): Promise<ChatResult> {
    const n = this.calls.filter((c) => c.role === role).length;
    this.calls.push({ role, messages });
    const impl = this.byRole[role];
    if (impl === undefined) throw new CapabilityUnavailableError(role, Tier.PMid);
    return impl(n);
  }
  async embed(): Promise<Vector[]> {
    throw new Error("not used");
  }
  capabilities(): HardwareTier {
    return Tier.PMid;
  }
}

function chatResult(text: string, role: Role): ChatResult {
  return { text, model: "fake", role, promptTokens: 1, completionTokens: 1, finishReason: "stop" };
}

function critique(obj: unknown): string {
  return JSON.stringify(obj);
}

const HIGH = {
  hasIssues: true,
  summary: "off-by-one",
  issues: [{ severity: "high", description: "loop bound" }],
};

describe("refineDraft (R4.4 + LE2)", () => {
  it("revises when the judge flags a high/medium issue (status: revised)", async () => {
    const inference = new ScriptedInference({
      judge: () => chatResult(critique(HIGH), "judge"),
      drafter: () => chatResult("REVISED CODE", "drafter"),
    });
    const out = await refineDraft(inference, "sum 1..n", "DRAFT CODE");
    expect(out.rounds).toBe(1);
    expect(out.status).toBe("revised");
    expect(out.text).toBe("REVISED CODE");
    expect(out.critiquedBy).toBe("judge");
    expect(out.critiqueSummary).toBe("off-by-one");
    expect(inference.calls.map((c) => c.role)).toStrictEqual(["judge", "drafter"]);
  });

  it("keeps the draft when the judge finds no issues (status: clean)", async () => {
    const inference = new ScriptedInference({
      judge: () =>
        chatResult(critique({ hasIssues: false, summary: "looks good", issues: [] }), "judge"),
      drafter: () => chatResult("SHOULD NOT BE CALLED", "drafter"),
    });
    const out = await refineDraft(inference, "task", "DRAFT");
    expect(out.rounds).toBe(0);
    expect(out.status).toBe("clean");
    expect(out.text).toBe("DRAFT");
    expect(inference.calls.map((c) => c.role)).toStrictEqual(["judge"]);
  });

  it("does not revise for low-severity-only issues (status: clean)", async () => {
    const inference = new ScriptedInference({
      judge: () =>
        chatResult(
          critique({
            hasIssues: true,
            summary: "nit",
            issues: [{ severity: "low", description: "rename" }],
          }),
          "judge",
        ),
    });
    const out = await refineDraft(inference, "task", "DRAFT");
    expect(out.status).toBe("clean");
    expect(out.rounds).toBe(0);
  });

  it("falls back to the drafter as self-reviewer when the judge model is unavailable", async () => {
    const inference = new ScriptedInference({
      // no `judge` scripted → chat("judge") throws CapabilityUnavailableError
      drafter: (n) => chatResult(n === 0 ? critique(HIGH) : "REVISED", "drafter"),
    });
    const out = await refineDraft(inference, "task", "DRAFT");
    expect(out.status).toBe("revised");
    expect(out.rounds).toBe(1);
    expect(out.text).toBe("REVISED");
    expect(out.critiquedBy).toBe("drafter");
    // judge attempted, then drafter critique + drafter revise.
    expect(inference.calls.map((c) => c.role)).toStrictEqual(["judge", "drafter", "drafter"]);
  });

  it("reports judge-unavailable when neither judge nor drafter can run", async () => {
    const inference = new ScriptedInference({}); // both roles throw CapabilityUnavailableError
    const out = await refineDraft(inference, "task", "DRAFT");
    expect(out.status).toBe("judge-unavailable");
    expect(out.rounds).toBe(0);
    expect(out.text).toBe("DRAFT");
  });

  it("reports unparseable when the critique is not valid JSON", async () => {
    const inference = new ScriptedInference({
      judge: () => chatResult("not json at all", "judge"),
    });
    const out = await refineDraft(inference, "task", "DRAFT");
    expect(out.status).toBe("unparseable");
    expect(out.text).toBe("DRAFT");
    expect(out.critiquedBy).toBe("judge");
  });

  it("reports error when the judge call throws a non-availability error", async () => {
    const inference = new ScriptedInference({
      judge: () => {
        throw new Error("malformed endpoint response");
      },
    });
    const out = await refineDraft(inference, "task", "DRAFT");
    expect(out.status).toBe("error");
    expect(out.text).toBe("DRAFT");
  });

  it("keeps the draft when the revision comes back empty (status: empty-revision)", async () => {
    const inference = new ScriptedInference({
      judge: () => chatResult(critique(HIGH), "judge"),
      drafter: () => chatResult("   ", "drafter"),
    });
    const out = await refineDraft(inference, "task", "DRAFT");
    expect(out.status).toBe("empty-revision");
    expect(out.rounds).toBe(0);
    expect(out.text).toBe("DRAFT");
  });
});
