/**
 * The shipped log must have exactly one home.
 *
 * `CLAUDE.md` and `.claude/rules/golem-close-out-checklist.md` both said to add a
 * row to "**SHIPPED.md**" without a path, while the `/golem/ship` skill and
 * `src/cli/skills/close-out.ts` both named `docs/plan/SHIPPED.md`. So a second
 * log grew at the repo root and ran for three weeks: R8.11, R8.14, every R10.12→
 * R10.24 row and all of R11 landed there, while R9.x, `docs-slider-drift` and
 * R12.6 landed in the canonical file. Neither file was a complete record, and
 * whichever one an agent happened to open decided where its row went.
 *
 * Same class as the retired-slider drift: an ambiguous instruction, no check.
 * These assert the invariant rather than the wording — one log, and the docs that
 * tell an agent where to write it name the full path.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CANONICAL = "docs/plan/SHIPPED.md";

/** Docs that instruct an agent to write a shipped row. */
const INSTRUCTION_FILES = [
  "CLAUDE.md",
  ".claude/rules/golem-close-out-checklist.md",
  ".claude/skills/golem/ship/SKILL.md",
];

describe("the shipped log has exactly one home", () => {
  it("keeps the canonical log where the ship skill and close-out code point", async () => {
    expect(existsSync(path.join(repoRoot, CANONICAL))).toBe(true);
    const body = await readFile(path.join(repoRoot, CANONICAL), "utf8");
    expect(body).toContain("| ");
  });

  it("has no competing log at the repo root", () => {
    // Reintroducing this file is the actual regression: two logs, each partial.
    expect(existsSync(path.join(repoRoot, "SHIPPED.md"))).toBe(false);
  });

  it("names the full path everywhere an agent is told to write a row", async () => {
    for (const file of INSTRUCTION_FILES) {
      const abs = path.join(repoRoot, file);
      if (!existsSync(abs)) continue;
      const body = await readFile(abs, "utf8");
      if (!/SHIPPED\.md/.test(body)) continue;
      // Every mention must carry the directory, so "SHIPPED.md" alone cannot be
      // read as a root-relative path.
      for (const match of body.matchAll(/(.{0,20})SHIPPED\.md/g)) {
        expect(match[1], `${file}: bare "SHIPPED.md" reference — use ${CANONICAL}`).toContain(
          "docs/plan/",
        );
      }
    }
  });

  it("still records the rows migrated out of the root log", async () => {
    // Spot-check the two ends of the migrated range: losing these silently is the
    // failure mode a delete-and-move-on would have caused.
    const body = await readFile(path.join(repoRoot, CANONICAL), "utf8");
    expect(body).toMatch(/R11\.1/);
    expect(body).toMatch(/R8\.11/);
  });
});
