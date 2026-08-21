/**
 * WS-E E2 — golem init / uninit against a temp project dir with a fake probe.
 * No real `claude` binary or home directory is touched.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { golemInit, golemUninit, InitError, type InitProbe } from "../../src/cli/init.js";
import { isUnmodifiedManaged, rememberManaged } from "../../src/cli/managed-files.js";
import { defaultProjectPort } from "../../src/cli/proxy-daemon.js";
import { P0_SKILLS } from "../../src/cli/skills.js";
import { loopbackCaPath } from "../../src/proxy/loopback-cert.js";
import { useTempDirs } from "../helpers/tmp.js";

// R10.2: this file makes 36 golemInit() calls, each writing ~20 files. It was
// paying a retry-prone recursive delete per test; now it pays one per file.

// R10.2 — a LOCAL ceiling, with the measurement that justifies it.
//
// `golemInit` costs 298ms on an idle machine (measured 2026-08-13: 10 calls in
// 2981ms). A test here does one or two of them. When one of these tests trips
// the 20s budget under a full parallel run, that is a 66x slowdown of work that
// is small and real — not a hung test and not a slow code path. The cause is
// environmental: ~15 vitest workers doing filesystem work on Windows, where
// every file creation is a virus-scanner event.
//
// The structural fixes are already applied (R10.2: one temp-tree delete per
// file rather than per test; atomic settings writes). This raises the ceiling
// only for the two init-heaviest files rather than globally, so the 20s default
// still guards everything else — the same targeted approach, and the same
// reasoning, as checkpoint-ledger.test.ts.
vi.setConfig({ testTimeout: 90_000 });

const newTempDir = useTempDirs("golem-init");

const okProbe: InitProbe = {
  claudeCodeInstalled: () => Promise.resolve(true),
  headroomWrapActive: () => Promise.resolve(false),
};

let projectDir: string;

beforeEach(async () => {
  projectDir = await newTempDir();
});

/**
 * Where `golem init` writes Claude Code's wiring by default since
 * `claude.settings_scope`: the gitignored local file. `.claude/settings.json`
 * is only read below where the point is that Golem did NOT write there.
 */
const CLAUDE_TARGET = ".claude/settings.local.json";
const CLAUDE_COMMITTED = ".claude/settings.json";

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
    const settings = await readJson(CLAUDE_TARGET);
    // The wiring lands in the gitignored local file (claude.settings_scope,
    // default `local`) — including R9.12's loopback CA trust, whose path is
    // machine-absolute and has been local-only since R9.22.
    expect(settings.env).toStrictEqual({
      ANTHROPIC_BASE_URL: `http://localhost:${port}`,
      ENABLE_TOOL_SEARCH: "true",
      NODE_EXTRA_CA_CERTS: loopbackCaPath(projectDir),
    });
    // Nothing of ours in the committed file — the point of the default scope is
    // that a clone inherits no wiring it cannot honour.
    await expect(readJson(CLAUDE_COMMITTED)).rejects.toThrow();

    const mcp = await readJson(".mcp.json");
    expect(mcp.mcpServers).toStrictEqual({
      golem: { type: "stdio", command: "golem", args: ["mcp", "serve"], timeout: 23_400_000 },
    });

    for (const name of Object.keys(P0_SKILLS)) {
      const skill = await readFile(
        path.join(projectDir, ".claude", "skills", "golem", name, "SKILL.md"),
        "utf8",
      );
      expect(skill).toBe(P0_SKILLS[name]);
    }

    // Committed settings.json is a content-free "uses Golem" marker; the
    // machine-local, transient slider level + per-project port live in the
    // gitignored settings.local.json (spec Decision 43).
    const golemSettings = await readJson(".golem/settings.json");
    expect(golemSettings).toStrictEqual({});
    const golemLocal = await readJson(".golem/settings.local.json");
    expect(golemLocal).toStrictEqual({ compression: { level: "1" }, proxy: { port } });

    // Status line (21c) + blocked-state event hooks (21b) are installed.
    const cs = await readJson(CLAUDE_TARGET);
    expect(cs.statusLine).toStrictEqual({
      type: "command",
      command: "golem statusline",
      refreshInterval: 2,
    });
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
    // PreToolUse: snooze document-and-hold nudge + autonomy gate (snooze P2b).
    expect(cmds("PreToolUse")).toContain("golem hook pre-tool-use");
  });

  it("uninit removes the status line and blocked-state hooks", async () => {
    await golemInit({ projectDir, probe: okProbe });
    await golemUninit({ projectDir, probe: okProbe });
    const cs = await readJson(CLAUDE_TARGET);
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
    expect((await readJson(CLAUDE_COMMITTED)).defaultMode).toBe("acceptEdits");
    // …and not SHADOWED either: writing our mode into the local file, which
    // outranks the committed one, would end the user's choice without touching a
    // byte of the file that states it.
    expect((await readJson(CLAUDE_TARGET)).defaultMode).toBeUndefined();

    await golemUninit({ projectDir, probe: okProbe });
    expect((await readJson(CLAUDE_COMMITTED)).defaultMode).toBe("acceptEdits");
  });

  it("never clobbers a NODE_EXTRA_CA_CERTS that someone else owns (§121-C)", async () => {
    // A user behind a corporate TLS-inspection proxy already has this set.
    // Concatenating their bundle with ours makes a copy that goes stale when
    // theirs rotates, so Golem sets it only when nothing else does — and
    // served WebFetches simply stay on the deny path.
    await mkdir(path.join(projectDir, ".claude"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".claude", "settings.json"),
      JSON.stringify({ env: { NODE_EXTRA_CA_CERTS: "/corp/zscaler-root.pem" } }),
      "utf8",
    );

    await golemInit({ projectDir, probe: okProbe });
    const env = (await readJson(".claude/settings.json")).env as Record<string, unknown>;
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/corp/zscaler-root.pem");

    // …and uninit leaves the foreign value alone too.
    await golemUninit({ projectDir, probe: okProbe });
    const after = (await readJson(".claude/settings.json")).env as Record<string, unknown>;
    expect(after.NODE_EXTRA_CA_CERTS).toBe("/corp/zscaler-root.pem");
  });

  it("writes the CA trust to settings.local.json, never the committed file (R9.22)", async () => {
    // A machine-absolute cert path must never land in the file teammates receive
    // via git: it resolves on no other clone, and Claude Code then warns about it
    // twice at every start.
    // Pinned to `project` scope on purpose: that is the only configuration where
    // the committed file receives wiring at all, so it is the only one where the
    // machine-absolute CA path could wrongly land there.
    await golemInit({ projectDir, probe: okProbe, claudeSettingsScope: "project" });

    const committedEnv = (await readJson(CLAUDE_COMMITTED)).env as Record<string, unknown>;
    expect(committedEnv.ANTHROPIC_BASE_URL).toBe(
      `http://localhost:${defaultProjectPort(projectDir)}`,
    );
    expect(committedEnv.NODE_EXTRA_CA_CERTS).toBeUndefined();

    const localEnv = (await readJson(CLAUDE_TARGET)).env as Record<string, unknown>;
    expect(localEnv.NODE_EXTRA_CA_CERTS).toBe(loopbackCaPath(projectDir));
  });

  it("heals a stale Golem CA path a teammate committed (R9.22)", async () => {
    // An older init — here from a differently-rooted checkout — left its own
    // loopback CA path in the committed file. It is recognisably Golem's output
    // (the shared `.golem/loopback/ca.pem` tail) and resolves nowhere on this
    // machine, so a clone self-heals on its first init instead of inheriting it.
    await mkdir(path.join(projectDir, ".claude"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".claude", "settings.json"),
      JSON.stringify({
        env: { NODE_EXTRA_CA_CERTS: "/home/someone-else/repos/golem/.golem/loopback/ca.pem" },
      }),
      "utf8",
    );

    await golemInit({ projectDir, probe: okProbe });

    const committedEnv = (await readJson(CLAUDE_COMMITTED)).env as
      | Record<string, unknown>
      | undefined;
    expect(committedEnv?.NODE_EXTRA_CA_CERTS).toBeUndefined();

    const localEnv = (await readJson(CLAUDE_TARGET)).env as Record<string, unknown>;
    expect(localEnv.NODE_EXTRA_CA_CERTS).toBe(loopbackCaPath(projectDir));
  });

  it("preserves unrelated keys already in settings.local.json", async () => {
    // The local scope is the user's machine-local space and is frequently already
    // in use — init merges into it rather than replacing it.
    await mkdir(path.join(projectDir, ".claude"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".claude", "settings.local.json"),
      JSON.stringify({ env: { MY_TOKEN: "keep-me" }, permissions: { allow: ["Bash"] } }),
      "utf8",
    );

    await golemInit({ projectDir, probe: okProbe });

    const local = await readJson(".claude/settings.local.json");
    const env = local.env as Record<string, unknown>;
    expect(env.MY_TOKEN).toBe("keep-me");
    expect(env.NODE_EXTRA_CA_CERTS).toBe(loopbackCaPath(projectDir));
    // Merged, not replaced: the user's rule survives and ours is appended.
    expect((local.permissions as Record<string, unknown>).allow).toStrictEqual([
      "Bash",
      "mcp__golem__*",
    ]);
  });

  it("uninit removes the CA trust from settings.local.json but leaves a foreign one", async () => {
    await golemInit({ projectDir, probe: okProbe });
    await golemUninit({ projectDir, probe: okProbe });

    const afterOurs = (await readJson(".claude/settings.local.json")).env as
      | Record<string, unknown>
      | undefined;
    expect(afterOurs?.NODE_EXTRA_CA_CERTS).toBeUndefined();

    // …and the §121-C rule holds in the local scope too: a corporate MITM root
    // there is the user's, so neither init nor uninit touches it.
    await writeFile(
      path.join(projectDir, ".claude", "settings.local.json"),
      JSON.stringify({ env: { NODE_EXTRA_CA_CERTS: "/corp/zscaler-root.pem" } }),
      "utf8",
    );

    await golemInit({ projectDir, probe: okProbe });
    await golemUninit({ projectDir, probe: okProbe });

    const afterForeign = (await readJson(".claude/settings.local.json")).env as Record<
      string,
      unknown
    >;
    expect(afterForeign.NODE_EXTRA_CA_CERTS).toBe("/corp/zscaler-root.pem");
  });

  it("skips the loopback CA entirely with noLoopbackCert", async () => {
    await golemInit({ projectDir, probe: okProbe, noLoopbackCert: true });
    const env = (await readJson(CLAUDE_TARGET)).env as Record<string, unknown>;
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
  });

  it("respects a configured proxy port", async () => {
    await golemInit({ projectDir, probe: okProbe, proxyPort: 9999 });
    const settings = await readJson(CLAUDE_TARGET);
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

    // The committed file is not ours to write under the default scope, so both of
    // the user's keys survive it untouched…
    const committed = await readJson(CLAUDE_COMMITTED);
    expect(committed.permissions).toStrictEqual({ allow: ["Bash(ls:*)"] });
    expect((committed.env as Record<string, unknown>).FOO).toBe("bar");
    // …and our rule goes to the file the scope names.
    const settings = await readJson(CLAUDE_TARGET);
    expect((settings.permissions as { allow?: string[] }).allow).toStrictEqual(["mcp__golem__*"]);
    const mcp = await readJson(".mcp.json");
    expect((mcp.mcpServers as Record<string, unknown>).other).toStrictEqual({
      type: "http",
      url: "http://x/mcp",
    });
  });

  it("pre-approves every Golem MCP tool including wiki_upsert, and uninit removes them", async () => {
    await golemInit({ projectDir, probe: okProbe });
    const settings = await readJson(CLAUDE_TARGET);
    const perms = settings.permissions as { allow?: string[]; ask?: string[] };
    // All Golem tools auto-approved via the anchored wildcard rule. wiki_upsert is
    // NOT held on `ask` (USER decision 2026-07-30): Decision 44 un-gated wiki
    // authoring because git makes every write reviewable, and an `ask` rule prompts
    // even when an `allow` rule also matches (deny → ask → allow precedence), so
    // leaving one here would have silently kept the gate.
    expect(perms.allow).toContain("mcp__golem__*");
    expect(perms.ask).toBeUndefined();

    await golemUninit({ projectDir, probe: okProbe });
    const after = await readJson(CLAUDE_TARGET);
    // The rules are gone; on a project init created (no other permission rules),
    // the now-empty permissions object is cleaned up entirely.
    expect(after.permissions).toBeUndefined();
  });

  it("removes a legacy wiki_upsert ask rule left by an older init", async () => {
    // A project initialized before 2026-07-30 carries the `ask` entry. Re-running
    // init must drop it, or the gate survives the change that removed it.
    await mkdir(path.join(projectDir, ".claude"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".claude", "settings.json"),
      JSON.stringify({
        permissions: { allow: ["mcp__golem__*"], ask: ["mcp__golem__wiki_upsert", "Bash(rm:*)"] },
      }),
      "utf8",
    );

    await golemInit({ projectDir, probe: okProbe });

    // The legacy entry goes from the file that holds it — the sweep reaches the
    // non-target scope precisely so an older init's leftovers still get cleaned.
    const committedPerms = (await readJson(CLAUDE_COMMITTED)).permissions as {
      allow?: string[];
      ask?: string[];
    };
    expect(committedPerms.ask).toStrictEqual(["Bash(rm:*)"]);
    expect(committedPerms.allow).toBeUndefined();
    // …and the live rule now sits in the scope init writes.
    const perms = (await readJson(CLAUDE_TARGET)).permissions as {
      allow?: string[];
      ask?: string[];
    };
    expect(perms.allow).toContain("mcp__golem__*");
  });

  /**
   * `claude.settings_scope` — flipping it and re-running init has to MOVE the
   * wiring. Two failure modes if it merely re-writes: a copy left in the shadowed
   * file is dead weight nobody prunes, and a copy left in the SHADOWING file
   * quietly wins over the file the user just chose. Hooks are the loud case —
   * Claude Code merges hooks from both files, so a duplicate does not shadow, it
   * RUNS TWICE.
   */
  it("moves the whole wiring when the settings scope flips, leaving no duplicate", async () => {
    await golemInit({ projectDir, probe: okProbe, claudeSettingsScope: "project" });
    const committedAfterFirst = await readJson(CLAUDE_COMMITTED);
    expect((committedAfterFirst.env as Record<string, unknown>).ANTHROPIC_BASE_URL).toBeDefined();
    expect(committedAfterFirst.hooks).toBeDefined();

    await golemInit({ projectDir, probe: okProbe, claudeSettingsScope: "local" });

    // Everything is now in the local file…
    const local = await readJson(CLAUDE_TARGET);
    expect((local.env as Record<string, unknown>).ANTHROPIC_BASE_URL).toBe(
      `http://localhost:${defaultProjectPort(projectDir)}`,
    );
    expect((local.permissions as { allow?: string[] }).allow).toContain("mcp__golem__*");
    expect(local.statusLine).toBeDefined();
    expect(local.defaultMode).toBe("default");
    expect(Object.keys(local.hooks as Record<string, unknown>)).toContain("PostToolUse");

    // …and nothing of ours is left in the committed one.
    const committed = await readJson(CLAUDE_COMMITTED);
    expect(committed.env).toBeUndefined();
    expect(committed.permissions).toBeUndefined();
    expect(committed.hooks).toBeUndefined();
    expect(committed.statusLine).toBeUndefined();
    expect(committed.defaultMode).toBeUndefined();
  });

  it("uninit cleans BOTH files, whichever scope wrote them", async () => {
    await golemInit({ projectDir, probe: okProbe, claudeSettingsScope: "project" });
    // Simulate the pre-flip state a project can genuinely be in: wiring in the
    // committed file, and a local file init has also touched (the CA trust).
    await golemUninit({ projectDir, probe: okProbe });

    const committed = await readJson(CLAUDE_COMMITTED);
    expect(committed.env).toBeUndefined();
    expect(committed.hooks).toBeUndefined();
    expect(committed.permissions).toBeUndefined();
    const local = (await readJson(CLAUDE_TARGET)).env as Record<string, unknown> | undefined;
    expect(local?.NODE_EXTRA_CA_CERTS).toBeUndefined();
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

  it("seeds Golem guidance as committed .claude/rules files, not into CLAUDE.md", async () => {
    await golemInit({ projectDir, probe: okProbe });
    // Default guidance seeded as project rule files (auto-loaded by Claude Code).
    const wikiRule = await readFile(
      path.join(projectDir, ".claude", "rules", "golem-wiki-kb-first.md"),
      "utf8",
    );
    expect(wikiRule).toContain("Check the wiki first");
    expect(wikiRule).toContain("Managed by Golem");
    // snooze-hold is seeded by default (snooze P2b activation).
    const snoozeRule = await readFile(
      path.join(projectDir, ".claude", "rules", "golem-snooze-hold.md"),
      "utf8",
    );
    expect(snoozeRule).toContain("park at the usage limit");
    // Golem does NOT touch CLAUDE.md or write the personal file.
    await expect(readFile(path.join(projectDir, "CLAUDE.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(path.join(projectDir, "CLAUDE.local.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    // Personal (--user) golem rules + CLAUDE.local.md are gitignored; committed
    // rules are not.
    const gitignore = await readFile(path.join(projectDir, ".gitignore"), "utf8");
    expect(gitignore).toContain("CLAUDE.local.md");
    expect(gitignore).toContain(".claude/rules/golem-*.local.md");
  });

  it("uninit removes the seeded guidance rules", async () => {
    await golemInit({ projectDir, probe: okProbe });
    const rule = path.join(projectDir, ".claude", "rules", "golem-coder-first.md");
    await expect(readFile(rule, "utf8")).resolves.toContain("coder");
    await golemUninit({ projectDir, probe: okProbe });
    await expect(readFile(rule, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("--foundry wires Foundry env + proxy upstream (not ANTHROPIC_BASE_URL)", async () => {
    const resource = "https://my-res.services.ai.azure.com";
    await golemInit({ projectDir, probe: okProbe, foundry: resource });

    const env = (await readJson(CLAUDE_TARGET)).env as Record<string, unknown>;
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
      path.join(projectDir, CLAUDE_TARGET),
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
    const env = (await readJson(CLAUDE_TARGET)).env as Record<string, unknown>;
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
    const env = (await readJson(CLAUDE_TARGET)).env as Record<string, unknown>;
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
    extDir = await newTempDir();
    sourceDir = await newTempDir();
    vscodeProbe = { ...okProbe, vscodeExtensionsDir: () => Promise.resolve(extDir) };
    await writeFile(
      path.join(sourceDir, "package.json"),
      JSON.stringify({ publisher: "golem-run", name: "golem-vscode", version: "9.9.9" }),
      "utf8",
    );
    await writeFile(path.join(sourceDir, "extension.js"), "// ext", "utf8");
  });

  it("installs the extension by copying into the VS Code dir, idempotently", async () => {
    const id = "golem-run.golem-vscode-9.9.9";
    const r1 = await golemInit({ projectDir, probe: vscodeProbe, vscodeSourceDir: sourceDir });
    expect(r1.actions.some((a) => a.kind === "create" && a.path.includes(id))).toBe(true);
    expect(await readFile(path.join(extDir, id, "extension.js"), "utf8")).toBe("// ext");

    const projectDir2 = await newTempDir();
    const r2 = await golemInit({
      projectDir: projectDir2,
      probe: vscodeProbe,
      vscodeSourceDir: sourceDir,
    });
    expect(r2.actions.some((a) => a.kind === "skip" && a.path.includes(id))).toBe(true);
  });

  it("REFRESHES a stale deployment instead of skipping it (R9.16)", async () => {
    const id = "golem-run.golem-vscode-9.9.9";
    await golemInit({ projectDir, probe: vscodeProbe, vscodeSourceDir: sourceDir });

    // Ship a newer renderer WITHOUT bumping the version — the exact shape that
    // left a three-release-old render.js on the user's machine naming the wrong
    // model, because init keyed on the directory existing.
    await writeFile(path.join(sourceDir, "render.js"), "// fixed renderer", "utf8");

    const projectDir2 = await newTempDir();
    const report = await golemInit({
      projectDir: projectDir2,
      probe: vscodeProbe,
      vscodeSourceDir: sourceDir,
    });

    const action = report.actions.find((a) => a.path.includes(id));
    expect(action?.kind).toBe("modify");
    expect(action?.detail).toContain("render.js");
    expect(await readFile(path.join(extDir, id, "render.js"), "utf8")).toBe("// fixed renderer");
  });

  it("uninit removes the installed extension", async () => {
    await golemInit({ projectDir, probe: vscodeProbe, vscodeSourceDir: sourceDir });
    expect(await readdir(extDir)).toContain("golem-run.golem-vscode-9.9.9");
    await golemUninit({ projectDir, probe: vscodeProbe });
    expect(await readdir(extDir)).not.toContain("golem-run.golem-vscode-9.9.9");
  });
});

describe("golem init — retired skills are pruned (R11.1 leftover)", () => {
  const retiredPath = (dir: string): string =>
    path.join(dir, ".claude", "skills", "golem", "slider", "SKILL.md");

  it("removes a retired skill Golem itself wrote, and forgets its record", async () => {
    await golemInit({ projectDir, probe: okProbe });
    // Simulate a skill Golem shipped in an earlier release and has since dropped
    // from the table: write it AND record it as Golem-written, which is exactly
    // the state `/golem/slider` was in after R11.1 retired the slider.
    const retired = retiredPath(projectDir);
    await mkdir(path.dirname(retired), { recursive: true });
    await writeFile(retired, "run `golem slider 3`\n", "utf8");
    await rememberManaged(projectDir, retired, "run `golem slider 3`\n");

    const report = await golemInit({ projectDir, probe: okProbe });

    await expect(readFile(retired, "utf8")).rejects.toThrow();
    expect(report.actions.some((a) => a.kind === "remove" && a.path.includes("golem/slider"))).toBe(
      true,
    );
    // The provenance record goes with it, so a later re-install is a clean create.
    expect(await isUnmodifiedManaged(projectDir, retired, "run `golem slider 3`\n")).toBe(false);
    // The skills Golem still ships are untouched.
    for (const name of Object.keys(P0_SKILLS)) {
      await expect(
        readFile(path.join(projectDir, ".claude", "skills", "golem", name, "SKILL.md"), "utf8"),
      ).resolves.toContain("");
    }
  });

  it("keeps a retired skill the user edited, and reports it as a conflict", async () => {
    await golemInit({ projectDir, probe: okProbe });
    const retired = retiredPath(projectDir);
    await mkdir(path.dirname(retired), { recursive: true });
    await rememberManaged(projectDir, retired, "what golem wrote\n");
    // ...and then the user edited it. The bytes no longer match the record.
    await writeFile(retired, "my own notes\n", "utf8");

    const report = await golemInit({ projectDir, probe: okProbe });

    expect(await readFile(retired, "utf8")).toBe("my own notes\n");
    expect(
      report.actions.some((a) => a.kind === "conflict" && a.path.includes("golem/slider")),
    ).toBe(true);
  });

  it("leaves a skill Golem has no record of writing (the user's own)", async () => {
    await golemInit({ projectDir, probe: okProbe });
    const mine = path.join(projectDir, ".claude", "skills", "golem", "mine", "SKILL.md");
    await mkdir(path.dirname(mine), { recursive: true });
    await writeFile(mine, "my own skill\n", "utf8");

    const report = await golemInit({ projectDir, probe: okProbe });

    expect(await readFile(mine, "utf8")).toBe("my own skill\n");
    expect(report.actions.some((a) => a.kind === "remove" && a.path.includes("golem/mine"))).toBe(
      false,
    );
  });

  it("does not prune in a dry run", async () => {
    await golemInit({ projectDir, probe: okProbe });
    const retired = retiredPath(projectDir);
    await mkdir(path.dirname(retired), { recursive: true });
    await writeFile(retired, "stale\n", "utf8");
    await rememberManaged(projectDir, retired, "stale\n");

    const report = await golemInit({ projectDir, probe: okProbe, dryRun: true });

    expect(await readFile(retired, "utf8")).toBe("stale\n");
    expect(report.actions.some((a) => a.kind === "remove" && a.path.includes("golem/slider"))).toBe(
      true,
    );
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
    const settingsPath = path.join(projectDir, CLAUDE_TARGET);
    const settings = await readJson(CLAUDE_TARGET);
    (settings.env as Record<string, unknown>).ANTHROPIC_BASE_URL = "http://localhost:7777";
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");

    await golemUninit({ projectDir, probe: okProbe });
    const after = await readJson(CLAUDE_TARGET);
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
