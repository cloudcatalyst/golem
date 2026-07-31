/**
 * R8.7 — the harness's own calibration.
 *
 * This instrument decides whether a local model may ever edit a file, so a
 * miscalibration here is worse than a bug in a feature. Three properties carry
 * the verdict and are pinned hardest:
 *
 *  - the bar is **pre-registered** ({@link EDIT_BAR}) and applied to the
 *    *semantic* rate, not the apply rate that `whole` wins by construction;
 *  - a model error is excluded from the rates AND cannot be the reason a bar was
 *    cleared — the adverse-case guard turns that into `inconclusive`;
 *  - identical per-case outcomes across formats are reported as an insensitive
 *    instrument, the §100 failure mode, not as "format does not matter".
 *
 * The fake inference service replies deterministically per case, so the numbers
 * below are arithmetic, not sampling.
 */

import { describe, expect, it } from "vitest";
import type {
  ChatMessage,
  ChatResult,
  InferenceService,
  Role,
  Vector,
} from "../../../src/interfaces/index.js";
import { benchEdits, EDIT_BAR, EDIT_CASES, renderEditBench } from "../../../src/tools/index.js";

/** A stub that answers with whatever the test dictates for that case id. */
function fakeInference(reply: (caseId: string) => string | Error): InferenceService {
  return {
    async chat(role: Role, messages: readonly ChatMessage[]): Promise<ChatResult> {
      const user = String(messages[messages.length - 1]?.content ?? "");
      const testCase = EDIT_CASES.find((c) => user.includes(c.instruction));
      const answer = reply(testCase?.id ?? "unknown");
      if (answer instanceof Error) throw answer;
      return {
        text: answer,
        model: "fake-editor:0b",
        role,
        promptTokens: 0,
        completionTokens: 0,
        finishReason: "stop",
      };
    },
    async embed(): Promise<Vector[]> {
      return [];
    },
    capabilities() {
      return 2;
    },
  };
}

/** The hand-written edit, replayed as a whole-file reply: a perfect editor. */
function perfectWholeReply(caseId: string): string {
  const testCase = EDIT_CASES.find((c) => c.id === caseId);
  if (testCase === undefined) return "nothing";
  return `${testCase.path}\n\`\`\`\n${testCase.expected.replace(/\n$/u, "")}\n\`\`\`\n`;
}

describe("benchEdits verdict", () => {
  it("ships when a format clears both pre-registered thresholds", async () => {
    const report = await benchEdits({
      inference: fakeInference(perfectWholeReply),
      cases: EDIT_CASES,
      formats: ["whole"],
    });
    const run = report.runs[0];
    expect(run?.complianceRate).toBe(1);
    expect(run?.applyRate).toBe(1);
    expect(run?.semanticRate).toBe(1);
    expect(run?.exactRate).toBe(1);
    expect(report.verdict).toBe("ship");
    expect(report.best).toBe("whole");
  });

  it("rejects when nothing is in the requested format", async () => {
    const report = await benchEdits({
      inference: fakeInference(() => "I would change the third line."),
      cases: EDIT_CASES,
      formats: ["search-replace"],
    });
    expect(report.runs[0]?.complianceRate).toBe(0);
    expect(report.runs[0]?.semanticRate).toBe(0);
    expect(report.verdict).toBe("reject");
    expect(report.notes.join(" ")).toContain("NOT in the requested format");
  });

  it("lands on advisory-only between the two thresholds", async () => {
    // Half the cases get the human's edit; half get prose.
    const half = new Set(EDIT_CASES.filter((_, i) => i % 2 === 0).map((c) => c.id));
    const report = await benchEdits({
      inference: fakeInference((id) => (half.has(id) ? perfectWholeReply(id) : "no idea")),
      cases: EDIT_CASES,
      formats: ["whole"],
    });
    const semantic = report.runs[0]?.semanticRate ?? 0;
    expect(semantic).toBeGreaterThanOrEqual(EDIT_BAR.advisorySemantic);
    expect(semantic).toBeLessThan(EDIT_BAR.shipSemantic);
    expect(report.verdict).toBe("advisory-only");
  });

  it("excludes model errors from the rates and says they cannot flip the verdict", async () => {
    const first = EDIT_CASES[0]?.id;
    const report = await benchEdits({
      inference: fakeInference((id) =>
        id === first ? new Error("endpoint down") : perfectWholeReply(id),
      ),
      cases: EDIT_CASES,
      formats: ["whole"],
    });
    const run = report.runs[0];
    expect(run?.errors).toBe(1);
    expect(run?.scored).toBe(EDIT_CASES.length - 1);
    expect(run?.semanticRate).toBe(1);
    expect(report.verdict).toBe("ship");
    expect(report.notes.join(" ")).toContain("cannot flip this");
  });

  it("goes inconclusive when the excluded errors could have changed the verdict", async () => {
    // Enough errors that scoring them adversarially drops below the ship bar.
    const errored = new Set(EDIT_CASES.slice(0, 4).map((c) => c.id));
    const report = await benchEdits({
      inference: fakeInference((id) =>
        errored.has(id) ? new Error("endpoint down") : perfectWholeReply(id),
      ),
      cases: EDIT_CASES,
      formats: ["whole"],
    });
    expect(report.runs[0]?.semanticRate).toBe(1);
    expect(report.verdict).toBe("inconclusive");
    expect(report.notes.join(" ")).toContain("worst possible way");
  });

  it("is inconclusive, not a pass, when the model is unreachable everywhere", async () => {
    const report = await benchEdits({
      inference: fakeInference(() => new Error("connection refused")),
      cases: EDIT_CASES,
      formats: ["whole", "udiff"],
    });
    expect(report.verdict).toBe("inconclusive");
    expect(report.notes.join(" ")).toContain("local model reachable");
  });

  it("flags an insensitive instrument when every format scores case-for-case alike", async () => {
    const report = await benchEdits({
      inference: fakeInference(() => "prose, in no format at all"),
      cases: EDIT_CASES,
    });
    expect(report.notes.join(" ")).toContain("IDENTICAL per-case outcomes");
  });

  it("reports cost beside accuracy, and prints the bar it was judged against", async () => {
    const report = await benchEdits({
      inference: fakeInference(perfectWholeReply),
      cases: EDIT_CASES,
      formats: ["whole"],
    });
    expect(report.meanInstructionTokens).toBeGreaterThan(0);
    expect(report.meanExpectedEditTokens).toBeGreaterThan(report.meanInstructionTokens);
    const text = renderEditBench(report);
    expect(text).toContain("pre-registered bar");
    expect(text).toContain("output tokens");
    expect(text).toContain("fake-editor:0b");
  });
});
