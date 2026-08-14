/**
 * `claude.settings_scope` — WHERE Golem writes Claude Code's wiring, and the
 * scope-default of `golem config set`.
 *
 * Two defaults are pinned here, and both are choices rather than accidents:
 *   * Golem writes `.claude/settings.local.json`, because every value in that
 *     wiring is machine-local (a port assigned on THIS machine, an absolute CA
 *     path, hooks that need `golem` on PATH) and the committed file is the one
 *     that travels to clones which can honour none of it;
 *   * `golem config set` writes `.golem/settings.local.json`, because a setting
 *     is one person's choice on one machine far more often than it is a team
 *     decision, and the gitignored file cannot commit a personal preference into
 *     everyone's checkout.
 *
 * A default that quietly flips back is the whole risk being guarded: nothing
 * fails when the wiring lands in the wrong file — it keeps working, in git.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_SETTINGS_SCOPES,
  claudeSettingsFiles,
  claudeSettingsReadOrder,
  claudeSettingsTarget,
  otherClaudeSettingsScope,
  resolveClaudeSettingsScope,
} from "../../../src/cli/claude-settings-target.js";
import registerConfigCommand from "../../../src/cli/commands/config.js";
import { useTempDirs } from "../../helpers/tmp.js";

let projectDir: string;
const newTempDir = useTempDirs("golem-claude-scope-");

beforeEach(async () => {
  projectDir = await newTempDir();
});

async function writeGolemSettings(file: string, value: unknown): Promise<void> {
  const abs = path.join(projectDir, ".golem", file);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, JSON.stringify(value, null, 2), "utf8");
}

const localPath = (): string => path.join(projectDir, ".claude", "settings.local.json");
const committedPath = (): string => path.join(projectDir, ".claude", "settings.json");

describe("resolveClaudeSettingsScope", () => {
  it("defaults to the gitignored local file", async () => {
    expect(await resolveClaudeSettingsScope(projectDir)).toBe("local");
    expect(await claudeSettingsTarget(projectDir)).toBe(localPath());
  });

  it("honours claude.settings_scope from the project layer", async () => {
    await writeGolemSettings("settings.json", { claude: { settings_scope: "project" } });

    expect(await resolveClaudeSettingsScope(projectDir)).toBe("project");
    expect(await claudeSettingsTarget(projectDir)).toBe(committedPath());
  });

  it("lets the local layer override the project layer, like every other setting", async () => {
    await writeGolemSettings("settings.json", { claude: { settings_scope: "project" } });
    await writeGolemSettings("settings.local.json", { claude: { settings_scope: "local" } });

    expect(await claudeSettingsTarget(projectDir)).toBe(localPath());
  });

  it("falls back to the default when the settings files cannot be loaded", async () => {
    // Status surfaces and the status line call this. Refusing to say where the
    // wiring lives — because an unrelated key is malformed — is worse than
    // answering with the default this project would have had anyway.
    await mkdir(path.join(projectDir, ".golem"), { recursive: true });
    await writeFile(path.join(projectDir, ".golem", "settings.json"), "{not json", "utf8");

    expect(await resolveClaudeSettingsScope(projectDir)).toBe("local");
  });

  it("pairs the target with the file it is NOT writing", async () => {
    expect(await claudeSettingsFiles(projectDir)).toStrictEqual({
      scope: "local",
      target: localPath(),
      other: committedPath(),
    });
    expect(await claudeSettingsFiles(projectDir, "project")).toStrictEqual({
      scope: "project",
      target: committedPath(),
      other: localPath(),
    });
  });

  it("reads both files, local first — Claude Code's own precedence (notes §13)", () => {
    expect(claudeSettingsReadOrder(projectDir)).toStrictEqual([localPath(), committedPath()]);
  });

  it("covers both scopes, so uninit cannot leave half the wiring behind", () => {
    expect([...CLAUDE_SETTINGS_SCOPES].sort()).toStrictEqual(["local", "project"]);
    expect(otherClaudeSettingsScope("local")).toBe("project");
    expect(otherClaudeSettingsScope("project")).toBe("local");
  });
});

describe("golem config set/unset — default scope", () => {
  const scopeDefault = (command: string): unknown => {
    const program = new Command();
    registerConfigCommand(program);
    const config = program.commands.find((c) => c.name() === "config");
    const sub = config?.commands.find((c) => c.name() === command);
    return sub?.options.find((o) => o.long === "--scope")?.defaultValue;
  };

  it("writes the gitignored local file unless --scope says otherwise", () => {
    expect(scopeDefault("set")).toBe("local");
    expect(scopeDefault("unset")).toBe("local");
  });
});
