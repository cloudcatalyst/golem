/**
 * T4 (W3b, spec Decision 20f) — `golem note` capture engine.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendNote,
  findNoteByTs,
  listNotes,
  listNotesSince,
  notesFilePath,
  renderNotes,
} from "../../../src/cli/notes.js";

let projectDir: string;
beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "golem-notes-"));
});
afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe("appendNote", () => {
  it("appends a JSONL line under .golem/notes/notes.jsonl", async () => {
    const entry = await appendNote(
      projectDir,
      "explore graph-first search",
      "2026-07-10T00:00:00.000Z",
    );
    expect(entry).toEqual({ ts: "2026-07-10T00:00:00.000Z", text: "explore graph-first search" });

    const raw = await readFile(notesFilePath(projectDir), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(raw.trim())).toEqual(entry);
  });

  it("redacts secrets before storing (pipeline redaction rule table)", async () => {
    const fakeAwsKey = `AKIA${"ABCDEFGHIJ1234KL"}`;
    const entry = await appendNote(
      projectDir,
      `remember key ${fakeAwsKey}`,
      "2026-07-10T00:00:00.000Z",
    );
    expect(entry.text).not.toContain(fakeAwsKey);
    expect(entry.text).toContain("REDACTED:aws-key");

    const raw = await readFile(notesFilePath(projectDir), "utf8");
    expect(raw).not.toContain(fakeAwsKey);
  });

  it("creates the .golem/notes directory on first capture", async () => {
    await appendNote(projectDir, "first note", "2026-07-10T00:00:00.000Z");
    await appendNote(projectDir, "second note", "2026-07-10T00:00:01.000Z");
    const raw = await readFile(notesFilePath(projectDir), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(2);
  });
});

describe("listNotes", () => {
  it("returns an empty array when no notes exist yet", async () => {
    expect(await listNotes(projectDir)).toEqual([]);
  });

  it("returns notes newest-first, capped at the limit", async () => {
    for (let i = 0; i < 5; i++) {
      await appendNote(projectDir, `note ${i}`, `2026-07-10T00:00:0${i}.000Z`);
    }
    const all = await listNotes(projectDir);
    expect(all.map((e) => e.text)).toEqual(["note 4", "note 3", "note 2", "note 1", "note 0"]);

    const capped = await listNotes(projectDir, 2);
    expect(capped.map((e) => e.text)).toEqual(["note 4", "note 3"]);
  });

  it("skips corrupt trailing lines instead of throwing", async () => {
    await appendNote(projectDir, "good note", "2026-07-10T00:00:00.000Z");
    const { appendFile } = await import("node:fs/promises");
    await appendFile(notesFilePath(projectDir), "not-json\n", "utf8");
    const entries = await listNotes(projectDir);
    expect(entries.map((e) => e.text)).toEqual(["good note"]);
  });
});

describe("findNoteByTs", () => {
  it("returns null when the notes log doesn't exist yet", async () => {
    expect(await findNoteByTs(projectDir, "2026-07-10T00:00:00.000Z")).toBeNull();
  });

  it("finds the note with the exact matching timestamp", async () => {
    await appendNote(projectDir, "note 0", "2026-07-10T00:00:00.000Z");
    await appendNote(projectDir, "note 1", "2026-07-10T00:00:01.000Z");
    expect(await findNoteByTs(projectDir, "2026-07-10T00:00:01.000Z")).toEqual({
      ts: "2026-07-10T00:00:01.000Z",
      text: "note 1",
    });
  });

  it("returns null when no note has that timestamp", async () => {
    await appendNote(projectDir, "note 0", "2026-07-10T00:00:00.000Z");
    expect(await findNoteByTs(projectDir, "2026-07-10T09:99:99.000Z")).toBeNull();
  });
});

describe("listNotesSince", () => {
  it("returns an empty array when the notes log doesn't exist yet", async () => {
    expect(await listNotesSince(projectDir, "2026-07-10T00:00:00.000Z")).toEqual([]);
  });

  it("returns only notes at or after the cutoff, newest first", async () => {
    for (let i = 0; i < 5; i++) {
      await appendNote(projectDir, `note ${i}`, `2026-07-10T00:00:0${i}.000Z`);
    }
    const since = await listNotesSince(projectDir, "2026-07-10T00:00:02.000Z");
    expect(since.map((e) => e.text)).toEqual(["note 4", "note 3", "note 2"]);
  });

  it("skips corrupt trailing lines instead of throwing", async () => {
    await appendNote(projectDir, "good note", "2026-07-10T00:00:00.000Z");
    const { appendFile } = await import("node:fs/promises");
    await appendFile(notesFilePath(projectDir), "not-json\n", "utf8");
    const entries = await listNotesSince(projectDir, "2026-07-09T00:00:00.000Z");
    expect(entries.map((e) => e.text)).toEqual(["good note"]);
  });
});

describe("renderNotes", () => {
  it("renders a friendly message when there are no notes", () => {
    expect(renderNotes([])).toContain("No notes captured yet");
  });

  it("renders one line per note with its timestamp", () => {
    const out = renderNotes([{ ts: "2026-07-10T00:00:00.000Z", text: "hello" }]);
    expect(out).toBe("[2026-07-10T00:00:00.000Z] hello\n");
  });
});
