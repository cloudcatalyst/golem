/**
 * Coverage for src/hooks/settings-extras.ts — `.claude/settings.json` writers
 * for the matcher-less event hooks (addEventHook/removeEventHook) and the
 * status line (writeStatusLine/removeStatusLine). Mirrors the conventions in
 * settings-writer.test.ts: merge-preserving, never clobber foreign config or
 * malformed files, report InitAction, honor dryRun.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InitError } from "../../../src/cli/init.js";
import {
  addEventHook,
  GOLEM_DEFAULT_MODE,
  NOTIFICATION_COMMAND,
  removeDefaultMode,
  removeEventHook,
  removeStatusLine,
  STATUS_LINE_COMMAND,
  writeDefaultMode,
  writeStatusLine,
} from "../../../src/hooks/index.js";

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "golem-hooksettings-extras-"));
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

describe("addEventHook", () => {
  it("creates settings.json with the event hook in a fresh project", async () => {
    const action = await addEventHook({ projectDir }, "Notification", NOTIFICATION_COMMAND);
    expect(action.kind).toBe("create");

    const settings = (await readSettings()) as Any;
    const list = settings.hooks.Notification;
    expect(list).toHaveLength(1);
    expect(list[0]).toStrictEqual({ hooks: [{ type: "command", command: NOTIFICATION_COMMAND }] });
  });

  it("is idempotent: second add is a skip and does not duplicate", async () => {
    await addEventHook({ projectDir }, "Notification", NOTIFICATION_COMMAND);
    const action = await addEventHook({ projectDir }, "Notification", NOTIFICATION_COMMAND);
    expect(action.kind).toBe("skip");
    const settings = (await readSettings()) as Any;
    expect(settings.hooks.Notification).toHaveLength(1);
  });

  it("preserves other entries in the same event's hook list", async () => {
    await writeSettings({
      hooks: {
        Notification: [{ matcher: "Foo", hooks: [{ type: "command", command: "foreign-notify" }] }],
      },
    });

    await addEventHook({ projectDir }, "Notification", NOTIFICATION_COMMAND);
    const settings = (await readSettings()) as Any;

    expect(settings.hooks.Notification).toHaveLength(2);
    const commands = settings.hooks.Notification.flatMap((e: Any) =>
      e.hooks.map((h: Any) => h.command),
    );
    expect(commands).toContain("foreign-notify");
    expect(commands).toContain(NOTIFICATION_COMMAND);
  });

  it("preserves entries for other events entirely", async () => {
    await writeSettings({
      hooks: {
        PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "foreign-post" }] }],
      },
    });

    await addEventHook({ projectDir }, "Notification", NOTIFICATION_COMMAND);
    const settings = (await readSettings()) as Any;

    expect(settings.hooks.PostToolUse).toStrictEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: "foreign-post" }] },
    ]);
    expect(settings.hooks.Notification).toHaveLength(1);
  });

  it("throws InitError when hooks is not an object", async () => {
    await writeSettings({ hooks: "nope" });
    await expect(
      addEventHook({ projectDir }, "Notification", NOTIFICATION_COMMAND),
    ).rejects.toBeInstanceOf(InitError);
  });

  it("throws InitError when hooks.<event> is not an array", async () => {
    await writeSettings({ hooks: { Notification: "nope" } });
    await expect(
      addEventHook({ projectDir }, "Notification", NOTIFICATION_COMMAND),
    ).rejects.toBeInstanceOf(InitError);
  });

  it("does not write in dry-run mode but still reports the action", async () => {
    const action = await addEventHook(
      { projectDir, dryRun: true },
      "Notification",
      NOTIFICATION_COMMAND,
    );
    expect(action.kind).toBe("create");
    await expect(readSettings()).rejects.toThrow();
  });
});

describe("removeEventHook", () => {
  it("removes exactly the Golem entry and preserves a foreign entry in the same list", async () => {
    await writeSettings({
      hooks: {
        Notification: [
          { matcher: "Foo", hooks: [{ type: "command", command: "foreign-notify" }] },
          { hooks: [{ type: "command", command: NOTIFICATION_COMMAND }] },
        ],
      },
    });

    const action = await removeEventHook({ projectDir }, "Notification", NOTIFICATION_COMMAND);
    expect(action.kind).toBe("modify");

    const settings = (await readSettings()) as Any;
    expect(settings.hooks.Notification).toStrictEqual([
      { matcher: "Foo", hooks: [{ type: "command", command: "foreign-notify" }] },
    ]);
  });

  it("preserves a foreign hook that shares the golem list entry", async () => {
    await writeSettings({
      hooks: {
        Notification: [
          {
            hooks: [
              { type: "command", command: NOTIFICATION_COMMAND },
              { type: "command", command: "foreign-sibling" },
            ],
          },
        ],
      },
    });

    await removeEventHook({ projectDir }, "Notification", NOTIFICATION_COMMAND);
    const settings = (await readSettings()) as Any;
    const commands = settings.hooks.Notification.flatMap((e: Any) =>
      e.hooks.map((h: Any) => h.command),
    );
    expect(commands).toStrictEqual(["foreign-sibling"]);
  });

  it("is a skip when the event/hook isn't installed at all", async () => {
    await writeSettings({ env: { FOO: "bar" } });
    const action = await removeEventHook({ projectDir }, "Notification", NOTIFICATION_COMMAND);
    expect(action.kind).toBe("skip");
  });

  it("is a skip when settings.json doesn't exist", async () => {
    const action = await removeEventHook({ projectDir }, "Notification", NOTIFICATION_COMMAND);
    expect(action.kind).toBe("skip");
  });

  it("deletes the now-empty hooks.<event> key when it becomes empty", async () => {
    await writeSettings({
      env: { FOO: "bar" },
      hooks: {
        Notification: [{ hooks: [{ type: "command", command: NOTIFICATION_COMMAND }] }],
        PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "foreign-post" }] }],
      },
    });

    await removeEventHook({ projectDir }, "Notification", NOTIFICATION_COMMAND);
    const settings = (await readSettings()) as Any;
    expect(settings.hooks.Notification).toBeUndefined();
    expect(settings.hooks.PostToolUse).toHaveLength(1);
  });

  it("deletes settings.hooks entirely when it becomes the last event with entries", async () => {
    const foreign = { env: { FOO: "bar" } };
    await writeSettings({
      ...foreign,
      hooks: {
        Notification: [{ hooks: [{ type: "command", command: NOTIFICATION_COMMAND }] }],
      },
    });

    await removeEventHook({ projectDir }, "Notification", NOTIFICATION_COMMAND);
    const settings = (await readSettings()) as Any;
    expect(settings.hooks).toBeUndefined();
    expect(settings).toStrictEqual(foreign);
  });
});

describe("writeStatusLine", () => {
  it("creates settings.json with the Golem status line in a fresh project", async () => {
    const action = await writeStatusLine({ projectDir });
    expect(action.kind).toBe("create");

    const settings = (await readSettings()) as Any;
    expect(settings.statusLine).toStrictEqual({ type: "command", command: STATUS_LINE_COMMAND });
  });

  it("is idempotent: second write is a skip", async () => {
    await writeStatusLine({ projectDir });
    const action = await writeStatusLine({ projectDir });
    expect(action.kind).toBe("skip");
    const settings = (await readSettings()) as Any;
    expect(settings.statusLine).toStrictEqual({ type: "command", command: STATUS_LINE_COMMAND });
  });

  it("refuses to clobber a foreign non-Golem status line", async () => {
    const foreignStatusLine = { type: "command", command: "some-other-tool statusline" };
    await writeSettings({ statusLine: foreignStatusLine });

    const action = await writeStatusLine({ projectDir });
    expect(action.kind).toBe("skip");
    expect(action.detail).toBe("status line set to a non-Golem command; left as is");

    const settings = (await readSettings()) as Any;
    expect(settings.statusLine).toStrictEqual(foreignStatusLine);
  });

  it("does not write in dry-run mode but still reports the action", async () => {
    const action = await writeStatusLine({ projectDir, dryRun: true });
    expect(action.kind).toBe("create");
    await expect(readSettings()).rejects.toThrow();
  });
});

describe("removeStatusLine", () => {
  it("removes the status line when it is the Golem one", async () => {
    await writeStatusLine({ projectDir });
    const action = await removeStatusLine({ projectDir });
    expect(action.kind).toBe("modify");
    const settings = (await readSettings()) as Any;
    expect(settings.statusLine).toBeUndefined();
  });

  it("is a skip when the status line is absent", async () => {
    await writeSettings({ env: { FOO: "bar" } });
    const action = await removeStatusLine({ projectDir });
    expect(action.kind).toBe("skip");
  });

  it("is a skip when the status line is a foreign one, and leaves it untouched", async () => {
    const foreignStatusLine = { type: "command", command: "some-other-tool statusline" };
    await writeSettings({ statusLine: foreignStatusLine });

    const action = await removeStatusLine({ projectDir });
    expect(action.kind).toBe("skip");

    const settings = (await readSettings()) as Any;
    expect(settings.statusLine).toStrictEqual(foreignStatusLine);
  });

  it("is a skip when settings.json doesn't exist", async () => {
    const action = await removeStatusLine({ projectDir });
    expect(action.kind).toBe("skip");
  });
});

describe("writeDefaultMode", () => {
  it("creates settings.json with defaultMode = default in a fresh project", async () => {
    const action = await writeDefaultMode({ projectDir });
    expect(action.kind).toBe("create");

    const settings = (await readSettings()) as Any;
    expect(settings.defaultMode).toBe(GOLEM_DEFAULT_MODE);
  });

  it("is idempotent: second write is a skip", async () => {
    await writeDefaultMode({ projectDir });
    const action = await writeDefaultMode({ projectDir });
    expect(action.kind).toBe("skip");
  });

  it("refuses to clobber a defaultMode the user already set", async () => {
    await writeSettings({ defaultMode: "acceptEdits" });

    const action = await writeDefaultMode({ projectDir });
    expect(action.kind).toBe("skip");
    expect(action.detail).toBe('defaultMode set to "acceptEdits"; left as is');

    const settings = (await readSettings()) as Any;
    expect(settings.defaultMode).toBe("acceptEdits");
  });

  it("does not write in dry-run mode but still reports the action", async () => {
    const action = await writeDefaultMode({ projectDir, dryRun: true });
    expect(action.kind).toBe("create");
    await expect(readSettings()).rejects.toThrow();
  });
});

describe("removeDefaultMode", () => {
  it("removes defaultMode when it is the Golem one", async () => {
    await writeDefaultMode({ projectDir });
    const action = await removeDefaultMode({ projectDir });
    expect(action.kind).toBe("modify");
    const settings = (await readSettings()) as Any;
    expect(settings.defaultMode).toBeUndefined();
  });

  it("is a skip when a foreign defaultMode is set, and leaves it untouched", async () => {
    await writeSettings({ defaultMode: "acceptEdits" });

    const action = await removeDefaultMode({ projectDir });
    expect(action.kind).toBe("skip");

    const settings = (await readSettings()) as Any;
    expect(settings.defaultMode).toBe("acceptEdits");
  });

  it("is a skip when settings.json doesn't exist", async () => {
    const action = await removeDefaultMode({ projectDir });
    expect(action.kind).toBe("skip");
  });
});
