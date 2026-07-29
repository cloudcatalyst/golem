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

/** Static `import ...` / `export ... from` specifiers, ignoring `await import()`. */
function staticSpecifiers(code: string): string[] {
  const specifiers: string[] = [];
  const pattern = /^\s*(?:import|export)\b[^;\n]*?from\s+["']([^"']+)["']/gm;
  for (const match of code.matchAll(pattern)) {
    if (match[1] !== undefined) specifiers.push(match[1]);
  }
  // Bare side-effect imports (`import "x";`) count too.
  const bare = /^\s*import\s+["']([^"']+)["']/gm;
  for (const match of code.matchAll(bare)) {
    if (match[1] !== undefined) specifiers.push(match[1]);
  }
  return specifiers;
}

describe("the CLI keeps the panel off the hot path", () => {
  it("does not statically import src/tui from main.ts", async () => {
    const code = await source("src/cli/main.ts");
    const offenders = staticSpecifiers(code).filter((s) => s.includes("tui"));
    expect(offenders).toEqual([]);
  });

  it("does reach the panel through a dynamic import", async () => {
    const code = await source("src/cli/main.ts");
    expect(code).toContain('await import("../tui/index.js")');
  });

  it("does not statically import ink or react anywhere outside src/tui", async () => {
    // Anything that imports ink transitively drags it onto whatever path loads it,
    // so the dependency stays confined to the panel's own directory.
    const { globSync } = await import("node:fs");
    const files = globSync("src/**/*.{ts,tsx}", { cwd: repoRoot });
    const offenders: string[] = [];
    for (const file of files) {
      const normalized = file.split(path.sep).join("/");
      if (normalized.startsWith("src/tui/")) continue;
      const specs = staticSpecifiers(await source(file));
      if (specs.some((s) => s === "ink" || s === "react" || s.startsWith("react/"))) {
        offenders.push(normalized);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the panel's own entry point free of a static ink import", async () => {
    // src/tui/index.tsx is what main.ts dynamically imports; it must defer ink one
    // more step so a config error can be reported before the screen is taken over.
    const code = await source("src/tui/index.tsx");
    expect(staticSpecifiers(code)).not.toContain("ink");
    expect(code).toContain('import("ink")');
  });
});
