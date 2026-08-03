/**
 * Upstream model DISPLAY helpers (R6.2, src/providers/model-display.ts):
 * read-only request-model sniffing on the byte-faithful Anthropic path, and the
 * wire-level vendor-prefix strip. There are deliberately no "friendly" model
 * labels to test — every surface prints the model id verbatim (only Claude ids
 * had a family/version to fold into, which made mixed lines inconsistent).
 */

import { describe, expect, it } from "vitest";
import { sniffRequestModel, stripVendorPrefix } from "../../../src/providers/model-display.js";

describe("sniffRequestModel", () => {
  it("extracts the top-level model from an Anthropic messages body", () => {
    const body = Buffer.from(JSON.stringify({ model: "claude-opus-4-8[1m]", messages: [] }));
    expect(sniffRequestModel(body)).toBe("claude-opus-4-8[1m]");
  });

  it("returns undefined for a null body", () => {
    expect(sniffRequestModel(null)).toBeUndefined();
  });

  it("returns undefined for a non-JSON or non-object body (never throws)", () => {
    expect(sniffRequestModel(Buffer.from("{ not json"))).toBeUndefined();
    expect(sniffRequestModel(Buffer.from("[1,2,3]"))).toBeUndefined();
    expect(sniffRequestModel(Buffer.from("42"))).toBeUndefined();
  });

  it("returns undefined when there is no string model field", () => {
    expect(sniffRequestModel(Buffer.from(JSON.stringify({ messages: [] })))).toBeUndefined();
    expect(sniffRequestModel(Buffer.from(JSON.stringify({ model: 5 })))).toBeUndefined();
    expect(sniffRequestModel(Buffer.from(JSON.stringify({ model: "" })))).toBeUndefined();
  });

  it("still finds the model in a large body (field is near the top, within the cap)", () => {
    const body = Buffer.from(
      JSON.stringify({ model: "claude-opus-4-8", messages: [{ text: "x".repeat(500_000) }] }),
    );
    expect(sniffRequestModel(body)).toBe("claude-opus-4-8");
  });

  it("does not return a model key nested inside a tool description or function definition (R8.19)", () => {
    // The "model" key inside a tool definition must not shadow the top-level one.
    const body = Buffer.from(
      JSON.stringify({
        model: "claude-sonnet-5",
        tools: [
          {
            name: "search",
            description: "Search using model: gpt-4 for ranking",
            input_schema: { type: "object" },
          },
        ],
        messages: [],
      }),
    );
    expect(sniffRequestModel(body)).toBe("claude-sonnet-5");
  });

  it("returns undefined when the only model key is inside a nested object", () => {
    // No top-level model field — the only "model" is inside a nested tool/function.
    const body = Buffer.from(
      JSON.stringify({
        tools: [
          {
            name: "search",
            description: "Uses model: gpt-4",
            input_schema: { type: "object" },
          },
        ],
        messages: [],
      }),
    );
    expect(sniffRequestModel(body)).toBeUndefined();
  });
});

describe("stripVendorPrefix", () => {
  it("strips a single vendor prefix from an OpenRouter-style slug", () => {
    expect(stripVendorPrefix("moonshotai/kimi-k2.7-code")).toBe("kimi-k2.7-code");
    expect(stripVendorPrefix("openai/gpt-5.2")).toBe("gpt-5.2");
  });

  it("leaves bare model ids unchanged", () => {
    expect(stripVendorPrefix("kimi-k3")).toBe("kimi-k3");
    expect(stripVendorPrefix("qwen2.5-coder:7b")).toBe("qwen2.5-coder:7b");
    expect(stripVendorPrefix("claude-sonnet-5")).toBe("claude-sonnet-5");
  });

  it("leaves multi-slash ids opaque (e.g. Hugging Face paths)", () => {
    expect(stripVendorPrefix("org/model/name")).toBe("org/model/name");
  });

  it("leaves leading-slash and empty-prefix shapes unchanged", () => {
    expect(stripVendorPrefix("/kimi-k3")).toBe("/kimi-k3");
    expect(stripVendorPrefix("//kimi-k3")).toBe("//kimi-k3");
  });
});
