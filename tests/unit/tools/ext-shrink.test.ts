/**
 * P3b — the external-shrinker seam.
 *
 * These tests never require `caveman-shrink` to be installed: the point of the
 * seam is that Golem ships none of its bytes, so the resolver is exercised with
 * an injected `require` and the mode is exercised with an injected transform.
 *
 * The assertion that matters most is the refusal: with no external transform the
 * mode THROWS. A silent identity transform would publish "0% saved, no accuracy
 * change" as if it had measured somebody else's shrinker.
 */

import { describe, expect, it } from "vitest";
import type { CatalogTool } from "../../../src/tools/index.js";
import {
  EXTERNAL_MODES,
  isExternalMode,
  resolveCavemanShrink,
  SHRINK_MODES,
  shrinkCatalog,
} from "../../../src/tools/index.js";

function tool(over: Partial<CatalogTool> = {}): CatalogTool {
  const description = over.description ?? "Use the tool when you really want a thing.";
  return {
    name: "example",
    description,
    descriptionTokens: Math.ceil(description.length / 4),
    schema: { type: "object", properties: {} },
    schemaTokens: 10,
    definitionTokens: Math.ceil(description.length / 4) + 10,
    ...over,
  } as CatalogTool;
}

/** A stand-in for the package's own `compress`, in its documented v0.1.0 shape. */
function fakeModule(): { compress: (text: string) => { compressed: string } } {
  return {
    compress: (text: string) => ({ compressed: text.replace(/\b(?:the|really)\s+/g, "") }),
  };
}

describe("shrink mode registry", () => {
  it("lists the external mode and classifies it", () => {
    expect(SHRINK_MODES).toContain("ext-caveman-shrink");
    expect(EXTERNAL_MODES).toEqual(["ext-caveman-shrink"]);
    expect(isExternalMode("ext-caveman-shrink")).toBe(true);
    expect(isExternalMode("first-sentence")).toBe(false);
  });
});

describe("shrinkCatalog with an external mode", () => {
  it("refuses to run without the external transform", () => {
    expect(() => shrinkCatalog([tool()], "ext-caveman-shrink")).toThrow(/caveman-shrink/);
    expect(() => shrinkCatalog([tool()], "ext-caveman-shrink")).toThrow(/identity transform/);
  });

  it("applies the supplied transform and recomputes the token census", () => {
    const [shrunk] = shrinkCatalog([tool()], "ext-caveman-shrink", {
      externalTransform: (text) => text.replace(/\b(?:the|really)\s+/g, ""),
    });
    expect(shrunk?.description).toBe("Use tool when you want a thing.");
    expect(shrunk?.descriptionTokens).toBeLessThan(tool().descriptionTokens);
    // The schema is untouched, so the definition moves by exactly the description delta.
    expect(shrunk?.schemaTokens).toBe(10);
    expect(shrunk?.definitionTokens).toBe((shrunk?.descriptionTokens ?? 0) + 10);
  });
});

describe("resolveCavemanShrink", () => {
  it("returns null when nothing resolves — absence is reported, not faked", () => {
    const requireImpl = (() => {
      throw new Error("Cannot find module");
    }) as unknown as NodeJS.Require;
    expect(resolveCavemanShrink({ requireImpl })).toBeNull();
  });

  it("unwraps the package's { compressed } return shape", () => {
    const mod = fakeModule();
    const requireImpl = Object.assign(() => mod, {
      resolve: () => "/somewhere/caveman-shrink/compress.js",
    }) as unknown as NodeJS.Require;
    const shrinker = resolveCavemanShrink({ requireImpl, explicitPath: "/somewhere/compress.js" });
    expect(shrinker?.name).toBe("caveman-shrink");
    expect(shrinker?.resolvedFrom).toBe("/somewhere/caveman-shrink/compress.js");
    expect(shrinker?.compress("keep the words")).toBe("keep words");
  });

  it("accepts a bare-string compress too", () => {
    const requireImpl = Object.assign(() => ({ compress: (t: string) => t.toUpperCase() }), {
      resolve: (id: string) => id,
    }) as unknown as NodeJS.Require;
    expect(resolveCavemanShrink({ requireImpl, explicitPath: "x" })?.compress("ab")).toBe("AB");
  });

  it("falls back to the input when their shape changes (pre-1.0 package)", () => {
    const requireImpl = Object.assign(() => ({ compress: () => ({ unexpected: 1 }) }), {
      resolve: (id: string) => id,
    }) as unknown as NodeJS.Require;
    expect(resolveCavemanShrink({ requireImpl, explicitPath: "x" })?.compress("unchanged")).toBe(
      "unchanged",
    );
  });

  it("skips a module with no compress function", () => {
    const requireImpl = Object.assign(() => ({ notCompress: true }), {
      resolve: (id: string) => id,
    }) as unknown as NodeJS.Require;
    expect(resolveCavemanShrink({ requireImpl, explicitPath: "x" })).toBeNull();
  });
});
