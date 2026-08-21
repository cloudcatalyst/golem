/**
 * R5.4 — action classifier (ADR-0002 conservative allow-list).
 */

import { describe, expect, it } from "vitest";
import { classifyAction, classifyBash } from "../../../src/autonomy/index.js";

describe("classifyAction (tools)", () => {
  it("classifies read-only tools as read", () => {
    for (const t of [
      "Read",
      "Grep",
      "Glob",
      "WebFetch",
      "mcp__golem__search",
      "mcp__golem__snooze",
    ]) {
      expect(classifyAction(t, {})).toBe("read");
    }
  });
  it("classifies file/local-write tools as write", () => {
    for (const t of ["Edit", "Write", "NotebookEdit", "mcp__golem__coder"]) {
      expect(classifyAction(t, {})).toBe("write");
    }
  });
  it("classifies wiki_upsert (external-ish) as outward", () => {
    expect(classifyAction("mcp__golem__wiki_upsert", {})).toBe("outward");
  });
  it("gates the retired `level` tool like any unrecognized tool (R11.1)", () => {
    // The tool went with the slider. Nothing can reach redaction through a dial
    // now (ADR-0004), so there is no level to classify — and the fall-through is
    // `unknown` (gated), stricter than the `write` a level call used to earn.
    expect(classifyAction("mcp__golem__level", { level: 1 })).toBe("unknown");
    expect(classifyAction("mcp__golem__level", { level: 0 })).toBe("unknown");
  });
  it("treats an unrecognized tool as unknown (fail-closed)", () => {
    expect(classifyAction("SomeNewTool", {})).toBe("unknown");
  });
  it("treats Bash with no command as unknown", () => {
    expect(classifyAction("Bash", {})).toBe("unknown");
    expect(classifyAction("Bash", { command: "npm test" })).toBe("read");
  });
});

describe("classifyBash", () => {
  it("recognizes safe read commands", () => {
    for (const c of [
      "ls -la",
      "git status",
      "git diff HEAD",
      "npm test",
      "npx vitest run",
      "cat x",
    ]) {
      expect(classifyBash(c)).toBe("read");
    }
  });
  it("flags destructive commands", () => {
    for (const c of ["rm -rf build", "git reset --hard HEAD~1", "dd if=/dev/zero of=x"]) {
      expect(classifyBash(c)).toBe("destructive");
    }
  });
  it("flags the change ledger's write half as destructive (R8.9)", () => {
    // ADR-0002's never-auto set: no autonomy level may approve these for the
    // agent, even though `Bash(golem:*)` is allow-listed in this repo.
    for (const c of [
      "golem checkpoint restore latest",
      "golem checkpoint undo 20260731T120000Z",
      "golem cp restore --yes",
      "golem checkpoint drop 20260731T120000Z --yes",
      "golem checkpoint prune --keep 0",
    ]) {
      expect(classifyBash(c)).toBe("destructive");
    }
  });
  it("leaves the ledger's read/snapshot half unescalated (R8.9)", () => {
    // Taking a checkpoint writes only a shadow ref — it must stay cheap, or the
    // model will not do it. Unknown (native flow governs), never destructive.
    for (const c of ["golem checkpoint create --note x", "golem checkpoint list"]) {
      expect(classifyBash(c)).toBe("unknown");
    }
  });
  it("flags outward commands", () => {
    for (const c of [
      "git push origin main",
      "gh pr create",
      "npm publish",
      "curl -X POST https://x",
    ]) {
      expect(classifyBash(c)).toBe("outward");
    }
  });
  it("escalates: outward/destructive win over a safe-looking prefix", () => {
    // Leads with a safe token but also pushes — must NOT be read.
    expect(classifyBash("git status && git push")).toBe("outward");
  });
  it("treats an unrecognized command as unknown, not safe", () => {
    expect(classifyBash("./some-script.sh --yolo")).toBe("unknown");
  });
  it("never classifies a composed command as read (redirection/chaining/substitution)", () => {
    for (const c of [
      "echo x > ~/.bashrc", // redirection truncates a file behind a safe token
      "cat a > b",
      "ls -la; ./arbitrary.sh", // a second command rides a safe prefix
      "git log | head", // pipes gated too — conservative by design
      "echo `whoami`",
      "echo $(rm -rf x)",
      "cat x && ./arbitrary.sh",
    ]) {
      expect(classifyBash(c)).not.toBe("read");
    }
  });
  it("still lets destructive/outward win over composition (escalate-only)", () => {
    expect(classifyBash("ls; rm -rf build")).toBe("destructive");
    expect(classifyBash("git status && git push")).toBe("outward");
  });
  it("does not flag danger tokens that appear only inside quoted literals (R8.21)", () => {
    // A quoted filename argument is data, not a command — the danger patterns
    // must not fire on it.
    expect(classifyBash("ls 'git push.sh'")).not.toBe("outward");
    expect(classifyBash("cat 'rm -rf notes.txt'")).not.toBe("destructive");
    expect(classifyBash('grep "git reset --hard" log.txt')).not.toBe("destructive");
    // An unquoted danger token still escalates even with quotes elsewhere.
    expect(classifyBash('echo "safe" && git push origin main')).toBe("outward");
    expect(classifyBash("rm -rf 'quoted arg'")).toBe("destructive");
  });
});
