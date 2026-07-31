/**
 * Task `snooze-taskadd` — `snooze`'s own `note` is the park procedure's documenting
 * step, because enforcement (Decision 45) denies the `Bash` running
 * `golem task add`. These assert the note lands as an ordinary local task and that
 * a write failure never becomes an exception (the caller must still be able to park).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistSnoozeNote, snoozeNoteTitle } from "../../../src/mcp/snooze-note.js";
import { FileTaskStore } from "../../../src/tasks/store.js";

const NOW_ISO = "2026-07-31T00:00:00.000Z";

describe("snoozeNoteTitle", () => {
  it("takes the first line, trimmed", () => {
    expect(snoozeNoteTitle("  batch R8.x: A done  \nnext: B\nthen: C")).toBe("batch R8.x: A done");
  });
  it("truncates past 60 chars with an ellipsis", () => {
    const title = snoozeNoteTitle("x".repeat(120));
    expect(title).toHaveLength(58); // 57 chars + the single-char ellipsis
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("persistSnoozeNote", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "golem-snooze-note-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("files the note as a queued local task readable by the ordinary store", async () => {
    const note = "R8 batch: snooze-taskadd fixed\nnext: local-models, then hook-precedence";
    const saved = await persistSnoozeNote(dir, note, { nowIso: NOW_ISO });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const stored = await new FileTaskStore(dir).get(saved.id);
    expect(stored).not.toBeNull();
    expect(stored?.state).toBe("queued");
    expect(stored?.prompt).toBe(note);
    expect(stored?.title).toBe("R8 batch: snooze-taskadd fixed");
    expect(stored?.createdAt).toBe(NOW_ISO);
    // It is a plain local task, not a plan task — closable with `golem task done`.
    expect(stored?.plan).toBeUndefined();
  });

  it("shows up in a plain `list()` — the note is not a special kind of task", async () => {
    await persistSnoozeNote(dir, "parked mid-batch", { nowIso: NOW_ISO });
    const all = await new FileTaskStore(dir).list();
    expect(all).toHaveLength(1);
    expect(all[0]?.prompt).toBe("parked mid-batch");
  });

  it("rejects an empty note as data, not as a throw", async () => {
    const saved = await persistSnoozeNote(dir, "   \n  ");
    expect(saved).toEqual({ ok: false, error: "note is empty" });
  });

  it("returns an error instead of throwing when the note cannot be written", async () => {
    // A file where the tasks dir must be: mkdir fails, so the write cannot succeed.
    // The contract is fail-OPEN — the caller still needs to park.
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(path.join(dir, ".golem"), { recursive: true });
    await writeFile(path.join(dir, ".golem", "tasks"), "not a directory", "utf8");
    const saved = await persistSnoozeNote(dir, "note that cannot land");
    expect(saved.ok).toBe(false);
  });
});
