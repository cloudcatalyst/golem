/**
 * Unit tests for runtime clear/restore of Claude Code's proxy URL.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearClaudeProxyUrl,
  forgetClaudeProxyMode,
  restoreClaudeProxyUrl,
} from "../../../src/cli/proxy-claude-settings.js";
import { defaultProjectPort } from "../../../src/cli/proxy-daemon.js";
import { writeSetting } from "../../../src/config/index.js";

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "golem-proxy-cs-"));
  await mkdir(path.join(projectDir, ".golem"), { recursive: true });
  // Match what golem init creates: an explicit per-project port in the
  // gitignored local settings file. Without this the config layer falls back
  // to the default 4653, while defaultProjectPort(projectDir) hashes to a
  // different value and every URL mismatch test fails.
  await writeSetting("project", "proxy.port", defaultProjectPort(projectDir), { projectDir });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

async function readClaudeSettings(): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(path.join(projectDir, ".claude", "settings.json"), "utf8"),
  ) as Record<string, unknown>;
}

async function readMode(): Promise<unknown> {
  return JSON.parse(
    await readFile(path.join(projectDir, ".golem", "state", "proxy-claude-mode.json"), "utf8"),
  );
}

function baseUrl(): string {
  return `http://localhost:${defaultProjectPort(projectDir)}`;
}

function foundryUrl(): string {
  return `${baseUrl()}/anthropic`;
}

describe("clearClaudeProxyUrl", () => {
  it("removes a direct Anthropic URL and remembers direct mode", async () => {
    await mkdir(path.join(projectDir, ".claude"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".claude", "settings.json"),
      JSON.stringify({
        env: { ANTHROPIC_BASE_URL: baseUrl(), ENABLE_TOOL_SEARCH: "true", OTHER: "x" },
      }),
      "utf8",
    );

    const changed = await clearClaudeProxyUrl(projectDir);
    expect(changed).toBe(true);

    const settings = await readClaudeSettings();
    expect(settings.env).toStrictEqual({ OTHER: "x" });
    expect(await readMode()).toStrictEqual({ mode: "direct" });
  });

  it("removes a Foundry URL and remembers foundry mode", async () => {
    await mkdir(path.join(projectDir, ".claude"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".claude", "settings.json"),
      JSON.stringify({
        env: {
          CLAUDE_CODE_USE_FOUNDRY: "true",
          ANTHROPIC_FOUNDRY_BASE_URL: foundryUrl(),
          ENABLE_TOOL_SEARCH: "true",
        },
      }),
      "utf8",
    );

    const changed = await clearClaudeProxyUrl(projectDir);
    expect(changed).toBe(true);

    const settings = await readClaudeSettings();
    expect(settings.env).toBeUndefined();
    expect(await readMode()).toStrictEqual({ mode: "foundry" });
  });

  it("is a no-op when the URL points somewhere else", async () => {
    await mkdir(path.join(projectDir, ".claude"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".claude", "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://localhost:7777" } }),
      "utf8",
    );

    const changed = await clearClaudeProxyUrl(projectDir);
    expect(changed).toBe(false);

    const settings = await readClaudeSettings();
    expect((settings.env as Record<string, unknown>).ANTHROPIC_BASE_URL).toBe(
      "http://localhost:7777",
    );
  });

  it("is a no-op when no settings file exists", async () => {
    const changed = await clearClaudeProxyUrl(projectDir);
    expect(changed).toBe(false);
  });

  it("does not remove an unrelated ENABLE_TOOL_SEARCH value", async () => {
    await mkdir(path.join(projectDir, ".claude"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".claude", "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: baseUrl(), ENABLE_TOOL_SEARCH: "false" } }),
      "utf8",
    );

    const changed = await clearClaudeProxyUrl(projectDir);
    expect(changed).toBe(true);

    const settings = await readClaudeSettings();
    expect(settings.env).toStrictEqual({ ENABLE_TOOL_SEARCH: "false" });
  });
});

describe("restoreClaudeProxyUrl", () => {
  it("creates settings.json with direct mode when no mode record exists", async () => {
    await restoreClaudeProxyUrl(projectDir);

    const settings = await readClaudeSettings();
    expect(settings.env).toStrictEqual({
      ANTHROPIC_BASE_URL: baseUrl(),
      ENABLE_TOOL_SEARCH: "true",
    });
  });

  it("restores direct mode after a direct clear", async () => {
    await mkdir(path.join(projectDir, ".claude"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".claude", "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: baseUrl() } }),
      "utf8",
    );
    await clearClaudeProxyUrl(projectDir);

    await restoreClaudeProxyUrl(projectDir);

    const settings = await readClaudeSettings();
    expect(settings.env).toStrictEqual({
      ANTHROPIC_BASE_URL: baseUrl(),
      ENABLE_TOOL_SEARCH: "true",
    });
  });

  it("restores Foundry mode after a Foundry clear", async () => {
    await mkdir(path.join(projectDir, ".claude"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".claude", "settings.json"),
      JSON.stringify({
        env: {
          CLAUDE_CODE_USE_FOUNDRY: "true",
          ANTHROPIC_FOUNDRY_BASE_URL: foundryUrl(),
        },
      }),
      "utf8",
    );
    await clearClaudeProxyUrl(projectDir);

    await restoreClaudeProxyUrl(projectDir);

    const settings = await readClaudeSettings();
    expect(settings.env).toStrictEqual({
      CLAUDE_CODE_USE_FOUNDRY: "true",
      ANTHROPIC_FOUNDRY_BASE_URL: foundryUrl(),
      ENABLE_TOOL_SEARCH: "true",
    });
  });

  it("switches from direct to Foundry when restoring a remembered Foundry mode", async () => {
    await mkdir(path.join(projectDir, ".claude"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".claude", "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: baseUrl() } }),
      "utf8",
    );
    await clearClaudeProxyUrl(projectDir);
    // Pretend it had been Foundry by writing the mode record directly.
    const modeFile = path.join(projectDir, ".golem", "state", "proxy-claude-mode.json");
    await mkdir(path.dirname(modeFile), { recursive: true });
    await writeFile(modeFile, JSON.stringify({ mode: "foundry" }), "utf8");

    await restoreClaudeProxyUrl(projectDir);

    const settings = await readClaudeSettings();
    expect(settings.env).toStrictEqual({
      CLAUDE_CODE_USE_FOUNDRY: "true",
      ANTHROPIC_FOUNDRY_BASE_URL: foundryUrl(),
      ENABLE_TOOL_SEARCH: "true",
    });
  });

  it("preserves unrelated settings keys", async () => {
    await mkdir(path.join(projectDir, ".claude"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".claude", "settings.json"),
      JSON.stringify({ defaultMode: "acceptEdits", env: { OTHER: "y" } }),
      "utf8",
    );

    await restoreClaudeProxyUrl(projectDir);

    const settings = await readClaudeSettings();
    expect(settings.defaultMode).toBe("acceptEdits");
    expect((settings.env as Record<string, unknown>).OTHER).toBe("y");
  });

  it("respects a configured proxy port", async () => {
    await writeSetting("project", "proxy.port", 9999, { projectDir });

    await restoreClaudeProxyUrl(projectDir);

    const settings = await readClaudeSettings();
    expect((settings.env as Record<string, unknown>).ANTHROPIC_BASE_URL).toBe(
      "http://localhost:9999",
    );
  });

  it("returns false when settings already match", async () => {
    await mkdir(path.join(projectDir, ".claude"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".claude", "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: baseUrl(), ENABLE_TOOL_SEARCH: "true" } }),
      "utf8",
    );

    const changed = await restoreClaudeProxyUrl(projectDir);
    expect(changed).toBe(false);
  });
});

describe("forgetClaudeProxyMode", () => {
  it("removes the mode state file", async () => {
    const modeFile = path.join(projectDir, ".golem", "state", "proxy-claude-mode.json");
    await mkdir(path.dirname(modeFile), { recursive: true });
    await writeFile(modeFile, JSON.stringify({ mode: "direct" }), "utf8");
    expect(await readMode()).toBeDefined();

    await forgetClaudeProxyMode(projectDir);
    await expect(readMode()).rejects.toMatchObject({ code: "ENOENT" });
  });
});
