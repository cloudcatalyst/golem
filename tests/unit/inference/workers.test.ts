/**
 * R9.4 — the tool-worker registry.
 *
 * The map shape (`inference.worker_targets`) buys extensibility at the price of
 * per-key schema validation, so the thing worth testing is that the price is
 * actually paid back: an unknown key is REPORTED rather than silently ignored.
 */

import { describe, expect, it } from "vitest";
import {
  isKnownWorker,
  KNOWN_WORKERS,
  unknownWorkerWarnings,
  workerTarget,
} from "../../../src/inference/workers.js";

describe("known workers", () => {
  it("knows coder", () => {
    expect(isKnownWorker("coder")).toBe(true);
    expect(KNOWN_WORKERS).toContain("coder");
  });

  it("does not invent workers that do not exist yet", () => {
    // A `writer` is planned but not built; until it is, configuring one must be
    // reported rather than silently accepted.
    expect(isKnownWorker("writer")).toBe(false);
    expect(isKnownWorker("codr")).toBe(false);
  });
});

describe("workerTarget", () => {
  it("resolves a configured worker's target", () => {
    expect(workerTarget({ coder: "openrouter-qwen3" }, "coder")).toBe("openrouter-qwen3");
  });

  it("is undefined when unset, empty, or the map is absent — i.e. use the local model", () => {
    expect(workerTarget(undefined, "coder")).toBeUndefined();
    expect(workerTarget({}, "coder")).toBeUndefined();
    expect(workerTarget({ coder: "" }, "coder")).toBeUndefined();
  });

  it("ignores an unknown worker key rather than throwing", () => {
    // A config typo must not stop the worker that IS configured correctly from
    // working. (An unknown TARGET is different — that fails closed at dispatch,
    // because it would send work somewhere the user did not choose.)
    expect(workerTarget({ writer: "x" }, "writer")).toBeUndefined();
    expect(workerTarget({ writer: "x", coder: "cheap" }, "coder")).toBe("cheap");
  });
});

describe("unknownWorkerWarnings", () => {
  it("reports a key naming no worker, listing the ones that exist", () => {
    const warnings = unknownWorkerWarnings({ coder: "a", wrtier: "b" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("wrtier");
    expect(warnings[0]).toContain("coder");
  });

  it("is silent on a sound map", () => {
    expect(unknownWorkerWarnings({ coder: "a" })).toEqual([]);
    expect(unknownWorkerWarnings({})).toEqual([]);
    expect(unknownWorkerWarnings(undefined)).toEqual([]);
  });
});
