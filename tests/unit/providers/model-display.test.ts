/**
 * Upstream model DISPLAY helpers (R6.2, src/providers/model-display.ts):
 * friendly family labels for status surfaces, and read-only request-model
 * sniffing on the byte-faithful Anthropic path.
 */

import { describe, expect, it } from "vitest";
import {
  formatVendorModelStatus,
  friendlyModelLabel,
  friendlyModelVersionLabel,
  localModelVersionLabel,
  parseVendorModel,
  sniffRequestModel,
} from "../../../src/providers/model-display.js";

describe("friendlyModelLabel", () => {
  it("maps Claude ids (including the [1m] context suffix) to a family label", () => {
    expect(friendlyModelLabel("claude-opus-4-8[1m]")).toBe("opus");
    expect(friendlyModelLabel("claude-opus-4-8")).toBe("opus");
    expect(friendlyModelLabel("claude-sonnet-5")).toBe("sonnet");
    expect(friendlyModelLabel("claude-haiku-4-5-20251001")).toBe("haiku");
    expect(friendlyModelLabel("claude-fable-5")).toBe("fable");
    expect(friendlyModelLabel("claude-3-5-sonnet-20241022")).toBe("sonnet");
  });

  it("is case-insensitive", () => {
    expect(friendlyModelLabel("Claude-OPUS-4-8")).toBe("opus");
  });

  it("returns an unrecognised id unchanged (non-Claude / future name)", () => {
    expect(friendlyModelLabel("kimi-k3")).toBe("kimi-k3");
    expect(friendlyModelLabel("gpt-5.2")).toBe("gpt-5.2");
    expect(friendlyModelLabel("")).toBe("");
  });
});

describe("friendlyModelVersionLabel", () => {
  it("maps Claude ids to a capitalized family + version", () => {
    expect(friendlyModelVersionLabel("claude-opus-4-8[1m]")).toBe("Opus 4.8");
    expect(friendlyModelVersionLabel("claude-opus-4-8")).toBe("Opus 4.8");
    expect(friendlyModelVersionLabel("claude-sonnet-5")).toBe("Sonnet 5");
    expect(friendlyModelVersionLabel("claude-fable-5")).toBe("Fable 5");
  });

  it("drops a trailing date/build stamp segment", () => {
    expect(friendlyModelVersionLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  });

  it("is case-insensitive", () => {
    expect(friendlyModelVersionLabel("Claude-OPUS-4-8")).toBe("Opus 4.8");
  });

  it("returns the family alone when no numeric version follows", () => {
    // A `claude-3-5-sonnet-…` id: `sonnet` is the family but the digits precede
    // it, so there's no numeric version *after* the family to show.
    expect(friendlyModelVersionLabel("claude-3-5-sonnet-20241022")).toBe("Sonnet");
  });

  it("returns an unrecognised id unchanged (non-Claude / future name)", () => {
    expect(friendlyModelVersionLabel("kimi-k3")).toBe("kimi-k3");
    expect(friendlyModelVersionLabel("gpt-5.2")).toBe("gpt-5.2");
    expect(friendlyModelVersionLabel("")).toBe("");
  });
});

describe("localModelVersionLabel", () => {
  it("maps Ollama ids to a capitalized family + version, dropping the tag", () => {
    expect(localModelVersionLabel("qwen2.5-coder:7b")).toBe("Qwen 2.5");
    expect(localModelVersionLabel("llama3.1:8b")).toBe("Llama 3.1");
    expect(localModelVersionLabel("qwen2.5-coder")).toBe("Qwen 2.5");
  });

  it("returns the family alone when no numeric version immediately follows", () => {
    expect(localModelVersionLabel("deepseek-coder-v2:16b")).toBe("Deepseek");
  });

  it("returns empty for empty, and an id with no alphabetic family unchanged", () => {
    expect(localModelVersionLabel("")).toBe("");
    expect(localModelVersionLabel("7b")).toBe("7b");
  });
});

describe("parseVendorModel", () => {
  it("splits vendor and model-name on the first slash", () => {
    expect(parseVendorModel("moonshotai/kimi-k3")).toEqual({
      vendor: "moonshotai",
      modelName: "kimi-k3",
    });
    expect(parseVendorModel("anthropic/claude-sonnet-4-5-20250929")).toEqual({
      vendor: "anthropic",
      modelName: "claude-sonnet-4-5-20250929",
    });
  });

  it("defaults to anthropic as vendor when there is no slash", () => {
    expect(parseVendorModel("kimi-k3")).toEqual({ vendor: "anthropic", modelName: "kimi-k3" });
  });

  it("accepts a custom default vendor", () => {
    expect(parseVendorModel("kimi-k3", "openai")).toEqual({
      vendor: "openai",
      modelName: "kimi-k3",
    });
  });
});

describe("formatVendorModelStatus", () => {
  it("renders vendor/model-name as 'vendor (model-name)'", () => {
    expect(formatVendorModelStatus("moonshotai/kimi-k3")).toBe("moonshotai (kimi-k3)");
  });

  it("uses the default vendor for bare model ids", () => {
    expect(formatVendorModelStatus("kimi-k3", "openai")).toBe("openai (kimi-k3)");
  });
});

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
});
