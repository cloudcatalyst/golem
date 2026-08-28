/**
 * R13.12 — `inference.default_coder` resolves to a MECHANISM, not just a string.
 *
 * The setting accepts a target id or a model id because the user's question is one
 * question ("who does the coding work?") while two different machines answer it.
 * The tests that matter are about the AMBIGUITY: `claude-sonnet-5` and `anthropic`
 * are both bare words, and reading a declared target's id as a model name would
 * send work somewhere the user did not choose while reporting success.
 */

import { describe, expect, it } from "vitest";
import {
  CODER_AGENT_NAME,
  CoderRouteError,
  coderRouteConflict,
  resolveCoderRoute,
} from "../../../src/inference/coder-route.js";
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

describe("resolveCoderRoute", () => {
  it("is `none` when nothing is configured — the work stays in this session", () => {
    // R13.11's settled default. Not a gap: delegating to the model already running
    // spends the same quota in a worse context.
    expect(resolveCoderRoute({ settings: SETTINGS })).toEqual({ kind: "none" });
  });

  it("reads a MODEL id as the harness subagent route", () => {
    expect(resolveCoderRoute({ settings: SETTINGS, defaultCoder: "claude-sonnet-5" })).toEqual({
      kind: "harness",
      model: "claude-sonnet-5",
    });
    // The short aliases the subagent frontmatter documents work too (§114).
    expect(resolveCoderRoute({ settings: SETTINGS, defaultCoder: "sonnet" })).toEqual({
      kind: "harness",
      model: "sonnet",
    });
  });

  it("prefers a DECLARED TARGET over reading the same string as a model", () => {
    // The ambiguity, decided. Declaring a target is a deliberate act; silently
    // reading its id as a model name is the R10.8 failure mode.
    expect(resolveCoderRoute({ settings: SETTINGS, defaultCoder: "cheap" })).toEqual({
      kind: "target",
      targetId: "cheap",
      via: "default_coder",
    });
  });

  it("resolves a bare GATEWAY id the way the rest of the registry does (R9.23)", () => {
    // Resolves to that gateway's FIRST target, exactly as `default_target` does.
    expect(resolveCoderRoute({ settings: SETTINGS, defaultCoder: "openrouter" })).toEqual({
      kind: "target",
      targetId: "openrouter:qwen/qwen3.7-flash",
      via: "default_coder",
    });
  });

  it("RAISES on a colon-shaped id that resolves to nothing, naming what does exist", () => {
    // A `gateway:model` shape that resolves to nothing is a typo'd target, not a
    // model called `openrouter:qwn/...`. Reading it as a model would produce an
    // agent definition naming a model that does not exist — a failure that
    // surfaces later, elsewhere, as "There's an issue with the selected model".
    expect(() =>
      resolveCoderRoute({ settings: SETTINGS, defaultCoder: "openrouter:qwn/typo" }),
    ).toThrow(CoderRouteError);
    expect(() =>
      resolveCoderRoute({ settings: SETTINGS, defaultCoder: "openrouter:qwn/typo" }),
    ).toThrow(/names neither a configured target nor a usable model id.*cheap/s);
  });

  it("RAISES on a value that could not be a model id at all", () => {
    // The value ends up in generated frontmatter and (historically) on a command
    // line, so it is checked rather than trusted.
    expect(() => resolveCoderRoute({ settings: SETTINGS, defaultCoder: "not a model" })).toThrow(
      CoderRouteError,
    );
  });

  it("lets worker_targets.coder win, being the explicit low-level map (R9.4)", () => {
    expect(
      resolveCoderRoute({
        settings: SETTINGS,
        workerTargets: { coder: "cheap" },
        defaultCoder: "claude-sonnet-5",
      }),
    ).toEqual({ kind: "target", targetId: "cheap", via: "worker" });
  });

  it("treats an EMPTY worker entry as no entry, not as a target id", () => {
    expect(
      resolveCoderRoute({
        settings: SETTINGS,
        workerTargets: { coder: "" },
        defaultCoder: "claude-sonnet-5",
      }),
    ).toEqual({ kind: "harness", model: "claude-sonnet-5" });
  });

  it("trims, so a stray space is not read as an unusable model id", () => {
    expect(resolveCoderRoute({ settings: SETTINGS, defaultCoder: "  sonnet  " })).toEqual({
      kind: "harness",
      model: "sonnet",
    });
  });
});

describe("coderRouteConflict", () => {
  it("reports both keys naming different destinations rather than resolving silently", () => {
    // worker_targets wins, but a user who set both almost certainly expects the
    // newer key to apply — so silence would be the wrong kind of correct.
    const conflict = coderRouteConflict({
      settings: SETTINGS,
      workerTargets: { coder: "cheap" },
      defaultCoder: "claude-sonnet-5",
    });
    expect(conflict).toMatch(/worker_targets wins/);
    expect(conflict).toContain("cheap");
    expect(conflict).toContain("claude-sonnet-5");
  });

  it("is silent when they agree, or when only one is set", () => {
    expect(
      coderRouteConflict({
        settings: SETTINGS,
        workerTargets: { coder: "cheap" },
        defaultCoder: "cheap",
      }),
    ).toBeUndefined();
    expect(
      coderRouteConflict({ settings: SETTINGS, defaultCoder: "claude-sonnet-5" }),
    ).toBeUndefined();
    expect(
      coderRouteConflict({ settings: SETTINGS, workerTargets: { coder: "cheap" } }),
    ).toBeUndefined();
  });
});

describe("CODER_AGENT_NAME", () => {
  it("is the basename `src/mcp` and `src/cli` both depend on", () => {
    // It lives in `src/inference/` precisely so `src/mcp/` can name it without
    // importing from `src/cli/`, which would invert the layering.
    expect(CODER_AGENT_NAME).toBe("golem-coder");
  });
});
