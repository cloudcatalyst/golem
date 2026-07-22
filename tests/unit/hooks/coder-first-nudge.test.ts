/**
 * Coder-first enforcement trigger (Decision 39): the pure detection/decision
 * logic + one-shot-per-session state I/O behind the PreToolUse coder-first gate.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  coderFirstNudgeReason,
  coderFirstNudgeStatePath,
  decideCoderFirstNudge,
  isCodeDraftTarget,
  MIN_CODE_DRAFT_CHARS,
  readCoderFirstNudgeState,
  writeCoderFirstNudgeState,
} from "../../../src/hooks/coder-first-nudge.js";

const big = (n: number) => "x".repeat(n);
const OVER = MIN_CODE_DRAFT_CHARS + 60;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "golem-coderfirst-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("isCodeDraftTarget", () => {
  it("flags a substantial Write to a code file", () => {
    const r = isCodeDraftTarget("Write", { file_path: "src/x.ts", content: big(OVER) });
    expect(r).toEqual({ isCode: true, contentLength: OVER });
  });

  it("treats a small write as trivial (below the char threshold)", () => {
    const r = isCodeDraftTarget("Write", { file_path: "src/x.ts", content: big(100) });
    expect(r).toEqual({ isCode: false, contentLength: 100 });
  });

  it("excludes declaration files (.d.ts) even when large", () => {
    expect(isCodeDraftTarget("Write", { file_path: "src/x.d.ts", content: big(OVER) }).isCode).toBe(
      false,
    );
  });

  it("excludes non-code files (.md) even when large", () => {
    expect(isCodeDraftTarget("Write", { file_path: "docs/x.md", content: big(OVER) }).isCode).toBe(
      false,
    );
  });

  it("uses new_string length for an Edit to a code file", () => {
    const r = isCodeDraftTarget("Edit", { file_path: "src/x.tsx", new_string: big(OVER) });
    expect(r).toEqual({ isCode: true, contentLength: OVER });
  });

  it("ignores non-Write/Edit tools", () => {
    expect(isCodeDraftTarget("Read", { file_path: "src/x.ts", content: big(OVER) }).isCode).toBe(
      false,
    );
  });

  it("narrows a non-object toolInput safely", () => {
    for (const bad of [null, "str", 42, ["a"]] as unknown[]) {
      expect(isCodeDraftTarget("Write", bad)).toEqual({ isCode: false, contentLength: 0 });
    }
  });

  it("handles a missing content field (contentLength 0)", () => {
    expect(isCodeDraftTarget("Write", { file_path: "src/x.ts" })).toEqual({
      isCode: false,
      contentLength: 0,
    });
  });
});

describe("decideCoderFirstNudge", () => {
  it("nudges on non-trivial code in a new session and returns the key to persist", () => {
    expect(decideCoderFirstNudge({ isCode: true }, undefined, "s1")).toEqual({
      nudge: true,
      sessionKey: "s1",
    });
  });

  it("is one-shot: no nudge when this session already nudged", () => {
    expect(decideCoderFirstNudge({ isCode: true }, "s1", "s1")).toEqual({ nudge: false });
  });

  it("never nudges when the target is not code", () => {
    expect(decideCoderFirstNudge({ isCode: false }, undefined, "s1")).toEqual({ nudge: false });
  });

  it("one-shots even with a missing session id (stable fallback key)", () => {
    const first = decideCoderFirstNudge({ isCode: true }, undefined, undefined);
    expect(first.nudge).toBe(true);
    expect(typeof first.sessionKey).toBe("string");
    expect((first.sessionKey ?? "").length).toBeGreaterThan(0);
    // Feed the recorded key back → the missing-id session is now consumed.
    expect(decideCoderFirstNudge({ isCode: true }, first.sessionKey, undefined)).toEqual({
      nudge: false,
    });
  });
});

describe("coderFirstNudgeReason", () => {
  it("marks itself, names the coder tool, and tells an already-drafted agent to proceed", () => {
    const reason = coderFirstNudgeReason();
    expect(reason.startsWith("**Golem** ")).toBe(true);
    expect(reason).toContain("`coder`");
    expect(reason.toLowerCase()).toContain("already drafted");
  });
});

describe("coder-first-nudge state I/O", () => {
  it("round-trips the nudged session id", async () => {
    expect(await readCoderFirstNudgeState(dir)).toBeUndefined();
    await writeCoderFirstNudgeState(dir, "sess-9");
    expect(await readCoderFirstNudgeState(dir)).toBe("sess-9");
  });

  it("fails open (undefined) on a corrupt state file", async () => {
    const file = coderFirstNudgeStatePath(dir);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{ not json", "utf8");
    expect(await readCoderFirstNudgeState(dir)).toBeUndefined();
  });
});
