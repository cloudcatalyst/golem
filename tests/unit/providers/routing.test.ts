/**
 * R9.2 — the route precedence chain.
 *
 * Pure and total, so every branch is exercised directly. The properties that
 * matter: an explicit per-request act always beats a binding, a binding beats
 * the default, and a malformed virtual id degrades to the next level instead of
 * resolving the empty string against the registry.
 */

import { describe, expect, it } from "vitest";
import {
  isVirtualModelId,
  resolveRoute,
  TARGET_HEADER,
  targetIdFromVirtualModel,
  VIRTUAL_MODEL_PREFIX,
} from "../../../src/providers/routing.js";

describe("virtual model ids", () => {
  it("recognizes the golem/ namespace and extracts the target id", () => {
    expect(VIRTUAL_MODEL_PREFIX).toBe("golem/");
    expect(isVirtualModelId("golem/coder")).toBe(true);
    expect(targetIdFromVirtualModel("golem/coder")).toBe("coder");
    // Ids with their own slashes survive — a target id is free-form.
    expect(targetIdFromVirtualModel("golem/openrouter-qwen3")).toBe("openrouter-qwen3");
  });

  it("does not claim a real model id", () => {
    expect(isVirtualModelId("claude-opus-5")).toBe(false);
    expect(isVirtualModelId("openai/gpt-oss-20b:free")).toBe(false);
    expect(targetIdFromVirtualModel("claude-opus-5")).toBeUndefined();
    expect(targetIdFromVirtualModel(undefined)).toBeUndefined();
  });

  it("treats a bare prefix as NOT a selector", () => {
    // "golem/" names no target; resolving "" against the registry would be a
    // lookup for a target that can never exist.
    expect(targetIdFromVirtualModel("golem/")).toBeUndefined();
    expect(targetIdFromVirtualModel("golem/   ")).toBeUndefined();
  });
});

describe("route precedence", () => {
  const BASE = { defaultTarget: "anthropic" } as const;

  it("falls back to the default target when nothing selects one", () => {
    const decision = resolveRoute(BASE);
    expect(decision).toMatchObject({
      targetId: "anthropic",
      reason: "proxy.default_target",
      sticky: false,
    });
    expect(decision.virtualModel).toBeUndefined();
  });

  it("level 1 — a virtual model id in the body wins over everything", () => {
    const decision = resolveRoute({
      ...BASE,
      bodyModel: "golem/coder",
      headerTarget: "other",
      boundTarget: "bound",
    });
    expect(decision.targetId).toBe("coder");
    expect(decision.sticky).toBe(false);
    // The transport needs this to know NOT to forward the string upstream.
    expect(decision.virtualModel).toBe("golem/coder");
    expect(decision.reason).toContain("virtual model id");
  });

  it("level 2 — the header wins over a binding and the default", () => {
    const decision = resolveRoute({ ...BASE, headerTarget: "cheap", boundTarget: "bound" });
    expect(decision.targetId).toBe("cheap");
    expect(decision.reason).toBe(`${TARGET_HEADER}: cheap`);
    expect(decision.sticky).toBe(false);
  });

  it("level 3 — a conversation binding wins over the default and is marked sticky", () => {
    const decision = resolveRoute({ ...BASE, boundTarget: "coder" });
    expect(decision).toMatchObject({ targetId: "coder", sticky: true });
    expect(decision.reason).toContain("already bound");
  });

  it("ignores a blank header rather than routing to the empty string", () => {
    expect(resolveRoute({ ...BASE, headerTarget: "   " }).targetId).toBe("anthropic");
    expect(resolveRoute({ ...BASE, headerTarget: "" }).targetId).toBe("anthropic");
  });

  it("degrades a malformed virtual id to the next level, not to a broken lookup", () => {
    const decision = resolveRoute({ ...BASE, bodyModel: "golem/", headerTarget: "cheap" });
    expect(decision.targetId).toBe("cheap");
  });

  it("passes a real model id straight through to the default target", () => {
    // The overwhelmingly common case: Claude Code sends its own model id every
    // turn and nothing about routing changes.
    const decision = resolveRoute({ ...BASE, bodyModel: "claude-opus-5" });
    expect(decision.targetId).toBe("anthropic");
    expect(decision.virtualModel).toBeUndefined();
  });

  it("returns an id it cannot validate — the caller fails closed", () => {
    // Keeping the registry lookup out of the pure function is what lets the
    // caller produce an error naming the configured targets.
    expect(resolveRoute({ ...BASE, bodyModel: "golem/ghost" }).targetId).toBe("ghost");
  });
});
