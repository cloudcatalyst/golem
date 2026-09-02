/**
 * R14.2 — which LANE staffs a persona.
 *
 * The tests that matter are about the AMBIGUITY, exactly as R13.12's were:
 * `claude-sonnet-5` and `cheap` are both bare words, and reading a declared
 * target's id as a model name would send work somewhere the user did not choose
 * while reporting success.
 *
 * What R14.2 adds on top is that the ROSTER is open, so "undeclared" is now a
 * state the resolver has to have an answer for.
 */

import { describe, expect, it } from "vitest";
import {
  PersonaLaneError,
  personaLaneConflict,
  resolvePersonaLane,
} from "../../../src/inference/persona-lane.js";
import type { PersonaConfig } from "../../../src/inference/personas.js";
import type { TargetRegistrySettings } from "../../../src/providers/index.js";

const SETTINGS: TargetRegistrySettings = {
  upstream_provider: "anthropic",
  upstream_base_url: "https://api.anthropic.com",
  upstream_auth_scheme: "inherit",
  gateways: [
    {
      id: "openrouter",
      provider: "openrouter",
      base_url: "https://openrouter.ai/api/v1",
      models: ["qwen/qwen3.7-flash"],
    },
  ],
  targets: [
    { id: "cheap", gateway: "openrouter", model: "qwen/qwen3.7-flash", trust: "third-party" },
  ],
};

const lane = (
  personas: Readonly<Record<string, PersonaConfig>>,
  id: string,
  workerTargets?: Record<string, string>,
) =>
  resolvePersonaLane({
    settings: SETTINGS,
    personas,
    personaId: id,
    ...(workerTargets === undefined ? {} : { workerTargets }),
  });

describe("the two lanes", () => {
  it("reads a MODEL id as the agent lane — the harness runs a subagent", () => {
    expect(lane({ coder: { model: "claude-sonnet-5" } }, "coder")).toEqual({
      kind: "agent",
      model: "claude-sonnet-5",
    });
  });

  it("reads a declared TARGET id as the worker lane — Golem dispatches it itself", () => {
    // The weak-model path: a 4B model cannot drive an agent loop, so it gets a
    // bounded single-shot instead.
    expect(lane({ triage: { model: "cheap" } }, "triage")).toEqual({
      kind: "worker",
      targetId: "cheap",
      via: "persona",
    });
  });

  it("prefers a TARGET over a model when the bare word is both-shaped", () => {
    // Declaring a target is a deliberate act; silently reading its id as a model
    // name would send the work somewhere the user did not choose.
    expect(lane({ coder: { model: "cheap" } }, "coder")).toMatchObject({ kind: "worker" });
  });

  it("resolves a bare GATEWAY id to that gateway's first target", () => {
    // Consistent with `default_target` (R9.23) — the same string must not mean
    // two different things in two adjacent settings.
    // The gateway's first target is the one `listTargets` synthesises from its
    // `models` array, not the separately-declared `cheap` — which is what
    // "first target" means here.
    expect(lane({ coder: { model: "openrouter" } }, "coder")).toEqual({
      kind: "worker",
      targetId: "openrouter:qwen/qwen3.7-flash",
      via: "persona",
    });
  });
});

describe("unstaffed", () => {
  it("is undeclared when the persona does not exist", () => {
    expect(lane({}, "ghost")).toEqual({ kind: "unstaffed", reason: "undeclared" });
  });

  it("is no-model when declared without one — it declines rather than guessing", () => {
    expect(lane({ scribe: { discipline: "write" } }, "scribe")).toEqual({
      kind: "unstaffed",
      reason: "no-model",
    });
  });

  it("refuses to dispatch a human-owned role even when it names a model", () => {
    // The permission axis outranks staffing, wherever it is checked.
    expect(lane({ releaser: { model: "claude-sonnet-5", owner: "user" } }, "releaser")).toEqual({
      kind: "unstaffed",
      reason: "owner-user",
    });
  });
});

describe("fail-closed", () => {
  it("raises on a colon-shaped id that resolves to no target, naming both sets", () => {
    // Far more likely a typo'd target than a model called `openrouter:qwn/...`,
    // and treating it as a model would generate a definition naming a model that
    // does not exist.
    expect(() => lane({ coder: { model: "openrouter:qwn/typo" } }, "coder")).toThrow(
      PersonaLaneError,
    );
    try {
      lane({ coder: { model: "openrouter:qwn/typo" } }, "coder");
    } catch (err) {
      expect((err as Error).message).toContain("cheap"); // the declared targets
      expect((err as Error).message).toContain("inference.personas.coder.model");
    }
  });

  it("raises on a value that could not be a model id at all", () => {
    expect(() => lane({ coder: { model: "not a model" } }, "coder")).toThrow(PersonaLaneError);
  });
});

describe("worker_targets precedence", () => {
  it("wins over the persona's own model, being the explicit low-level map", () => {
    expect(lane({ coder: { model: "claude-sonnet-5" } }, "coder", { coder: "cheap" })).toEqual({
      kind: "worker",
      targetId: "cheap",
      via: "worker_targets",
    });
  });

  it("does NOT route an undeclared persona — that would make the warning a lie", () => {
    // `unknownWorkerWarnings` says such a key "does nothing". Honouring it here
    // would mean the key both does nothing and sends work somewhere.
    expect(lane({}, "writer", { writer: "cheap" })).toEqual({
      kind: "unstaffed",
      reason: "undeclared",
    });
  });
});

describe("personaLaneConflict", () => {
  it("reports both keys naming different destinations rather than resolving silently", () => {
    const msg = personaLaneConflict({
      settings: SETTINGS,
      personas: { coder: { model: "claude-sonnet-5" } },
      personaId: "coder",
      workerTargets: { coder: "cheap" },
    });
    expect(msg).toContain("worker_targets.coder");
    expect(msg).toContain("personas.coder.model");
    expect(msg).toContain("worker_targets wins");
  });

  it("is silent when they agree, or when only one is set", () => {
    const base = {
      settings: SETTINGS,
      personas: { coder: { model: "cheap" } },
      personaId: "coder",
    };
    expect(personaLaneConflict({ ...base, workerTargets: { coder: "cheap" } })).toBeUndefined();
    expect(personaLaneConflict(base)).toBeUndefined();
  });
});
