/**
 * R4.4 — draft → judge → revise loop. Verifies the judge gates revision on
 * real (high/medium) issues, caps at one cycle, and degrades to the original
 * draft on any failure (never throws — the draft already succeeded).
 */

import { describe, expect, it } from "vitest";
import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  HardwareTier,
  InferenceService,
  Role,
  Vector,
} from "../../../src/interfaces/index.js";
import { HardwareTier as Tier } from "../../../src/interfaces/index.js";
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
    if (impl === undefined) throw new Error(`no scripted response for role ${role}`);
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

describe("refineDraft (R4.4)", () => {
  it("revises when the judge flags a high/medium issue, returning the revised text", async () => {
    const inference = new ScriptedInference({
      judge: () =>
        chatResult(
          critique({
            hasIssues: true,
            summary: "off-by-one in the loop bound",
            issues: [{ severity: "high", description: "loop should be <= n" }],
          }),
          "judge",
        ),
      drafter: () => chatResult("REVISED CODE", "drafter"),
    });

    const out = await refineDraft(inference, "sum 1..n", "DRAFT CODE");
    expect(out.rounds).toBe(1);
    expect(out.text).toBe("REVISED CODE");
    expect(out.critiqueSummary).toBe("off-by-one in the loop bound");
    expect(out.issues?.[0]?.severity).toBe("high");
    // judge then drafter — one revision cycle only.
    expect(inference.calls.map((c) => c.role)).toStrictEqual(["judge", "drafter"]);
  });

  it("keeps the draft unchanged when the judge finds no issues", async () => {
    const inference = new ScriptedInference({
      judge: () =>
        chatResult(critique({ hasIssues: false, summary: "looks good", issues: [] }), "judge"),
      drafter: () => chatResult("SHOULD NOT BE CALLED", "drafter"),
    });

    const out = await refineDraft(inference, "task", "DRAFT");
    expect(out.rounds).toBe(0);
    expect(out.text).toBe("DRAFT");
    expect(inference.calls.map((c) => c.role)).toStrictEqual(["judge"]);
  });

  it("does not revise for low-severity-only issues", async () => {
    const inference = new ScriptedInference({
      judge: () =>
        chatResult(
          critique({
            hasIssues: true,
            summary: "minor style",
            issues: [{ severity: "low", description: "rename a var" }],
          }),
          "judge",
        ),
      drafter: () => chatResult("SHOULD NOT BE CALLED", "drafter"),
    });

    const out = await refineDraft(inference, "task", "DRAFT");
    expect(out.rounds).toBe(0);
    expect(out.text).toBe("DRAFT");
    expect(inference.calls.map((c) => c.role)).toStrictEqual(["judge"]);
  });

  it("degrades to the original draft when the judge returns malformed JSON", async () => {
    const inference = new ScriptedInference({
      judge: () => chatResult("not json at all", "judge"),
    });
    const out = await refineDraft(inference, "task", "DRAFT");
    expect(out).toStrictEqual({ text: "DRAFT", rounds: 0 });
  });

  it("degrades to the original draft when the judge call throws", async () => {
    const inference = new ScriptedInference({
      judge: () => {
        throw new Error("model unreachable");
      },
    });
    const out = await refineDraft(inference, "task", "DRAFT");
    expect(out).toStrictEqual({ text: "DRAFT", rounds: 0 });
  });

  it("keeps the draft when the revision comes back empty", async () => {
    const inference = new ScriptedInference({
      judge: () =>
        chatResult(
          critique({
            hasIssues: true,
            summary: "broken",
            issues: [{ severity: "high", description: "does not compile" }],
          }),
          "judge",
        ),
      drafter: () => chatResult("   ", "drafter"),
    });
    const out = await refineDraft(inference, "task", "DRAFT");
    expect(out.rounds).toBe(0);
    expect(out.text).toBe("DRAFT");
  });
});
