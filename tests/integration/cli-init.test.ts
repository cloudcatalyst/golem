/**
 * WS-E E2 — golem init / uninit against a temp project dir with a fake probe.
 * No real `claude` binary or home directory is touched.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { golemInit, golemUninit, InitError, type InitProbe } from "../../src/cli/init.js";
import { defaultProjectPort } from "../../src/cli/proxy-daemon.js";
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

    const port = defaultProjectPort(projectDir);
    const settings = await readJson(".claude/settings.json");
    expect(settings.env).toStrictEqual({
      ANTHROPIC_BASE_URL: `http://localhost:${port}`,
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
    expect(golemSettings).toStrictEqual({ slider: { level: 1 }, proxy: { port } });

    // Status line (21c) + blocked-state event hooks (21b) are installed.
    const cs = await readJson(".claude/settings.json");
    expect(cs.statusLine).toStrictEqual({ type: "command", command: "golem statusline" });
    // defaultMode = "default" so project allow-rules (Bash(golem:*), mcp__golem)
    // are authoritative instead of "auto" mode's separate background check.
    expect(cs.defaultMode).toBe("default");
    const hooks = cs.hooks as Record<string, unknown>;
    const cmds = (event: string) =>
      ((hooks[event] as { hooks: { command: string }[] }[]) ?? []).flatMap((e) =>
        e.hooks.map((h) => h.command),
      );
    expect(cmds("Notification")).toContain("golem hook notification");
    expect(cmds("UserPromptSubmit")).toContain("golem hook prompt-submit");
    // SessionStart auto-starts the proxy on project open (§47).
    expect(cmds("SessionStart")).toContain("golem hook session-start");
  });

  it("uninit removes the status line and blocked-state hooks", async () => {
    await golemInit({ projectDir, probe: okProbe });
    await golemUninit({ projectDir, probe: okProbe });
    const cs = await readJson(".claude/settings.json");
    expect(cs.statusLine).toBeUndefined();
    expect(cs.defaultMode).toBeUndefined();
    // hooks object is gone entirely once all Golem hooks are removed.
    expect(cs.hooks).toBeUndefined();
  });

  it("leaves a foreign defaultMode alone on init and uninit", async () => {
    await mkdir(path.join(projectDir, ".claude"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".claude", "settings.json"),
      JSON.stringify({ defaultMode: "acceptEdits" }),
      "utf8",
    );

    await golemInit({ projectDir, probe: okProbe });
    expect((await readJson(".claude/settings.json")).defaultMode).toBe("acceptEdits");

    await golemUninit({ projectDir, probe: okProbe });
    expect((await readJson(".claude/settings.json")).defaultMode).toBe("acceptEdits");
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
    // The unrelated allow rule is preserved (merged, not replaced); init adds its
    // own Golem MCP rules alongside it.
    expect(settings.permissions).toStrictEqual({
      allow: ["Bash(ls:*)", "mcp__golem__*"],
      ask: ["mcp__golem__wiki_upsert"],
    });
    expect((settings.env as Record<string, unknown>).FOO).toBe("bar");
    const mcp = await readJson(".mcp.json");
    expect((mcp.mcpServers as Record<string, unknown>).other).toStrictEqual({
      type: "http",
      url: "http://x/mcp",
    });
  });

  it("pre-approves Golem's MCP tools (all but wiki_upsert), and uninit removes them", async () => {
    await golemInit({ projectDir, probe: okProbe });
    const settings = await readJson(".claude/settings.json");
    const perms = settings.permissions as { allow?: string[]; ask?: string[] };
    // All Golem tools auto-approved via the anchored glob; wiki_upsert kept on ask.
    expect(perms.allow).toContain("mcp__golem__*");
    expect(perms.ask).toContain("mcp__golem__wiki_upsert");

    await golemUninit({ projectDir, probe: okProbe });
    const after = await readJson(".claude/settings.json");
    // The rules are gone; on a project init created (no other permission rules),
    // the now-empty permissions object is cleaned up entirely.
    expect(after.permissions).toBeUndefined();
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

  it("writes Golem guidance to the committed CLAUDE.md (shared team defaults), not CLAUDE.local.md", async () => {
    await golemInit({ projectDir, probe: okProbe });
    const claudeMd = await readFile(path.join(projectDir, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("wiki-first knowledge");
    expect(claudeMd).toContain("do these proactively"); // framed as standing defaults
    // Golem does not write the personal file...
    await expect(readFile(path.join(projectDir, "CLAUDE.local.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    // ...but still keeps the conventional personal CLAUDE.local.md gitignored,
    // without ignoring the now-committed CLAUDE.md.
    const gitignore = await readFile(path.join(projectDir, ".gitignore"), "utf8");
    expect(gitignore).toContain("CLAUDE.local.md");
    expect(gitignore.split(/\r?\n/)).not.toContain("CLAUDE.md");
  });

  it("--foundry wires Foundry env + proxy upstream (not ANTHROPIC_BASE_URL)", async () => {
    const resource = "https://my-res.services.ai.azure.com";
    await golemInit({ projectDir, probe: okProbe, foundry: resource });

    const env = (await readJson(".claude/settings.json")).env as Record<string, unknown>;
    expect(env.CLAUDE_CODE_USE_FOUNDRY).toBe("true");
    expect(env.ANTHROPIC_FOUNDRY_BASE_URL).toBe(
      `http://localhost:${defaultProjectPort(projectDir)}/anthropic`,
    );
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();

    const local = await readJson(".golem/settings.local.json");
    expect((local.proxy as Record<string, unknown>).upstream_base_url).toBe(resource);
  });

  it("preserves an existing Foundry wiring on a plain re-run (no stray ANTHROPIC_BASE_URL)", async () => {
    // A project already wired for Foundry (env set by a prior `--foundry` init),
    // at this project's assigned port.
    const foundryUrl = `http://localhost:${defaultProjectPort(projectDir)}/anthropic`;
    await mkdir(path.join(projectDir, ".claude"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".claude", "settings.json"),
      JSON.stringify({
        env: {
          CLAUDE_CODE_USE_FOUNDRY: "true",
          ANTHROPIC_FOUNDRY_BASE_URL: foundryUrl,
          ENABLE_TOOL_SEARCH: "true",
        },
      }),
      "utf8",
    );

    // A plain `golem init` (no --foundry) must NOT add ANTHROPIC_BASE_URL.
    await golemInit({ projectDir, probe: okProbe });
    const env = (await readJson(".claude/settings.json")).env as Record<string, unknown>;
    expect(env.CLAUDE_CODE_USE_FOUNDRY).toBe("true");
    expect(env.ANTHROPIC_FOUNDRY_BASE_URL).toBe(foundryUrl);
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("excludes Golem's churny runtime dirs from the VS Code file watcher", async () => {
    await golemInit({ projectDir, probe: okProbe });
    const settings = await readJson(".vscode/settings.json");
    const watcherExclude = settings["files.watcherExclude"] as Record<string, unknown>;
    expect(watcherExclude["**/.golem/telemetry/**"]).toBe(true);
    expect(watcherExclude["**/.golem/state/**"]).toBe(true);
    expect(watcherExclude["**/.golem/webcache/**"]).toBe(true);
    expect(watcherExclude["**/.golem/ccr/**"]).toBe(true);
    expect(watcherExclude["**/.golem/knowledge/**"]).toBe(true);
    expect(watcherExclude["**/.golem/notes/**"]).toBe(true);
    expect(watcherExclude["**/.golem/distill/**"]).toBe(true);

    await golemUninit({ projectDir, probe: okProbe });
    const after = await readJson(".vscode/settings.json");
    expect(after["files.watcherExclude"]).toBeUndefined();
  });

  it("preserves unrelated .vscode/settings.json keys and watcher excludes", async () => {
    await mkdir(path.join(projectDir, ".vscode"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".vscode", "settings.json"),
      JSON.stringify({
        "editor.tabSize": 2,
        "files.watcherExclude": { "**/some-other-dir/**": true },
      }),
      "utf8",
    );

    await golemInit({ projectDir, probe: okProbe });
    const settings = await readJson(".vscode/settings.json");
    expect(settings["editor.tabSize"]).toBe(2);
    const watcherExclude = settings["files.watcherExclude"] as Record<string, unknown>;
    expect(watcherExclude["**/some-other-dir/**"]).toBe(true);
    expect(watcherExclude["**/.golem/telemetry/**"]).toBe(true);

    await golemUninit({ projectDir, probe: okProbe });
    const after = await readJson(".vscode/settings.json");
    expect(after["editor.tabSize"]).toBe(2);
    expect((after["files.watcherExclude"] as Record<string, unknown>)["**/some-other-dir/**"]).toBe(
      true,
    );
    expect(
      (after["files.watcherExclude"] as Record<string, unknown>)["**/.golem/telemetry/**"],
    ).toBeUndefined();
  });

  it("--upstream fronts a generic gateway (Claude Code still uses ANTHROPIC_BASE_URL)", async () => {
    await golemInit({ projectDir, probe: okProbe, upstream: "https://openrouter.ai/api" });
    const env = (await readJson(".claude/settings.json")).env as Record<string, unknown>;
    expect(env.ANTHROPIC_BASE_URL).toBe(`http://localhost:${defaultProjectPort(projectDir)}`);
    const local = await readJson(".golem/settings.local.json");
    expect((local.proxy as Record<string, unknown>).upstream_base_url).toBe(
      "https://openrouter.ai/api",
    );
  });
});

describe("golem init — VS Code extension install", () => {
  let extDir: string;
  let sourceDir: string;
  let vscodeProbe: InitProbe;

  beforeEach(async () => {
    extDir = await mkdtemp(path.join(tmpdir(), "golem-vsx-ext-"));
    sourceDir = await mkdtemp(path.join(tmpdir(), "golem-vsx-src-"));
    vscodeProbe = { ...okProbe, vscodeExtensionsDir: () => Promise.resolve(extDir) };
    await writeFile(
      path.join(sourceDir, "package.json"),
      JSON.stringify({ publisher: "golem-run", name: "golem-vscode", version: "9.9.9" }),
      "utf8",
    );
    await writeFile(path.join(sourceDir, "extension.js"), "// ext", "utf8");
  });
  afterEach(async () => {
    await rm(extDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  });

  it("installs the extension by copying into the VS Code dir, idempotently", async () => {
    const id = "golem-run.golem-vscode-9.9.9";
    const r1 = await golemInit({ projectDir, probe: vscodeProbe, vscodeSourceDir: sourceDir });
    expect(r1.actions.some((a) => a.kind === "create" && a.path.includes(id))).toBe(true);
    expect(await readFile(path.join(extDir, id, "extension.js"), "utf8")).toBe("// ext");

    const projectDir2 = await mkdtemp(path.join(tmpdir(), "golem-init2-"));
    const r2 = await golemInit({
      projectDir: projectDir2,
      probe: vscodeProbe,
      vscodeSourceDir: sourceDir,
    });
    expect(r2.actions.some((a) => a.kind === "skip" && a.path.includes(id))).toBe(true);
    await rm(projectDir2, { recursive: true, force: true });
  });

  it("uninit removes the installed extension", async () => {
    await golemInit({ projectDir, probe: vscodeProbe, vscodeSourceDir: sourceDir });
    expect(await readdir(extDir)).toContain("golem-run.golem-vscode-9.9.9");
    await golemUninit({ projectDir, probe: vscodeProbe });
    expect(await readdir(extDir)).not.toContain("golem-run.golem-vscode-9.9.9");
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

    await golemUninit({ projectDir, probe: okProbe });

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

    await golemUninit({ projectDir, probe: okProbe });
    const after = await readJson(".claude/settings.json");
    expect((after.env as Record<string, unknown>).ANTHROPIC_BASE_URL).toBe("http://localhost:7777");
  });

  it("dry-run removes nothing", async () => {
    await golemInit({ projectDir, probe: okProbe });
    const before = await snapshot(projectDir);
    const report = await golemUninit({ projectDir, dryRun: true, probe: okProbe });
    expect(report.dryRun).toBe(true);
    expect(await snapshot(projectDir)).toStrictEqual(before);
  });

  it("is a no-op on an unconfigured project", async () => {
    const report = await golemUninit({ projectDir, probe: okProbe });
    expect(report.actions).toStrictEqual([
      { kind: "skip", path: ".", detail: "nothing to remove" },
    ]);
  });
});
