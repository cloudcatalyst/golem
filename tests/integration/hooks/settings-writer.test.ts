/**
 * WS-B task B2 — .claude/settings.json hook writer round-trip: add + remove
 * preserves foreign hooks, is idempotent, and never clobbers foreign config.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InitError } from "../../../src/cli/init.js";
import {
  addPostToolUseHook,
  POST_TOOL_USE_COMMAND,
  removePostToolUseHook,
} from "../../../src/hooks/index.js";

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "golem-hooksettings-"));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

const SETTINGS_REL = ".claude/settings.json";

async function readSettings(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(projectDir, SETTINGS_REL), "utf8"));
}

async function writeSettings(value: unknown): Promise<void> {
  const file = path.join(projectDir, SETTINGS_REL);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

// biome-ignore lint/suspicious/noExplicitAny: test navigation of dynamic JSON
type Any = any;

describe("addPostToolUseHook", () => {
  it("creates settings.json with the PostToolUse entry in a fresh project", async () => {
    const action = await addPostToolUseHook({ projectDir });
    expect(action.kind).toBe("create");

    const settings = (await readSettings()) as Any;
    const list = settings.hooks.PostToolUse;
    expect(list).toHaveLength(1);
    expect(list[0].hooks[0].command).toBe(POST_TOOL_USE_COMMAND);
    expect(list[0].hooks[0].async).toBe(false);
    expect(typeof list[0].hooks[0].timeout).toBe("number");
    expect(list[0].matcher).toContain("Bash");
    expect(list[0].matcher).toContain("WebFetch");
  });

  it("is idempotent: second add is a skip and does not duplicate", async () => {
    await addPostToolUseHook({ projectDir });
    const action = await addPostToolUseHook({ projectDir });
    expect(action.kind).toBe("skip");
    const settings = (await readSettings()) as Any;
    expect(settings.hooks.PostToolUse).toHaveLength(1);
  });

  it("is idempotent when an existing hook differs only in JSON key order", async () => {
    // A hand-edited / older-code settings.json can order the hook's keys
    // differently (timeout before async) than the code emits (async before
    // timeout). Same fields, same values — the skip check must not be fooled
    // into rewriting an unchanged hook. Regression for the golem-init drift.
    await writeSettings({
      hooks: {
        PostToolUse: [
          {
            matcher: "Bash|Read|Grep|Glob|WebFetch",
            hooks: [{ type: "command", command: POST_TOOL_USE_COMMAND, timeout: 30, async: false }],
          },
        ],
      },
    });

    const action = await addPostToolUseHook({ projectDir });

    expect(action.kind).toBe("skip");
    const settings = (await readSettings()) as Any;
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    // The reordered original is left byte-untouched (not rewritten).
    const keys = Object.keys(settings.hooks.PostToolUse[0].hooks[0]);
    expect(keys).toEqual(["type", "command", "timeout", "async"]);
  });

  it("preserves foreign hooks and other settings when adding", async () => {
    await writeSettings({
      env: { FOO: "bar" },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other-pre" }] }],
        PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "foreign-post" }] }],
      },
    });

    await addPostToolUseHook({ projectDir });
    const settings = (await readSettings()) as Any;

    expect(settings.env).toStrictEqual({ FOO: "bar" });
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PostToolUse).toHaveLength(2); // foreign + golem
    const commands = settings.hooks.PostToolUse.flatMap((e: Any) =>
      e.hooks.map((h: Any) => h.command),
    );
    expect(commands).toContain("foreign-post");
    expect(commands).toContain(POST_TOOL_USE_COMMAND);
  });

  it("does not write in dry-run mode", async () => {
    const action = await addPostToolUseHook({ projectDir, dryRun: true });
    expect(action.kind).toBe("create");
    await expect(readSettings()).rejects.toThrow();
  });

  it("rejects a malformed settings.json rather than clobbering it", async () => {
    const file = path.join(projectDir, SETTINGS_REL);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{ not json", "utf8");
    await expect(addPostToolUseHook({ projectDir })).rejects.toBeInstanceOf(InitError);
  });
});

describe("removePostToolUseHook", () => {
  it("round-trips: add then remove restores foreign-only state", async () => {
    const foreign = {
      env: { FOO: "bar" },
      hooks: {
        PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "foreign-post" }] }],
      },
    };
    await writeSettings(foreign);

    await addPostToolUseHook({ projectDir });
    await removePostToolUseHook({ projectDir });

    const settings = (await readSettings()) as Any;
    expect(settings).toStrictEqual(foreign);
  });

  it("removes the PostToolUse key and hooks object when nothing else remains", async () => {
    await addPostToolUseHook({ projectDir });
    await removePostToolUseHook({ projectDir });
    const settings = (await readSettings()) as Any;
    expect(settings.hooks).toBeUndefined();
  });

  it("preserves a foreign hook that shares the golem matcher entry", async () => {
    // Two hooks in one entry: one golem, one foreign — remove keeps the foreign.
    await addPostToolUseHook({ projectDir });
    const settings = (await readSettings()) as Any;
    settings.hooks.PostToolUse[0].hooks.push({ type: "command", command: "foreign-sibling" });
    await writeSettings(settings);

    await removePostToolUseHook({ projectDir });
    const after = (await readSettings()) as Any;
    const commands = after.hooks.PostToolUse.flatMap((e: Any) =>
      e.hooks.map((h: Any) => h.command),
    );
    expect(commands).toStrictEqual(["foreign-sibling"]);
    expect(commands).not.toContain(POST_TOOL_USE_COMMAND);
  });

  it("is a no-op skip when the hook was never installed", async () => {
    await writeSettings({ env: { FOO: "bar" } });
    const action = await removePostToolUseHook({ projectDir });
    expect(action.kind).toBe("skip");
  });
});
