/**
 * R8.18 — model selection is fit-for-hardware AND fit-for-purpose.
 *
 * The rule worth pinning hardest: **active parameters, not file size, set the speed.**
 * A 19 GB MoE with 3B active must outrank an 8 GB dense 14B on a machine with the RAM
 * to hold it. Sorting a model catalog by download size is the intuitive mistake, and
 * these tests exist to make it a failing one.
 */

import { describe, expect, it } from "vitest";
import {
  estimatedResidentBytes,
  GGUF_CATALOG,
  ggufModel,
  huggingFaceUrl,
  modelBytes,
  rankModels,
  selectModel,
} from "../../../src/inference/gguf-catalog.js";

const GB = 1024 ** 3;

/**
 * Budgets are *usable RAM after headroom*, and the KV cache is charged on top of the
 * weights — at 16K tokens that is a further 1 GB, which is exactly the sort of margin
 * the old per-1K estimate lost.
 */
/** The machine that motivated the task: 64 GB total, ~34 GB actually free. */
const ROOMY = 28 * GB;
/** A 16 GB laptop with an editor and a browser open: fits a 14B, not a 35B. */
const TIGHT = 12 * GB;
/** Barely anything spare. */
const CRAMPED = 2 * GB;

describe("catalog integrity", () => {
  it("has unique ids and at least one weights file each", () => {
    const ids = GGUF_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of GGUF_CATALOG) {
      expect(m.files.some((f) => f.kind === "weights")).toBe(true);
      expect(modelBytes(m)).toBeGreaterThan(0);
    }
  });

  it("never claims a dense model has fewer active parameters than it has", () => {
    for (const m of GGUF_CATALOG) {
      if (!m.moe) expect(m.activeParamsB).toBe(m.paramsB);
      else expect(m.activeParamsB).toBeLessThan(m.paramsB);
    }
  });

  it("builds a resolve URL from the repo and file path", () => {
    const m = ggufModel("qwen3.6-35b-a3b-q4");
    expect(m).toBeDefined();
    if (m === undefined) return;
    const weights = m.files[0];
    expect(weights).toBeDefined();
    if (weights === undefined) return;
    expect(huggingFaceUrl(m, weights)).toBe(
      "https://huggingface.co/ggml-org/Qwen3.6-35B-A3B-GGUF/resolve/main/Qwen3.6-35B-A3B-Q4_K_M.gguf?download=true",
    );
  });
});

describe("estimatedResidentBytes", () => {
  it("counts weights and the draft model but not the vision projector", () => {
    const plain = ggufModel("qwen3.6-35b-a3b-q4");
    const vision = ggufModel("qwen3.6-35b-a3b-q4-vision");
    expect(plain && vision).toBeTruthy();
    if (plain === undefined || vision === undefined) return;
    // The projector is loaded per image, not held for the session, so the two must
    // budget identically — otherwise enabling vision would spuriously fail a fit check.
    expect(estimatedResidentBytes(vision, 16384)).toBe(estimatedResidentBytes(plain, 16384));
  });

  it("grows with the context window", () => {
    const m = ggufModel("qwen3-14b-q4");
    expect(m).toBeDefined();
    if (m === undefined) return;
    expect(estimatedResidentBytes(m, 131072)).toBeGreaterThan(estimatedResidentBytes(m, 8192));
  });
});

describe("selectModel — fit for hardware", () => {
  it("picks the 35B MoE on a roomy machine, over the smaller dense models", () => {
    const choice = selectModel({ role: "drafter", usableRamBytes: ROOMY, contextTokens: 16384 });
    expect(choice?.model.id).toBe("qwen3.6-35b-a3b-q4");
    // The claim the whole catalog rests on, stated in the reason a human reads.
    expect(choice?.reason).toContain("only 3B active per token");
  });

  it("falls back to a dense model that fits when the MoE does not", () => {
    const choice = selectModel({ role: "drafter", usableRamBytes: TIGHT, contextTokens: 16384 });
    expect(choice?.model.id).toBe("qwen3-14b-q4");
  });

  it("returns undefined rather than recommending something that would swap", () => {
    // "No local model is appropriate right now" is an honest answer; loading a model
    // that swaps is slower than not loading it.
    expect(
      selectModel({ role: "drafter", usableRamBytes: CRAMPED, contextTokens: 16384 }),
    ).toBeUndefined();
  });

  it("still serves the cheap roles on a cramped machine", () => {
    const choice = selectModel({
      role: "classifier",
      usableRamBytes: CRAMPED,
      contextTokens: 8192,
    });
    expect(choice?.model.id).toBe("qwen3-1.7b-q4");
  });

  it("shrinks the eligible set as the context window grows", () => {
    const small = rankModels({ role: "drafter", usableRamBytes: 20 * GB, contextTokens: 8192 });
    const huge = rankModels({ role: "drafter", usableRamBytes: 20 * GB, contextTokens: 262144 });
    expect(huge.length).toBeLessThan(small.length);
  });
});

describe("selectModel — fit for purpose", () => {
  it("prefers fewest active parameters for speed", () => {
    const choice = selectModel({
      role: "drafter",
      usableRamBytes: ROOMY,
      contextTokens: 16384,
      prefer: "speed",
    });
    expect(choice?.model.activeParamsB).toBe(3);
  });

  it("prefers the most capable model that fits, for quality", () => {
    const choice = selectModel({
      role: "drafter",
      usableRamBytes: ROOMY,
      contextTokens: 16384,
      prefer: "quality",
    });
    // Not the Q8 — 36 GB of weights does not fit in 28 GB usable.
    expect(choice?.model.id).toBe("qwen3.6-35b-a3b-q4");
  });

  it("never recommends an unproven entry, however well it scores", () => {
    // Qwen3-Coder-Next is 80B at 3B active and fits at IQ2, so on a raw proxy it wins
    // outright — which is precisely why `proven: false` has to gate it. Its own
    // catalog note calls IQ2 "a measurement to run, not a default to assume".
    const req = {
      role: "drafter",
      usableRamBytes: ROOMY,
      contextTokens: 16384,
      prefer: "quality",
    } as const;
    expect(rankModels(req).some((c) => c.model.id === "qwen3-coder-next-iq2m")).toBe(false);
    const opened = rankModels({ ...req, includeUnproven: true });
    expect(opened[0]?.model.id).toBe("qwen3-coder-next-iq2m");
  });

  it("discounts a heavily-quantised model's capability, and says so", () => {
    const opened = rankModels({
      role: "drafter",
      usableRamBytes: ROOMY,
      contextTokens: 16384,
      prefer: "quality",
      includeUnproven: true,
    });
    const iq2 = opened.find((c) => c.model.id === "qwen3-coder-next-iq2m");
    expect(iq2?.reason).toContain("discounts that capability materially");
    const q4 = opened.find((c) => c.model.id === "qwen3.6-35b-a3b-q4");
    expect(q4?.reason).not.toContain("discounts that capability");
  });

  it("never returns a model that does not serve the requested role", () => {
    for (const prefer of ["speed", "balanced", "quality"] as const) {
      const choice = selectModel({
        role: "judge",
        usableRamBytes: ROOMY,
        contextTokens: 16384,
        prefer,
      });
      expect(choice?.model.roles).toContain("judge");
    }
  });

  it("only offers a vision-capable model when vision is required", () => {
    const choice = selectModel({
      role: "drafter",
      usableRamBytes: ROOMY,
      contextTokens: 16384,
      needsVision: true,
    });
    expect(choice?.model.files.some((f) => f.kind === "mmproj")).toBe(true);
  });

  it("ranks every fitting candidate so the runners-up can be shown", () => {
    const ranked = rankModels({ role: "drafter", usableRamBytes: ROOMY, contextTokens: 16384 });
    expect(ranked.length).toBeGreaterThan(2);
    expect(ranked.every((c) => c.reason !== "")).toBe(true);
  });
});
