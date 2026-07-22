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
  it("classifies the level tool by the level it requests (writes the slider)", () => {
    // Levels ≥ 1 are a persistent local settings write — auto-approvable at "outcome" only.
    expect(classifyAction("mcp__golem__level", { level: 1 })).toBe("write");
    expect(classifyAction("mcp__golem__level", { level: 3 })).toBe("write");
    // Level 0 disables redaction (secrets would leave the machine raw) — always gated.
    expect(classifyAction("mcp__golem__level", { level: 0 })).toBe("outward");
    // Unparseable input fails closed.
    expect(classifyAction("mcp__golem__level", {})).toBe("unknown");
    expect(classifyAction("mcp__golem__level", { level: "0" })).toBe("unknown");
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
});
