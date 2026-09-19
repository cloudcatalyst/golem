/**
 * R9.4 / R14.2 — the tool-worker registry, now sourced from config.
 *
 * The map shape (`inference.worker_targets`) buys extensibility at the price of
 * per-key schema validation, so the thing worth testing is that the price is
 * actually paid back: an unknown key is REPORTED rather than silently ignored.
 *
 * R14.2 moved the source of "which workers exist" from a compile-time
 * `KNOWN_WORKERS` literal to `inference.personas`. These tests exist to prove
 * the honesty property survived that move — the roster is open now, so a typo'd
 * key is easier to write and matters more.
 *
 * R14.3 retired `worker_targets` — worker lane now reads `personas[worker].model`
 * directly. Tests updated to reflect this.
 */

import { describe, expect, it } from "vitest";
import type { PersonaConfig } from "../../../src/inference/personas.js";
import {
  declaredWorkers,
  isKnownWorker,
  unknownWorkerWarnings,
  workerTarget,
} from "../../../src/inference/workers.js";

/** A project that declares the shipped bench with worker models. */
const bench: Readonly<Record<string, PersonaConfig>> = {
  coder: { discipline: "code", model: "openrouter-qwen3" },
  reviewer: { discipline: "review" },
  scribe: { discipline: "write" },
};

describe("declaredWorkers", () => {
  it("is the project's roster, in stable order — not a compile-time list", () => {
    expect(declaredWorkers(bench)).toEqual(["coder", "reviewer", "scribe"]);
  });

  it("grows with config, which is the whole point of R14.2", () => {
    // Before R14.2 this required a Golem release.
    expect(declaredWorkers({ ...bench, migrator: { discipline: "code" } })).toContain("migrator");
  });

  it("is empty when nothing is declared", () => {
    expect(declaredWorkers({})).toEqual([]);
    expect(declaredWorkers(undefined)).toEqual([]);
  });
});

describe("isKnownWorker", () => {
  it("knows a declared persona", () => {
    expect(isKnownWorker("coder", bench)).toBe(true);
    expect(isKnownWorker("scribe", bench)).toBe(true);
  });

  it("does not invent workers the project has not declared", () => {
    expect(isKnownWorker("writer", bench)).toBe(false);
    expect(isKnownWorker("codr", bench)).toBe(false);
  });
});

describe("workerTarget", () => {
  it("resolves a declared worker's target from personas", () => {
    expect(workerTarget(undefined, "coder", bench)).toBe("openrouter-qwen3");
  });

  it("is undefined when persona has no model", () => {
    expect(workerTarget(undefined, "reviewer", bench)).toBeUndefined();
    expect(workerTarget(undefined, "scribe", bench)).toBeUndefined();
  });

  it("is undefined when worker is not declared", () => {
    expect(workerTarget(undefined, "writer", bench)).toBeUndefined();
  });

  it("routes a persona the project added itself", () => {
    const withMigrator = { ...bench, migrator: { discipline: "code", model: "openrouter-qwen3" } };
    expect(workerTarget(undefined, "migrator", withMigrator)).toBe("openrouter-qwen3");
  });
});

describe("unknownWorkerWarnings", () => {
  it("reports a key naming no declared persona, listing the ones that exist", () => {
    const warnings = unknownWorkerWarnings({ coder: "a", wrtier: "b" }, bench);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("wrtier");
    expect(warnings[0]).toContain("coder");
  });

  it("points at the fix, which is now a config edit rather than a release", () => {
    const warnings = unknownWorkerWarnings({ writer: "b" }, bench);
    expect(warnings[0]).toContain("inference.personas.writer");
  });

  it("is silent on a sound map", () => {
    expect(unknownWorkerWarnings({ coder: "a" }, bench)).toEqual([]);
    expect(unknownWorkerWarnings({}, bench)).toEqual([]);
    expect(unknownWorkerWarnings(undefined, bench)).toEqual([]);
  });

  it("reports every key when the project declares nothing at all", () => {
    const warnings = unknownWorkerWarnings({ coder: "a" }, {});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("(none)");
  });
});
