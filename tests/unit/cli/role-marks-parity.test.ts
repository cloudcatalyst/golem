/**
 * R9.4 — the CLI status line and the VS Code status bar must use the SAME role
 * glyphs.
 *
 * They are two copies by necessity: the extension is plain CommonJS JS with no
 * build step and shares no module with the TypeScript CLI. Two copies of a
 * user-facing constant drift, and this drift would be invisible in review —
 * nothing fails, the two surfaces just quietly disagree about what a symbol
 * means, which is worse than either symbol being wrong.
 *
 * So the parity is asserted rather than trusted. If you are changing the glyphs
 * (they are placeholders), change both and this test stays green.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ROLE_MARKS } from "../../../src/cli/statusline.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Read the extension's copy out of its source, since it cannot be imported. */
async function extensionRoleMarks(): Promise<Record<string, string>> {
  const source = await readFile(path.join(REPO_ROOT, "vscode-extension", "render.js"), "utf8");
  const block = /const ROLE_MARKS = \{(.*?)\};/s.exec(source)?.[1];
  expect(block, "vscode-extension/render.js must declare ROLE_MARKS").toBeDefined();
  const marks: Record<string, string> = {};
  for (const m of (block as string).matchAll(/(\w+)\s*:\s*"([^"]*)"/g)) {
    marks[m[1] as string] = m[2] as string;
  }
  return marks;
}

describe("role marks parity (R9.4)", () => {
  it("the extension declares exactly the CLI's marks", async () => {
    expect(await extensionRoleMarks()).toEqual({ ...ROLE_MARKS });
  });

  it("every mark is a single character, so the line cannot misalign", async () => {
    // The status line renders every turn in a terminal of unknown width; a
    // multi-code-point glyph (or an emoji with a variation selector) shifts
    // everything after it.
    for (const [role, mark] of Object.entries(ROLE_MARKS)) {
      expect([...mark], `${role} must be one code point`).toHaveLength(1);
    }
  });

  it("the two roles do not share a glyph", () => {
    // Same symbol for both roles would make the flattened and two-model forms
    // indistinguishable.
    expect(new Set(Object.values(ROLE_MARKS)).size).toBe(Object.keys(ROLE_MARKS).length);
  });
});
