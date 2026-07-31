/**
 * R8.9 — `golem checkpoint`'s CLI layer: the loud preview and the consent gate.
 *
 * The preview is part of the task's gate ("loud about what it will do before it
 * does it"), so these assert the *content* of what a user sees before a
 * destructive restore, not just that a string came back.
 */

import { describe, expect, it } from "vitest";
import type { Checkpoint, RestorePlan } from "../../../src/checkpoint/index.js";
import {
  CheckpointRefusedError,
  confirmDestructive,
  renderCheckpointList,
  renderRestorePlan,
  renderRestoreResult,
} from "../../../src/cli/checkpoint.js";

const NOW = "2026-07-31T12:00:00.000Z";

const cp = (over: Partial<Checkpoint> = {}): Checkpoint => ({
  id: "20260731T113000Z",
  ref: "refs/golem/ledger/20260731T113000Z",
  commit: "0123456789abcdef0123456789abcdef01234567",
  tree: "fedcba9876543210fedcba9876543210fedcba98",
  createdIso: "2026-07-31T11:30:00.000Z",
  note: "before refactoring the parser",
  kind: "manual",
  ...over,
});

describe("renderCheckpointList", () => {
  it("teaches the create command when there is nothing yet", () => {
    const out = renderCheckpointList([], NOW, 50);
    expect(out).toContain("golem checkpoint create");
    expect(out).toContain("never commits on your");
  });

  it("shows age, note, and the plain-git escape hatch", () => {
    const out = renderCheckpointList([cp()], NOW, 50);
    expect(out).toContain("20260731T113000Z");
    expect(out).toContain("30m ago");
    expect(out).toContain("before refactoring the parser");
    expect(out).toContain("git diff refs/golem/ledger/20260731T113000Z");
    expect(out).toContain("keeping the 50 newest");
  });

  it("marks an automatic pre-restore snapshot as such", () => {
    const out = renderCheckpointList([cp({ kind: "pre-restore" })], NOW, 50);
    expect(out).toContain("[auto: pre-restore]");
  });
});

describe("renderRestorePlan", () => {
  const plan = (over: Partial<RestorePlan> = {}): RestorePlan => ({
    target: cp(),
    restore: ["src/a.ts", "src/b.ts"],
    delete: ["src/junk.ts"],
    ...over,
  });

  it("names every file it will overwrite and every file it will delete", () => {
    const out = renderRestorePlan(plan());
    expect(out).toContain("overwrite with the checkpoint's copy (2)");
    expect(out).toContain("src/a.ts");
    expect(out).toContain("DELETE (created after the checkpoint) (1)");
    expect(out).toContain("src/junk.ts");
    // The two promises that make this safe to accept.
    expect(out).toContain("index");
    expect(out).toContain("itself undoable");
  });

  it("summarises the tail rather than printing a thousand paths", () => {
    const many = Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`);
    const out = renderRestorePlan(plan({ restore: many, delete: [] }));
    expect(out).toContain("… and 18 more");
    expect(out).not.toContain("src/f20.ts");
  });

  it("says so when there is nothing to do", () => {
    const out = renderRestorePlan(plan({ restore: [], delete: [] }));
    expect(out).toContain("already matches");
  });
});

describe("renderRestoreResult", () => {
  it("points at the pre-restore checkpoint as the undo", () => {
    const safety = cp({ id: "20260731T115900Z", kind: "pre-restore" });
    const out = renderRestoreResult({
      plan: { target: cp(), restore: ["a"], delete: [] },
      safety,
      restored: 1,
      deleted: 0,
    });
    expect(out).toContain("1 file(s) written, 0 deleted");
    expect(out).toContain("golem checkpoint restore 20260731T115900Z");
  });
});

describe("confirmDestructive", () => {
  it("refuses in a non-interactive session without --yes (nothing is changed)", async () => {
    const seen: string[] = [];
    await expect(
      confirmDestructive("PREVIEW\n", "Restore?", {
        yes: false,
        isTTY: false,
        onPreview: (t) => seen.push(t),
      }),
    ).rejects.toBeInstanceOf(CheckpointRefusedError);
    // The preview is still shown — a refusal should say what it refused to do.
    expect(seen).toEqual(["PREVIEW\n"]);
  });

  it("asks in a TTY and honours the answer", async () => {
    const asked: string[] = [];
    const yes = await confirmDestructive("PREVIEW\n", "Restore?", {
      yes: false,
      isTTY: true,
      onPreview: () => {},
      confirm: async (q) => {
        asked.push(q);
        return true;
      },
    });
    expect(yes).toBe(true);
    expect(asked).toEqual(["Restore?"]);

    const no = await confirmDestructive("PREVIEW\n", "Restore?", {
      yes: false,
      isTTY: true,
      onPreview: () => {},
      confirm: async () => false,
    });
    expect(no).toBe(false);
  });

  it("--yes skips the prompt but NOT the preview", async () => {
    const seen: string[] = [];
    let prompted = false;
    const accepted = await confirmDestructive("PREVIEW\n", "Restore?", {
      yes: true,
      isTTY: false,
      onPreview: (t) => seen.push(t),
      confirm: async () => {
        prompted = true;
        return false;
      },
    });
    expect(accepted).toBe(true);
    expect(prompted).toBe(false);
    expect(seen).toEqual(["PREVIEW\n"]);
  });
});
