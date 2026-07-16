/**
 * R5.1 — headless resume argv builder (verification-notes §65).
 */

import { describe, expect, it } from "vitest";
import { buildResumeArgv, createTask, formatResumeCommand } from "../../../src/tasks/index.js";

describe("buildResumeArgv", () => {
  it("uses --resume <session-id> when one is set", () => {
    const task = createTask({ prompt: "finish the PR", sessionId: "sess-123" });
    expect(buildResumeArgv(task)).toEqual([
      "claude",
      "--resume",
      "sess-123",
      "-p",
      "finish the PR",
    ]);
  });

  it("falls back to --continue when no session id", () => {
    const task = createTask({ prompt: "keep going" });
    expect(buildResumeArgv(task)).toEqual(["claude", "--continue", "-p", "keep going"]);
  });

  it("honors continueLatest even with a session id", () => {
    const task = createTask({ prompt: "p", sessionId: "sess-1", continueLatest: true });
    expect(buildResumeArgv(task)).toEqual(["claude", "--continue", "-p", "p"]);
  });

  it("adds --output-format json and --permission-mode when requested", () => {
    const task = createTask({ prompt: "go", sessionId: "s" });
    expect(
      buildResumeArgv(task, {
        outputJson: true,
        permissionMode: "plan",
        claudeBin: "/usr/bin/claude",
      }),
    ).toEqual([
      "/usr/bin/claude",
      "--resume",
      "s",
      "--permission-mode",
      "plan",
      "--output-format",
      "json",
      "-p",
      "go",
    ]);
  });

  it("keeps the prompt as the final single argument (no shell escaping needed)", () => {
    const task = createTask({ prompt: 'quotes " and spaces', sessionId: "s" });
    const argv = buildResumeArgv(task);
    expect(argv[argv.length - 1]).toBe('quotes " and spaces');
  });
});

describe("formatResumeCommand", () => {
  it("quotes arguments containing whitespace", () => {
    expect(formatResumeCommand(["claude", "--resume", "s", "-p", "do a thing"])).toBe(
      'claude --resume s -p "do a thing"',
    );
  });
});
