/**
 * WS-B task B2 — CLAUDE.md guidance-section writer: idempotent
 * replace-between-markers, preserves surrounding prose.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InitError } from "../../../src/cli/init.js";
import {
  GUIDANCE_BEGIN_MARKER,
  GUIDANCE_END_MARKER,
  upsertGuidance,
  writeGuidanceSection,
} from "../../../src/hooks/index.js";

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "golem-guidance-"));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

function countMarkers(text: string): number {
  return text.split(GUIDANCE_BEGIN_MARKER).length - 1;
}

describe("upsertGuidance (pure)", () => {
  it("creates a section when the file is absent", () => {
    const out = upsertGuidance(null);
    expect(countMarkers(out)).toBe(1);
    expect(out).toContain("expand");
    expect(out).toContain(GUIDANCE_END_MARKER);
  });

  it("guides Claude to the wiki before search and search before WebFetch (Decision 28)", () => {
    const out = upsertGuidance(null);
    const wikiIdx = out.indexOf("Check the wiki first");
    const searchIdx = out.indexOf("`search` MCP tool");
    const webFetchIdx = out.indexOf("Then WebFetch or external docs");
    expect(wikiIdx).toBeGreaterThan(-1);
    expect(searchIdx).toBeGreaterThan(wikiIdx);
    expect(webFetchIdx).toBeGreaterThan(searchIdx);
  });

  it("tells Claude to skim the wiki's own index at the start of a session", () => {
    const out = upsertGuidance(null);
    expect(out).toContain("WIKI.md` Index once");
  });

  it("directs captures (fetch/ingest/note) toward wiki promotion with real wikilinks", () => {
    const out = upsertGuidance(null);
    expect(out).toContain("`ingest` tool");
    expect(out).toContain("`golem note`");
    expect(out).toContain("add real `[[wikilinks]]`");
  });

  it("directs coding work to the local model via delegate once the level allows it", () => {
    const out = upsertGuidance(null);
    expect(out).toContain("prefer the local model for coding drafts");
    expect(out).toContain("`delegate`");
    expect(out).toContain("level 3");
    // Deliberately no repo-specific hardware/GPU-pacing rules in the generic template.
    expect(out.toLowerCase()).not.toContain("gpu");
  });

  it("appends after existing prose without disturbing it", () => {
    const existing = "# My project\n\nSome notes.\n";
    const out = upsertGuidance(existing);
    expect(out.startsWith(existing)).toBe(true);
    expect(countMarkers(out)).toBe(1);
  });

  it("replaces between markers in place (idempotent, single section)", () => {
    const first = upsertGuidance("# Title\n\nintro\n");
    const second = upsertGuidance(first);
    expect(second).toBe(first);
    expect(countMarkers(second)).toBe(1);
  });

  it("replaces only the fenced region, keeping text before and after", () => {
    const before = "# Title\n\n";
    const after = "\n\n## Other section\n\nkeep me\n";
    const stale = `${before}${GUIDANCE_BEGIN_MARKER}\nOLD CONTENT\n${GUIDANCE_END_MARKER}${after}`;
    const out = upsertGuidance(stale);
    expect(out.startsWith(before)).toBe(true);
    expect(out.endsWith(after)).toBe(true);
    expect(out).not.toContain("OLD CONTENT");
    expect(out).toContain("expand");
    expect(countMarkers(out)).toBe(1);
  });

  it("throws on a dangling begin marker rather than guessing", () => {
    expect(() => upsertGuidance(`intro\n${GUIDANCE_BEGIN_MARKER}\nunterminated`)).toThrow(
      InitError,
    );
  });
});

describe("writeGuidanceSection", () => {
  it("creates CLAUDE.md then reports skip when run twice", async () => {
    const first = await writeGuidanceSection({ projectDir });
    expect(first.kind).toBe("create");

    const second = await writeGuidanceSection({ projectDir });
    expect(second.kind).toBe("skip");

    const text = await readFile(path.join(projectDir, "CLAUDE.md"), "utf8");
    expect(countMarkers(text)).toBe(1);
  });

  it("modifies an existing CLAUDE.md, preserving its content", async () => {
    const file = path.join(projectDir, "CLAUDE.md");
    await writeFile(file, "# Existing\n\nkeep this line\n", "utf8");
    const action = await writeGuidanceSection({ projectDir });
    expect(action.kind).toBe("modify");
    const text = await readFile(file, "utf8");
    expect(text).toContain("keep this line");
    expect(countMarkers(text)).toBe(1);
  });

  it("does not write in dry-run mode", async () => {
    const action = await writeGuidanceSection({ projectDir, dryRun: true });
    expect(action.kind).toBe("create");
    await expect(readFile(path.join(projectDir, "CLAUDE.md"), "utf8")).rejects.toThrow();
  });
});
