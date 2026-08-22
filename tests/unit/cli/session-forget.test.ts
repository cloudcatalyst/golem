/**
 * R13.2 — `golem session forget <id>` / `golem session forget --all`,
 * wired against the real LocalConversationStore (not mocked) so the CLI
 * command's own routing (id vs. --all, the mutually-exclusive error) is
 * exercised, not just the store method it calls.
 */

import { Command } from "commander";
import { beforeEach, describe, expect, it } from "vitest";
import registerSessionCommand from "../../../src/cli/commands/session.js";
import { LocalConversationStore } from "../../../src/session/conversation-store.js";
import { useTempDirs } from "../../helpers/tmp.js";

let projectDir: string;
const newTempDir = useTempDirs("golem-session-forget-");

beforeEach(async () => {
  projectDir = await newTempDir();
});

function newProgram(): Command {
  const program = new Command();
  program.exitOverride(); // don't process.exit() out of the test on a bad-args error
  registerSessionCommand(program);
  return program;
}

async function run(...args: string[]): Promise<void> {
  await newProgram().parseAsync(["node", "golem", "session", "forget", ...args], {
    from: "node",
  });
}

describe("golem session forget", () => {
  it("forget <id> deletes exactly that conversation from the real store", async () => {
    const store = new LocalConversationStore(`${projectDir}/.golem/conversations`);
    await store.appendTurn("keep-me", {
      role: "user",
      content: "hi",
      timestamp: "2026-08-22T00:00:00.000Z",
    });
    await store.appendTurn("drop-me", {
      role: "user",
      content: "bye",
      timestamp: "2026-08-22T00:00:00.000Z",
    });

    await run("drop-me", "--dir", projectDir);

    expect(await store.readConversation("drop-me")).toBeNull();
    expect(await store.readConversation("keep-me")).not.toBeNull();
  });

  it("forget --all deletes every conversation via the same CLI surface", async () => {
    const store = new LocalConversationStore(`${projectDir}/.golem/conversations`);
    await store.appendTurn("one", {
      role: "user",
      content: "a",
      timestamp: "2026-08-22T00:00:00.000Z",
    });
    await store.appendTurn("two", {
      role: "user",
      content: "b",
      timestamp: "2026-08-22T00:00:00.000Z",
    });

    await run("--all", "--dir", projectDir);

    expect(await store.listConversations()).toStrictEqual([]);
  });

  it("rejects an id combined with --all rather than silently picking one", async () => {
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    await run("some-id", "--all", "--dir", projectDir);
    expect(process.exitCode).toBe(1);
    process.exitCode = originalExitCode;
  });
});
