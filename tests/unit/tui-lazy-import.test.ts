/**
 * Guard: the CLI must never STATICALLY import the ink/React panel.
 *
 * `golem hook pre-tool-use` runs on every Claude Code tool call, and the proxy and
 * MCP daemons start from the same entry point. A static `import ... from
 * "../tui/..."` in src/cli/main.ts would load ink, React, the reconciler, and
 * yoga-layout on all of those paths — a real, silent latency regression that
 * nothing else would catch. Only `await import(...)` inside a command action is
 * allowed.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function source(relPath: string): Promise<string> {
  return readFile(path.join(repoRoot, relPath), "utf8");
}

/**
 * Specifiers this module pulls in AT RUNTIME: static `import ... from` /
 * `export ... from`, and bare side-effect imports. `await import()` is excluded
 * (that's the whole point), and so are **type-only** statements — the repo compiles
 * with `verbatimModuleSyntax`, which guarantees `import type` / `export type` are
 * erased entirely and therefore cost nothing to load.
 *
 * Multi-line import statements are handled by matching across newlines up to the
 * `from`, so a formatted-out import list isn't missed.
 */
function staticSpecifiers(code: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(^|\n)[ \t]*(import|export)\b([\s\S]*?)from\s+["']([^"']+)["']/g;
  for (const match of code.matchAll(pattern)) {
    const clause = match[3] ?? "";
    const specifier = match[4];
    if (specifier === undefined) continue;
    // `import type { X } from "y"` — erased. But `import { type X, y }` is not:
    // it still emits a runtime import for `y`, so only a leading `type` counts.
    if (/^\s*type\b/.test(clause)) continue;
    specifiers.push(specifier);
  }
  for (const match of code.matchAll(/(^|\n)[ \t]*import\s+["']([^"']+)["']/g)) {
    if (match[2] !== undefined) specifiers.push(match[2]);
  }
  return specifiers;
}

describe("the CLI keeps the panel off the hot path", () => {
  it("keeps src/cli/main.ts free of ALL static imports", async () => {
    // main.ts is the `bin` entry: it decides between the panel and the rest of the
    // CLI, and ESM hoists imports, so ANY static import here is paid by every
    // `golem` process — including every `golem hook pre-tool-use`. It must route
    // with dynamic imports only.
    const specifiers = staticSpecifiers(await source("src/cli/main.ts"));
    expect(specifiers).toEqual([]);
  });

  it("routes to both branches dynamically, and to neither statically", async () => {
    const code = await source("src/cli/main.ts");
    expect(code).toMatch(/import\(\s*"\.\.\/tui\/index\.js"\s*\)/);
    expect(code).toMatch(/import\(\s*"\.\/program\.js"\s*\)/);
  });

  it("does not statically import src/tui from the CLI program", async () => {
    const code = await source("src/cli/program.ts");
    const offenders = staticSpecifiers(code).filter((s) => s.includes("tui"));
    expect(offenders).toEqual([]);
    expect(code).toMatch(/import\(\s*"\.\.\/tui\/index\.js"\s*\)/);
  });

  it("keeps the expensive status graph out of the control surface's static imports", async () => {
    // collectHeader imports ../cli/status.js lazily: its graph (init.js → the hooks
    // barrel, proxy, update, the local-model probe) is ~400ms, and the panel paints
    // before asking for any of it. Same reasoning for the slider's write path and
    // the hooks barrel.
    const specifiers = staticSpecifiers(await source("src/config/control-surface.ts"));
    expect(specifiers).not.toContain("../cli/status.js");
    expect(specifiers).not.toContain("../cli/slider.js");
    expect(specifiers).not.toContain("../hooks/index.js");
    // ...and the cheap read-only substitutes ARE used.
    expect(specifiers).toContain("../cli/slider-read.js");
    expect(specifiers).toContain("../hooks/guidance.js");
  });

  it("keeps the control surface out of the config barrel", async () => {
    // src/hooks/pre-tool-use.ts imports the barrel and runs on every tool call;
    // re-exporting the control surface from it cost ~400ms per invocation.
    const specifiers = staticSpecifiers(await source("src/config/index.ts"));
    expect(specifiers).not.toContain("./control-surface.js");
  });

  it("has no ink or react dependency at all, anywhere", async () => {
    // The panel was ink+React; ink alone cost ~890ms to import, which was ~75% of the
    // panel's startup, so it was replaced by src/tui/{ansi,width,keys,screen,render}.
    // Nothing may quietly reintroduce it.
    const pkg = JSON.parse(await source("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const banned of ["ink", "react", "@types/react", "ink-testing-library"]) {
      expect(Object.keys(declared), `${banned} is back in package.json`).not.toContain(banned);
    }

    const { globSync } = await import("node:fs");
    const files = globSync("src/**/*.ts", { cwd: repoRoot }).map((file) =>
      file.split(path.sep).join("/"),
    );
    // Read in parallel: ~150 files one-at-a-time overran vitest's 5s default when the
    // whole suite was running.
    const sources = await Promise.all(
      files.map(async (file) => [file, await source(file)] as const),
    );
    const offenders = sources
      .filter(([, code]) =>
        staticSpecifiers(code).some((s) => s === "ink" || s === "react" || s.startsWith("react/")),
      )
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it("keeps the panel's own entry point free of static imports too", async () => {
    // src/tui/index.ts is what main.ts dynamically imports in order to decide whether
    // to open the panel at all, so even the control surface (~140ms) is deferred.
    const code = await source("src/tui/index.ts");
    expect(staticSpecifiers(code)).toEqual([]);
    expect(code).toMatch(/import\(\s*"\.\.\/config\/control-surface\.js"\s*\)/);
  });

  it("keeps the ESC byte in exactly one module, and out of the source as a literal", async () => {
    // A raw control character in source is invisible in diffs and gets mangled by
    // ordinary tooling; ansi.ts builds it with String.fromCharCode instead.
    const { globSync } = await import("node:fs");
    const files = globSync("src/tui/*.ts", { cwd: repoRoot }).map((f) =>
      f.split(path.sep).join("/"),
    );
    const withRawEsc: string[] = [];
    for (const file of files) {
      if ((await source(file)).includes(String.fromCharCode(27))) withRawEsc.push(file);
    }
    expect(withRawEsc).toEqual([]);
    expect(await source("src/tui/ansi.ts")).toContain("String.fromCharCode(27)");
  });
});
