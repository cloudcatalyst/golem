/**
 * Capture: seeing a correction, and — mostly — refusing to see one.
 *
 * The gate for this slice is specific: a correction produces EXACTLY ONE
 * candidate carrying both sides, and a re-run over the same edit produces no
 * duplicate. Both halves are load-bearing. Without the first the signal is
 * wrong; without the second the quiz threshold stops meaning "this recurred",
 * because a single edit swept twice would cross it on its own.
 *
 * The other half of these tests is everything capture must NOT claim. An edit
 * that says nothing about style has to produce nothing at all — that is the
 * difference between a queue the human reads and one they learn to ignore.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  loadCandidates,
  openVibeStore,
  pendingLedgerPath,
  quizzable,
  recordAgentWrite,
  rejectCandidate,
  sweepCorrections,
  type VibeStore,
  writeTargetPath,
} from "../../src/vibe/index.js";
import { useTempDirs } from "../helpers/tmp.js";

const newTempDir = useTempDirs("golem-vc");

/** Double-quoted, semicolon-terminated — what the agent wrote. */
const AGENT_VERSION = [
  'const alpha = "one";',
  'const beta = "two";',
  'const gamma = "three";',
  'const delta = "four";',
].join("\n");

/** The same file after the human switched it to single quotes. */
const HUMAN_VERSION = [
  "const alpha = 'one';",
  "const beta = 'two';",
  "const gamma = 'three';",
  "const delta = 'four';",
].join("\n");

describe("capture", () => {
  let base: string;
  let projectDir: string;
  let userDir: string;
  let store: VibeStore;
  let file: string;

  beforeEach(async () => {
    base = await newTempDir();
    projectDir = path.join(base, "project");
    userDir = path.join(base, "home", ".golem");
    await mkdir(path.join(projectDir, ".golem"), { recursive: true });
    await writeFile(path.join(projectDir, ".golem", "settings.json"), "{}\n", "utf8");
    const opened = openVibeStore({ cwd: projectDir, userDir, rootDir: base });
    if (opened === null) throw new Error("fixture is not a Golem project");
    store = opened;
    file = path.join(projectDir, "sample.ts");
  });

  /** The agent writes, the human edits. The shape every test here starts from. */
  async function agentWroteThenHumanEdited(after = HUMAN_VERSION): Promise<void> {
    await writeFile(file, AGENT_VERSION, "utf8");
    await recordAgentWrite(projectDir, file, AGENT_VERSION, "2026-09-13T10:00:00.000Z");
    await writeFile(file, after, "utf8");
  }

  it("turns a correction into exactly one candidate carrying both sides", async () => {
    await agentWroteThenHumanEdited();

    const result = await sweepCorrections(projectDir, store, "2026-09-13T10:05:00.000Z");

    expect(result.corrected).toEqual([file]);
    const candidates = await loadCandidates(store);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      kind: "quotes",
      from: "double",
      to: "single",
      seen: 1,
      state: "open",
    });
    expect(candidates[0]?.files).toEqual([file]);
  });

  it("does not double-count the same edit when swept again", async () => {
    await agentWroteThenHumanEdited();

    await sweepCorrections(projectDir, store, "2026-09-13T10:05:00.000Z");
    await sweepCorrections(projectDir, store, "2026-09-13T10:06:00.000Z");
    await sweepCorrections(projectDir, store, "2026-09-13T10:07:00.000Z");

    const candidates = await loadCandidates(store);
    expect(candidates).toHaveLength(1);
    // Still ONE sighting. Re-baselining after a sweep is what makes this true,
    // and without it the quiz threshold would be met by a single correction.
    expect(candidates[0]?.seen).toBe(1);
  });

  it("counts a second, genuinely separate correction", async () => {
    await agentWroteThenHumanEdited();
    await sweepCorrections(projectDir, store, "2026-09-13T10:05:00.000Z");

    const second = path.join(projectDir, "other.ts");
    await writeFile(second, AGENT_VERSION, "utf8");
    await recordAgentWrite(projectDir, second, AGENT_VERSION, "2026-09-13T11:00:00.000Z");
    await writeFile(second, HUMAN_VERSION, "utf8");
    await sweepCorrections(projectDir, store, "2026-09-13T11:05:00.000Z");

    const candidates = await loadCandidates(store);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.seen).toBe(2);
    expect(candidates[0]?.files).toHaveLength(2);
  });

  it("says nothing about an edit that says nothing about style", async () => {
    await writeFile(file, AGENT_VERSION, "utf8");
    await recordAgentWrite(projectDir, file, AGENT_VERSION, "2026-09-13T10:00:00.000Z");
    // A real edit — renamed identifiers — with every style choice preserved.
    await writeFile(file, AGENT_VERSION.replace(/alpha/g, "renamed"), "utf8");

    const result = await sweepCorrections(projectDir, store, "2026-09-13T10:05:00.000Z");

    expect(result.corrected).toEqual([file]);
    expect(result.signals).toEqual([]);
    expect(await loadCandidates(store)).toEqual([]);
  });

  it("records nothing at all when the file is untouched", async () => {
    await writeFile(file, AGENT_VERSION, "utf8");
    await recordAgentWrite(projectDir, file, AGENT_VERSION, "2026-09-13T10:00:00.000Z");

    const result = await sweepCorrections(projectDir, store, "2026-09-13T10:05:00.000Z");

    expect(result.corrected).toEqual([]);
    expect(await loadCandidates(store)).toEqual([]);
  });

  it("never resurrects a tombstoned preference", async () => {
    await agentWroteThenHumanEdited();
    await sweepCorrections(projectDir, store, "2026-09-13T10:05:00.000Z");
    const key = (await loadCandidates(store))[0]?.key;
    if (key === undefined) throw new Error("expected a candidate to reject");
    await rejectCandidate(store, key, "2026-09-13T10:06:00.000Z");

    // The same correction happens again, in another file.
    const second = path.join(projectDir, "other.ts");
    await writeFile(second, AGENT_VERSION, "utf8");
    await recordAgentWrite(projectDir, second, AGENT_VERSION, "2026-09-13T11:00:00.000Z");
    await writeFile(second, HUMAN_VERSION, "utf8");
    const result = await sweepCorrections(projectDir, store, "2026-09-13T11:05:00.000Z");

    expect(result.signals).toEqual([]);
    const candidates = await loadCandidates(store);
    expect(candidates[0]?.state).toBe("rejected");
    expect(candidates[0]?.seen).toBe(1);
    expect(await quizzable(store)).toEqual([]);
  });

  it("drops a tracked file that has gone away, without failing the sweep", async () => {
    await writeFile(file, AGENT_VERSION, "utf8");
    await recordAgentWrite(projectDir, file, AGENT_VERSION, "2026-09-13T10:00:00.000Z");
    await rm(file);

    const result = await sweepCorrections(projectDir, store, "2026-09-13T10:05:00.000Z");

    expect(result.dropped).toEqual([file]);
    const ledger = JSON.parse(await readFile(pendingLedgerPath(projectDir), "utf8")) as {
      files: Record<string, unknown>;
    };
    expect(Object.keys(ledger.files)).toEqual([]);
  });

  it("carries untouched entries through a narrowed sweep rather than forgetting them", async () => {
    // A narrowed sweep rebuilds the ledger. If it rebuilt from the subset, every
    // other file the agent had written would be silently untracked.
    const other = path.join(projectDir, "other.ts");
    await writeFile(file, AGENT_VERSION, "utf8");
    await writeFile(other, AGENT_VERSION, "utf8");
    await recordAgentWrite(projectDir, file, AGENT_VERSION, "2026-09-13T10:00:00.000Z");
    await recordAgentWrite(projectDir, other, AGENT_VERSION, "2026-09-13T10:00:01.000Z");
    await writeFile(file, HUMAN_VERSION, "utf8");

    await sweepCorrections(projectDir, store, "2026-09-13T10:05:00.000Z", [file]);

    const ledger = JSON.parse(await readFile(pendingLedgerPath(projectDir), "utf8")) as {
      files: Record<string, unknown>;
    };
    expect(Object.keys(ledger.files).sort()).toEqual([file, other].sort());
  });

  it("keeps the ledger out of the guide — readings only, never source", async () => {
    await writeFile(file, AGENT_VERSION, "utf8");
    await recordAgentWrite(projectDir, file, AGENT_VERSION, "2026-09-13T10:00:00.000Z");

    const raw = await readFile(pendingLedgerPath(projectDir), "utf8");

    expect(raw).not.toContain("const alpha");
    expect(pendingLedgerPath(projectDir).startsWith(projectDir)).toBe(true);
  });
});

describe("writeTargetPath", () => {
  it("reads the spellings Claude Code actually sends", () => {
    expect(writeTargetPath({ file_path: "a.ts" })).toBe("a.ts");
    expect(writeTargetPath({ notebook_path: "b.ipynb" })).toBe("b.ipynb");
  });

  it("returns null on a shape it does not recognise, rather than guessing", () => {
    expect(writeTargetPath({ unexpected: "a.ts" })).toBeNull();
    expect(writeTargetPath(null)).toBeNull();
    expect(writeTargetPath("a.ts")).toBeNull();
    expect(writeTargetPath({ file_path: "   " })).toBeNull();
  });
});
