/**
 * WS-E E2 — golem init / uninit against a temp project dir with a fake probe.
 * No real `claude` binary or home directory is touched.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { golemInit, golemUninit, InitError, type InitProbe } from "../../src/cli/init.js";
import { P0_SKILLS } from "../../src/cli/skills.js";

const okProbe: InitProbe = {
  claudeCodeInstalled: () => Promise.resolve(true),
  headroomWrapActive: () => Promise.resolve(false),
};

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "golem-init-"));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

async function readJson(rel: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(projectDir, rel), "utf8")) as Record<string, unknown>;
}

/** Recursive file listing + contents, for whole-tree idempotence checks. */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const abs = path.join(entry.parentPath, entry.name);
    out.set(path.relative(dir, abs), await readFile(abs, "utf8"));
  }
  return out;
}

describe("golem init", () => {
  it("creates all wiring files in a fresh project", async () => {
    const report = await golemInit({ projectDir, probe: okProbe });
    expect(report.dryRun).toBe(false);

    const settings = await readJson(".claude/settings.json");
    expect(settings.env).toStrictEqual({
      ANTHROPIC_BASE_URL: "http://localhost:4653",
      ENABLE_TOOL_SEARCH: "true",
    });

    const mcp = await readJson(".mcp.json");
    expect(mcp.mcpServers).toStrictEqual({
      golem: { type: "stdio", command: "golem", args: ["mcp", "serve"] },
    });

    for (const name of Object.keys(P0_SKILLS)) {
      const skill = await readFile(
        path.join(projectDir, ".claude", "skills", "golem", name, "SKILL.md"),
        "utf8",
      );
      expect(skill).toBe(P0_SKILLS[name]);
    }

    const golemSettings = await readJson(".golem/settings.json");
    expect(golemSettings).toStrictEqual({ slider: { level: 1 } });

    // Status line (21c) + blocked-state event hooks (21b) are installed.
    const cs = await readJson(".claude/settings.json");
    expect(cs.statusLine).toStrictEqual({ type: "command", command: "golem statusline" });
    const hooks = cs.hooks as Record<string, unknown>;
    const cmds = (event: string) =>
      ((hooks[event] as { hooks: { command: string }[] }[]) ?? []).flatMap((e) =>
        e.hooks.map((h) => h.command),
      );
    expect(cmds("Notification")).toContain("golem hook notification");
    expect(cmds("UserPromptSubmit")).toContain("golem hook prompt-submit");
  });

  it("uninit removes the status line and blocked-state hooks", async () => {
    await golemInit({ projectDir, probe: okProbe });
    await golemUninit({ projectDir });
    const cs = await readJson(".claude/settings.json");
    expect(cs.statusLine).toBeUndefined();
    // hooks object is gone entirely once all Golem hooks are removed.
    expect(cs.hooks).toBeUndefined();
  });

  it("respects a configured proxy port", async () => {
    await golemInit({ projectDir, probe: okProbe, proxyPort: 9999 });
    const settings = await readJson(".claude/settings.json");
    expect((settings.env as Record<string, unknown>).ANTHROPIC_BASE_URL).toBe(
      "http://localhost:9999",
    );
  });

  it("is idempotent: a second run changes nothing and reports skips", async () => {
    await golemInit({ projectDir, probe: okProbe });
    const before = await snapshot(projectDir);

    const second = await golemInit({ projectDir, probe: okProbe });
    expect(second.actions.every((a) => a.kind === "skip")).toBe(true);
    expect(await snapshot(projectDir)).toStrictEqual(before);
  });

  it("preserves unrelated keys in existing files", async () => {
    await mkdir(path.join(projectDir, ".claude"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] }, env: { FOO: "bar" } }),
      "utf8",
    );
    await writeFile(
      path.join(projectDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { type: "http", url: "http://x/mcp" } } }),
      "utf8",
    );

    await golemInit({ projectDir, probe: okProbe });

    const settings = await readJson(".claude/settings.json");
    expect(settings.permissions).toStrictEqual({ allow: ["Bash(ls:*)"] });
    expect((settings.env as Record<string, unknown>).FOO).toBe("bar");
    const mcp = await readJson(".mcp.json");
    expect((mcp.mcpServers as Record<string, unknown>).other).toStrictEqual({
      type: "http",
      url: "http://x/mcp",
    });
  });

  it("dry-run reports actions but writes nothing", async () => {
    const report = await golemInit({ projectDir, dryRun: true, probe: okProbe });
    expect(report.dryRun).toBe(true);
    expect(report.actions.some((a) => a.kind === "create")).toBe(true);
    expect(await snapshot(projectDir)).toStrictEqual(new Map());
  });

  it("refuses when Claude Code is not detected", async () => {
    await expect(
      golemInit({
        projectDir,
        probe: { ...okProbe, claudeCodeInstalled: () => Promise.resolve(false) },
      }),
    ).rejects.toThrow(InitError);
  });

  it("refuses when headroom wrap is active", async () => {
    await expect(
      golemInit({
        projectDir,
        probe: { ...okProbe, headroomWrapActive: () => Promise.resolve(true) },
      }),
    ).rejects.toThrow(/headroom unwrap/);
  });

  it("refuses when another gateway owns ANTHROPIC_BASE_URL", async () => {
    await mkdir(path.join(projectDir, ".claude"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".claude", "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://localhost:8787" } }),
      "utf8",
    );
    await expect(golemInit({ projectDir, probe: okProbe })).rejects.toThrow(
      /already sets ANTHROPIC_BASE_URL/,
    );
  });

  it("refuses to touch malformed JSON", async () => {
    await mkdir(path.join(projectDir, ".claude"), { recursive: true });
    await writeFile(path.join(projectDir, ".claude", "settings.json"), "{not json", "utf8");
    await expect(golemInit({ projectDir, probe: okProbe })).rejects.toThrow(/not valid JSON/);
  });
});

describe("golem uninit", () => {
  it("removes exactly what init added, keeping foreign entries and .golem/", async () => {
    await mkdir(path.join(projectDir, ".claude"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".claude", "settings.json"),
      JSON.stringify({ env: { FOO: "bar" } }),
      "utf8",
    );
    await writeFile(
      path.join(projectDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { type: "http", url: "http://x/mcp" } } }),
      "utf8",
    );
    await golemInit({ projectDir, probe: okProbe });

    await golemUninit({ projectDir });

    const settings = await readJson(".claude/settings.json");
    expect(settings.env).toStrictEqual({ FOO: "bar" });
    const mcp = await readJson(".mcp.json");
    expect(mcp.mcpServers).toStrictEqual({ other: { type: "http", url: "http://x/mcp" } });
    const files = await snapshot(projectDir);
    expect([...files.keys()].some((f) => f.includes(path.join("skills", "golem")))).toBe(false);
    expect(files.has(path.join(".golem", "settings.json"))).toBe(true);
  });

  it("does not remove a user-customized base URL", async () => {
    await golemInit({ projectDir, probe: okProbe });
    // User later pointed Claude Code somewhere else; uninit must not delete it.
    const settingsPath = path.join(projectDir, ".claude", "settings.json");
    const settings = await readJson(".claude/settings.json");
    (settings.env as Record<string, unknown>).ANTHROPIC_BASE_URL = "http://localhost:7777";
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");

    await golemUninit({ projectDir });
    const after = await readJson(".claude/settings.json");
    expect((after.env as Record<string, unknown>).ANTHROPIC_BASE_URL).toBe("http://localhost:7777");
  });

  it("dry-run removes nothing", async () => {
    await golemInit({ projectDir, probe: okProbe });
    const before = await snapshot(projectDir);
    const report = await golemUninit({ projectDir, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(await snapshot(projectDir)).toStrictEqual(before);
  });

  it("is a no-op on an unconfigured project", async () => {
    const report = await golemUninit({ projectDir });
    expect(report.actions).toStrictEqual([
      { kind: "skip", path: ".", detail: "nothing to remove" },
    ]);
  });
});
