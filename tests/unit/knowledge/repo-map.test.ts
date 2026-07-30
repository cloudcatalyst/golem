/**
 * R8.5 — the repo map: symbol extraction, the reference graph, the personalized
 * rank, and the budgeted render.
 *
 * `web-tree-sitter` + the grammars are devDependencies of this repo only (never
 * a `golem-run` dependency), so real parsing is testable here with no network.
 *
 * The assertions that matter most are the two hard constraints: **byte
 * stability** (an unstable map re-prefills a cached prefix and is strictly worse
 * than no map at all — §14) and **budget adherence** (the map is a saving or it
 * is nothing).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildGraph,
  buildRepoMap,
  DEFAULT_MAP_BUDGET_TOKENS,
  rankFiles,
  renderFileSkeleton,
  renderRepoMap,
  resolveImport,
  scanRepoFiles,
} from "../../../src/knowledge/repo-map.js";
import { extractFileFacts } from "../../../src/knowledge/tree-sitter-chunker.js";

describe("extractFileFacts", () => {
  it("extracts exported functions, classes with methods, interfaces and consts", async () => {
    const src = [
      "import { helper } from './util.js';",
      "",
      "export interface Shape {",
      "  area: number;",
      "}",
      "",
      "export type Id = string | number;",
      "",
      "export const LIMIT = 42;",
      "",
      "export const compute = (n: number): number => helper(n) * LIMIT;",
      "",
      "export function area(shape: Shape): number {",
      "  return shape.area;",
      "}",
      "",
      "export class Box {",
      "  constructor(private readonly id: Id) {}",
      "  volume(): number {",
      "    return 1;",
      "  }",
      "}",
      "",
    ].join("\n");
    const facts = await extractFileFacts(".ts", src);
    expect(facts).not.toBeNull();
    const byName = new Map((facts?.defs ?? []).map((d) => [d.name, d]));

    expect(facts?.imports).toEqual(["./util.js"]);
    expect(byName.get("Shape")?.kind).toBe("interface");
    expect(byName.get("Id")?.kind).toBe("type");
    expect(byName.get("LIMIT")?.kind).toBe("const");
    expect(byName.get("compute")?.kind).toBe("function");
    expect(byName.get("area")?.kind).toBe("function");
    expect(byName.get("Box")?.kind).toBe("class");
    expect(byName.get("volume")?.kind).toBe("method");
    // Every signature is ONE line with no body.
    for (const def of facts?.defs ?? []) {
      expect(def.signature).not.toContain("\n");
      expect(def.signature).not.toContain("return");
    }
    expect(byName.get("area")?.signature).toBe("export function area(shape: Shape): number");
    expect(byName.get("area")?.line).toBe(13);
    expect(byName.get("area")?.exported).toBe(true);
    // References are counted for the graph; the import name is one of them.
    expect(facts?.refs.helper).toBeGreaterThan(0);
  });

  it("keeps a const's type annotation but never its initialiser", async () => {
    const src = `export const TABLE: Record<string, number> = { ${"a: 1, ".repeat(200)} };\n`;
    const facts = await extractFileFacts(".ts", src);
    const table = facts?.defs.find((d) => d.name === "TABLE");
    expect(table?.kind).toBe("const");
    expect(table?.signature).toContain("Record<string, number>");
    expect(table?.signature).not.toContain("a: 1");
    expect(table?.signature.length).toBeLessThanOrEqual(160);
  });

  it("returns null for an extension with no grammar (the no-op path)", async () => {
    expect(await extractFileFacts(".py", "def f():\n    return 1\n")).toBeNull();
  });
});

describe("resolveImport", () => {
  const known = new Set(["src/a.ts", "src/nested/b.tsx", "src/dir/index.ts"]);

  it("maps this repo's ESM `./x.js` specifiers onto the real `.ts` file", () => {
    expect(resolveImport("src/nested/b.tsx", "../a.js", known)).toBe("src/a.ts");
  });

  it("resolves a directory to its index", () => {
    expect(resolveImport("src/a.ts", "./dir", known)).toBe("src/dir/index.ts");
  });

  it("ignores bare package specifiers — an npm dep is not a node in the graph", () => {
    expect(resolveImport("src/a.ts", "node:path", known)).toBeNull();
    expect(resolveImport("src/a.ts", "zod", known)).toBeNull();
  });
});

describe("the repo map over a fixture tree", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "golem-repomap-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    // `core.ts` is imported and referenced by everything — the graph must rank
    // it first even though it sorts last alphabetically.
    await writeFile(
      path.join(root, "src", "zcore.ts"),
      [
        "export function redactSecrets(text: string): string {",
        "  return text.replace(/sk-[a-z]+/g, '[redacted]');",
        "}",
        "export const REDACTION_LIMIT = 10;",
        "",
      ].join("\n"),
      "utf8",
    );
    for (const name of ["alpha", "beta", "gamma"]) {
      await writeFile(
        path.join(root, "src", `${name}.ts`),
        [
          "import { redactSecrets, REDACTION_LIMIT } from './zcore.js';",
          `export function ${name}Stage(input: string): string {`,
          "  const once = redactSecrets(input);",
          "  return once.slice(0, REDACTION_LIMIT);",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );
    }
    await writeFile(
      path.join(root, "src", "lonely.ts"),
      "export function unusedHelper(): void {}\n",
      "utf8",
    );
    await writeFile(path.join(root, "README.md"), "# not code\n", "utf8");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("scans only files with a grammar", async () => {
    const files = await scanRepoFiles(root);
    expect(files.map((f) => f.sourcePath).sort()).toEqual([
      "src/alpha.ts",
      "src/beta.ts",
      "src/gamma.ts",
      "src/lonely.ts",
      "src/zcore.ts",
    ]);
  });

  it("ranks the most-referenced file first, not the alphabetically first", async () => {
    const files = await scanRepoFiles(root);
    const graph = buildGraph(files);
    const rank = rankFiles(files, graph);
    const ordered = [...files]
      .sort((a, b) => (rank.get(b.sourcePath) ?? 0) - (rank.get(a.sourcePath) ?? 0))
      .map((f) => f.sourcePath);
    expect(ordered[0]).toBe("src/zcore.ts");
    expect(ordered.at(-1)).toBe("src/lonely.ts");
  });

  it("renders a byte-identical map for the same tree and options", async () => {
    const first = await buildRepoMap(root);
    const second = await buildRepoMap(root);
    expect(first.available).toBe(true);
    expect(second.available && first.available && second.text).toBe(
      first.available ? first.text : "",
    );
  });

  it("names the file, its length, and each symbol's line", async () => {
    const map = await buildRepoMap(root);
    if (!map.available) throw new Error(map.reason);
    expect(map.text).toContain("src/zcore.ts  (5 lines)");
    expect(map.text).toMatch(/ {4}1 {2}export function redactSecrets\(text: string\): string/);
    expect(map.text).toContain("[Golem repo map —");
    expect(map.filesShown).toBe(5);
    expect(map.symbolsTotal).toBe(6);
  });

  it("stays inside the token budget and says what it dropped", async () => {
    const map = await buildRepoMap(root, { budgetTokens: 200 });
    if (!map.available) throw new Error(map.reason);
    expect(map.tokens).toBeLessThanOrEqual(300); // budget + the header it reserves
    expect(map.filesShown).toBeLessThan(5);
    expect(map.text).toContain("not shown (lower graph rank)");
  });

  it("re-ranks toward a query", async () => {
    const files = await scanRepoFiles(root);
    const graph = buildGraph(files);
    const plain = rankFiles(files, graph);
    const queried = rankFiles(files, graph, { query: "gamma stage" });
    expect(queried.get("src/gamma.ts") ?? 0).toBeGreaterThan(plain.get("src/gamma.ts") ?? 0);
  });

  it("reports unavailable — never throws — for a root that is not a directory", async () => {
    const missing = await buildRepoMap(path.join(root, "does-not-exist"));
    expect(missing.available).toBe(false);
    expect(missing.available === false && missing.reason).toContain("not readable");
  });

  it("defaults to the memo's 1–1.5k budget", async () => {
    const map = await buildRepoMap(root);
    expect(map.available && map.budgetTokens).toBe(DEFAULT_MAP_BUDGET_TOKENS);
  });

  it("renderRepoMap is pure over its inputs", async () => {
    const files = await scanRepoFiles(root);
    const graph = buildGraph(files);
    const rank = rankFiles(files, graph);
    expect(renderRepoMap(files, graph, rank).text).toBe(renderRepoMap(files, graph, rank).text);
  });
});

describe("renderFileSkeleton", () => {
  it("orders rows by line and truncates on the char budget", async () => {
    const src = [
      "export function b(): void {}",
      "export function a(): void {}",
      "export function c(): void {}",
      "",
    ].join("\n");
    const facts = await extractFileFacts(".ts", src);
    const all = renderFileSkeleton(facts?.defs ?? [], 4_000);
    expect(all.shown).toBe(3);
    expect(all.hidden).toBe(0);
    expect(all.text.split("\n").map((l) => l.trim().split("  ")[0])).toEqual(["1", "2", "3"]);

    const clipped = renderFileSkeleton(facts?.defs ?? [], 40);
    expect(clipped.shown).toBe(1);
    expect(clipped.hidden).toBe(2);
    expect(clipped.text.length).toBeLessThanOrEqual(40);
  });
});
