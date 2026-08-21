/**
 * docs-slider-drift — `golem wiki check`'s retired-identifier rule.
 *
 * The table below is the specification: what must fail, and — more important —
 * what must NOT. A check that fires on correct prose is a check the next agent
 * switches off, so every exemption has a case of its own here.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkWiki,
  findRetiredIdentifiers,
  isProseScanned,
  resolveWikiDir,
  splitProseUnits,
} from "../../../src/cli/wiki.js";
import { rmTemp } from "../../helpers/tmp.js";

let projectDir: string;
beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "golem-wiki-retired-"));
});
afterEach(async () => {
  await rm(projectDir, rmTemp);
});

const OK_FM = {
  title: "Prompt Caching",
  type: "concept",
  tags: "[cache]",
  sources: "[]",
  created: "2026-07-10",
  updated: "2026-07-10",
};

async function writePage(
  wikiDir: string,
  relPath: string,
  frontmatter: Record<string, string>,
  body: string,
): Promise<void> {
  const lines = [
    "---",
    ...Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`),
    "---",
    "",
    body,
  ];
  await mkdir(path.dirname(path.join(wikiDir, relPath)), { recursive: true });
  await writeFile(path.join(wikiDir, relPath), lines.join("\n"), "utf8");
}

describe("findRetiredIdentifiers", () => {
  const CASES: Array<{ name: string; body: string; expected: number }> = [
    {
      name: "flags drift in plain prose",
      body: "Golem forwards byte-faithfully at slider level <= 1.",
      expected: 1,
    },
    {
      name: "flags a retired command inside a fenced example (fences are NOT stripped)",
      body: "Set it up:\n\n```sh\ngolem slider 3\n```\n",
      expected: 1,
    },
    {
      name: "flags a retired settings key",
      body: "Write `slider.level` into the project settings file.",
      expected: 1,
    },
    {
      name: "flags the camelCase spelling too",
      body: "The webview calls setSliderLevel on the bridge.",
      expected: 1,
    },
    {
      name: "does NOT flag the compression dial, which is still a 0-3 level",
      body: "Compression is a 0-3 dial: level 1 (lossless), level 3 (aggressive).",
      expected: 0,
    },
    {
      name: "does NOT flag set-vs-effective compression reporting",
      body: "Compression: 3 (aggressive) -> effectively 1 (lossless) on a caching upstream.",
      expected: 0,
    },
    {
      name: "does NOT flag a paragraph that names the retirement",
      body: "ADR-0004 retired the slider; `slider.level: 0` became `proxy.bypass_all`.",
      expected: 0,
    },
    {
      name: "does NOT flag a heading whose paragraph names the retirement",
      body: "## What happened to the slider\n\nUntil R11.1 it was a preset over the slider's two dials.\n",
      expected: 0,
    },
    {
      name: "DOES flag a heading whose paragraph does not name the retirement",
      body: "## What the slider does\n\nIt presets both dials at once.\n",
      expected: 1,
    },
    {
      name: "a heading followed by a LIST leaves every item independently checked",
      body: "## Index\n\n- debriefs/2026-08-20-x.md — the slider is retired\n- [[Compression Levels]] — the slider never engages the local model\n",
      expected: 1,
    },
    {
      name: "does NOT flag a list item citing a dated record",
      body: "- debriefs/2026-07-30-brevity-dial.md — the slider becomes a preset over two dials\n",
      expected: 0,
    },
    {
      name: "does NOT flag a table row citing a decision record",
      body: "| what | where |\n|---|---|\n| slider | docs/decisions/ADR-0004-retire-the-slider.md |\n",
      expected: 0,
    },
    {
      name: "does NOT flag a unit citing the plan tree or verification notes",
      body: "- see docs/plan/tasks/R11.1.md and verification-notes.md for the slider numbers\n",
      expected: 0,
    },
    {
      name: "flags each drifting unit separately",
      body: "The slider is the headline control.\n\n- `golem slider` sets it\n",
      expected: 2,
    },
    { name: "clean prose reports nothing", body: "Redaction always runs first.", expected: 0 },
    {
      name: "does NOT flag an unexempted mention once it is under a Decisions Log heading",
      body: "## 9. Decisions Log\n\n1. The slider was 0-3 with level 0 as full bypass.\n",
      expected: 0,
    },
    {
      name: "STILL flags an unexempted mention before the Decisions Log heading",
      body: "The slider is the headline control.\n\n## 9. Decisions Log\n\n1. History.\n",
      expected: 1,
    },
    {
      name: "the Decisions Log heading match is case-insensitive and allows a heading level/prefix",
      body: "#### decisions log\n\n1. slider notes here.\n",
      expected: 0,
    },
  ];

  for (const { name, body, expected } of CASES) {
    it(name, () => {
      expect(findRetiredIdentifiers("concepts/Example.md", body)).toHaveLength(expected);
    });
  }

  it("reports the offending line and points at the replacement", () => {
    const issues = findRetiredIdentifiers("README.md", "one\n\ntwo\n\nthe slider level\n");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("(line 5)");
    expect(issues[0]?.message).toContain("compression.level");
  });
});

describe("isProseScanned", () => {
  it("scans teaching prose and skips the dated-record zones", () => {
    expect(isProseScanned("WIKI.md")).toBe(true);
    expect(isProseScanned("concepts/Compression.md")).toBe(true);
    expect(isProseScanned("entities/Headroom.md")).toBe(true);
    expect(isProseScanned("debriefs/2026-08-20-R11.1.md")).toBe(false);
    expect(isProseScanned("syntheses/r5-batch.md")).toBe(false);
    expect(isProseScanned("sources/agentic-token-saving-techniques.md")).toBe(false);
  });
});

describe("splitProseUnits", () => {
  it("keeps every list item its own unit so one exemption cannot cover the list", () => {
    const units = splitProseUnits("- a\n- b\n  wrapped\n- c\n");
    expect(units.map((u) => u.startLine)).toEqual([1, 2, 4]);
    expect(units[1]?.text).toBe("- b\n  wrapped");
  });

  it("joins a heading to the paragraph under it, across the blank line", () => {
    const units = splitProseUnits("# H\n\nbody one\nstill one\n\nsecond\n");
    expect(units).toHaveLength(2);
    expect(units[0]?.text).toBe("# H\nbody one\nstill one");
    expect(units[1]?.text).toBe("second");
  });
});

describe("checkWiki + prose outside the wiki", () => {
  it("lints README.md only when a projectDir is given", async () => {
    const wikiDir = resolveWikiDir(projectDir, "docs/wiki");
    await writePage(wikiDir, "concepts/Other.md", { ...OK_FM, title: "Other" }, "See [[Other]].");
    await writeFile(
      path.join(projectDir, "README.md"),
      "Forwarded byte-faithfully at slider level <= 1.\n",
      "utf8",
    );

    const without = await checkWiki(wikiDir);
    expect(without.issues).toEqual([]);
    expect(without.proseChecked).toBeUndefined();

    const withProse = await checkWiki(wikiDir, { projectDir });
    expect(withProse.proseChecked).toBe(1);
    expect(withProse.issues).toHaveLength(1);
    expect(withProse.issues[0]?.relPath).toBe("README.md");
  });

  it("flags a retired identifier on a wiki page but not in a debrief", async () => {
    const wikiDir = resolveWikiDir(projectDir, "docs/wiki");
    await writePage(
      wikiDir,
      "concepts/Other.md",
      { ...OK_FM, title: "Other" },
      "See [[Other]].\n\nRun `golem slider 3` to raise it.",
    );
    await writePage(
      wikiDir,
      "debriefs/2026-08-01-x.md",
      { ...OK_FM, title: "Debrief", type: "debrief" },
      "See [[Other]].\n\nWe shipped `golem slider 3`.",
    );
    const report = await checkWiki(wikiDir);
    const retired = report.issues.filter((i) => i.message.startsWith("retired identifier"));
    expect(retired).toHaveLength(1);
    expect(retired[0]?.relPath).toBe("concepts/Other.md");
  });

  it("still lints a drifting README when no wiki has been scaffolded", async () => {
    await writeFile(path.join(projectDir, "README.md"), "the slider level\n", "utf8");
    const report = await checkWiki(resolveWikiDir(projectDir, "docs/wiki"), { projectDir });
    expect(report.pagesChecked).toBe(0);
    expect(report.issues).toHaveLength(1);
  });
});
