/**
 * T-C4 guard, second half: Headroom stays behind ONE adapter.
 *
 * CLAUDE.md states the rule as "Headroom pinned exactly; imports only in
 * `src/compression/headroom-adapter.ts`". Until R10.1 only the *pin* half was
 * checked (`pins.contract.test.ts`) — the isolation half was enforced by code
 * review alone, so a PR adding a Headroom import or a second sidecar spawn
 * anywhere in `src/` would have gone green. This closes that.
 *
 * The rule protects a real property, not a filing preference: Headroom is an
 * OPT-IN Python sidecar (Decision 18) that the default install does not have.
 * One adapter is what makes "absent Headroom degrades to a no-op" checkable —
 * every degrade path runs through the same class. A second call site is a
 * second place that can throw when `uv` is missing.
 *
 * What counts as coupling, and what does not: MENTIONING Headroom is fine and
 * widespread — `compression.headroom_sidecar` is a config key, so schema.ts,
 * ui-model.ts, status surfaces and the package manifest all name it in prose
 * and data. What is forbidden is *reaching* Headroom: importing its module,
 * naming its worker script, or spawning its package. So comments are stripped
 * before every check below; a doc comment describing the sidecar is not a
 * violation, and `src/config/schema.ts` has exactly such a comment today.
 */

import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HEADROOM_SIDECAR_PYPI_PIN } from "../../src/compression/pins.js";
import { PKG_MANIFESTS } from "../../src/pkg/manifest.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const srcRoot = join(repoRoot, "src");

/** The one module allowed to reach Headroom, repo-relative with POSIX slashes. */
const ADAPTER = "src/compression/headroom-adapter.ts";

/**
 * Strip comments so a *mention* of Headroom never trips the check — only real
 * code does. Block comments cover JSDoc; whole-line `//` covers the rest. A
 * trailing `// ...` after code on the same line is left in place, which is the
 * safe direction to err: it can only ever produce a false positive we would
 * then look at, never a false negative that lets coupling through.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*");
    })
    .join("\n");
}

async function collectSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectSourceFiles(full)));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const files = (await collectSourceFiles(srcRoot)).map((full) => ({
  path: relative(repoRoot, full).split(sep).join("/"),
  code: stripComments(readFileSync(full, "utf8")),
}));

/** Every file except the adapter — the set that must stay Headroom-free. */
const others = files.filter((f) => f.path !== ADAPTER);

describe("Headroom isolation (CLAUDE.md hard rule)", () => {
  it("finds the adapter where the rule says it is", () => {
    // If the adapter is ever renamed or split into a directory, this fails
    // first and loudly — rather than every check below silently passing
    // because `others` quietly grew to include the real adapter.
    expect(files.map((f) => f.path)).toContain(ADAPTER);
  });

  it("no module outside the adapter imports a Headroom package", () => {
    // Only BARE specifiers count. Importing the adapter's own public classes
    // by relative path (`../compression/headroom-adapter.js`) is the rule
    // working as intended — callers reach Headroom THROUGH the adapter — so
    // `./`-prefixed and `node:` specifiers are excluded. What must never
    // appear is a bare `headroom-ai`-style package import, which would mean a
    // second module talking to Headroom directly.
    const bareHeadroomImport = /(?:from|import\()\s*["'](?!\.|node:)[^"']*headroom[^"']*["']/i;
    const offenders = others.filter((f) => bareHeadroomImport.test(f.code)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("no module outside the adapter names a Headroom worker script", () => {
    const offenders = others
      .filter((f) => /headroom(?:-memory)?-worker\.py/i.test(f.code))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("no module outside the adapter spawns a Headroom process", () => {
    const offenders = others
      .filter((f) => /headroom-ai/i.test(f.code) && /child_process|\bspawn\s*\(/.test(f.code))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("the adapter really is the one that spawns it (the rule is not vacuous)", () => {
    // Guards against the checks above passing because the sidecar was deleted
    // or the spawn moved somewhere this test does not look.
    const adapter = files.find((f) => f.path === ADAPTER);
    expect(adapter?.code).toMatch(/headroom-ai/);
    expect(adapter?.code).toMatch(/child_process|\bspawn\s*\(/);
  });
});

describe("Headroom pin agreement", () => {
  it("every manifest row pins the same sidecar version as the constant", () => {
    const rows = PKG_MANIFESTS.filter((p) => p.pin?.includes("headroom-ai"));
    // Both the compression sidecar and the [memory] sidecar carry a pin.
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect(row.pin).toContain(`==${HEADROOM_SIDECAR_PYPI_PIN}`);
    }
  });
});
