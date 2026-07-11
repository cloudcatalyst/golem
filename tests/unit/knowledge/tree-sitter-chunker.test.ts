/**
 * R3.3 — syntax-aware chunking via `web-tree-sitter`. These packages are
 * devDependencies of this repo only (never a `golem-run` dependency — see
 * tree-sitter-chunker.ts's doc comment), which is exactly what makes real
 * parsing testable here without any network access.
 */

import { describe, expect, it } from "vitest";
import { chunkCodeSyntaxAware } from "../../../src/knowledge/tree-sitter-chunker.js";

describe("chunkCodeSyntaxAware", () => {
  it("splits TypeScript into one chunk per top-level declaration", async () => {
    const src = [
      "export function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
      "",
      "export class Greeter {",
      "  greet(): string {",
      "    return 'hi';",
      "  }",
      "}",
      "",
    ].join("\n");
    const chunks = await chunkCodeSyntaxAware(".ts", src);
    expect(chunks).not.toBeNull();
    expect(chunks?.length).toBe(2);
    expect(chunks?.[0]?.text).toContain("function add");
    expect(chunks?.[0]?.kind).toBe("code");
    expect(chunks?.[0]?.metadata.nodeType).toBeDefined();
    expect(chunks?.[1]?.text).toContain("class Greeter");
  });

  it("parses TSX", async () => {
    const src = "export const Widget = () => <div>hi</div>;\n";
    const chunks = await chunkCodeSyntaxAware(".tsx", src);
    expect(chunks).not.toBeNull();
    expect(chunks?.length).toBeGreaterThan(0);
    expect(chunks?.[0]?.text).toContain("Widget");
  });

  it("parses plain JavaScript", async () => {
    const src = "function square(n) {\n  return n * n;\n}\n";
    const chunks = await chunkCodeSyntaxAware(".js", src);
    expect(chunks).not.toBeNull();
    expect(chunks?.[0]?.text).toContain("square");
  });

  it("assigns 1-based, non-overlapping start/end lines matching the source", async () => {
    const src =
      "export function first() {\n  return 1;\n}\n\nexport function second() {\n  return 2;\n}\n";
    const chunks = await chunkCodeSyntaxAware(".ts", src);
    expect(chunks?.[0]?.startLine).toBe(1);
    expect(chunks?.[0]?.endLine).toBe(3);
    expect(chunks?.[1]?.startLine).toBe(5);
  });

  it("returns null for an unsupported extension", async () => {
    const chunks = await chunkCodeSyntaxAware(".py", "def f():\n    return 1\n");
    expect(chunks).toBeNull();
  });
});
