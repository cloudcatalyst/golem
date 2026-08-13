/**
 * R10.7 — a tier may never pair two embedders of DIFFERENT vector widths.
 *
 * `KnowledgeBase.ingest` embeds text chunks and code chunks separately, by kind,
 * and stores both in the SAME collection. `FileVectorDriver.upsert` resets the
 * whole collection whenever an incoming vector's width differs from the stored
 * one. So a tier whose `textEmbed` and `codeEmbed` disagree on width makes a
 * repo containing both prose and code thrash: each kind wipes the other's
 * vectors and re-embeds, forever.
 *
 * Tier P_MIN did exactly that (bge-m3/1024 for text, nomic-embed-text/768 for
 * code) and nobody noticed, because it is the least-exercised tier and the
 * symptom is a silent re-index rather than an error. Pairing P_MIN fixed the
 * instance; this fixes the class — the next tier added, or the next model
 * swapped, cannot reintroduce it without failing here.
 *
 * The rule is about WIDTH, not identity: two different models of the same width
 * would be unusual but harmless to the driver, so this asserts what actually
 * matters rather than the stricter thing that happens to be true today.
 */

import { describe, expect, it } from "vitest";
import { embedDimFor, embedModelFor } from "../../../src/inference/index.js";
import { HardwareTier } from "../../../src/interfaces/inference.js";

/**
 * Derived from the enum rather than listed, so a tier added tomorrow is covered
 * without anyone remembering to add it here.
 */
const ALL_TIERS = Object.values(HardwareTier);

describe("tier embedder widths", () => {
  it("pairs text and code embedders of the SAME width on every tier", () => {
    const mismatched = ALL_TIERS.map((tier) => {
      const text = embedModelFor(tier, "text");
      const code = embedModelFor(tier, "code");
      return { tier, text, code, textDim: embedDimFor(text), codeDim: embedDimFor(code) };
    }).filter((row) => row.textDim !== row.codeDim);

    expect(mismatched).toEqual([]);
  });

  it("knows the width of every embedder the catalog names", () => {
    // Guards the test above from passing vacuously: `embedDimFor` returns null
    // for a model it does not recognise, and null === null would make a
    // mismatched pair of UNKNOWN models look fine.
    for (const tier of ALL_TIERS) {
      for (const kind of ["text", "code"] as const) {
        const model = embedModelFor(tier, kind);
        expect(
          embedDimFor(model),
          `${tier} ${kind} embedder "${model}" has no known width`,
        ).toEqual(expect.any(Number));
      }
    }
  });
});
