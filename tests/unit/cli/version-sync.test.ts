/**
 * `syncProjectVersion` / `syncClaudeWiring` — the mechanism that keeps a
 * project's Claude Code wiring (hooks, statusLine, defaultMode, MCP
 * permission pre-approval) current with the INSTALLED `golem` version
 * without needing it committed to git. See src/cli/version-sync.ts.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { syncClaudeWiring, syncProjectVersion } from "../../../src/cli/version-sync.js";
import { readVersionStamp } from "../../../src/config/migrate-files.js";
import { useTempDirs } from "../../helpers/tmp.js";

const PORT = 45123;

let projectDir: string;

async function readLocalSettings(): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(path.join(projectDir, ".claude", "settings.local.json"), "utf8"),
  ) as Record<string, unknown>;
}

const newTempDir = useTempDirs("golem-version-sync-");

beforeEach(async () => {
  projectDir = await newTempDir();
  await mkdir(path.join(projectDir, ".golem"), { recursive: true });
});

describe("syncProjectVersion", () => {
  it("on first run, reconciles both the config sweep and the Claude wiring", async () => {
    const result = await syncProjectVersion({ projectDir, version: "9.9.9", proxyPort: PORT });
    expect(result.ran).toBe(true);
    expect(result.previous).toBeNull();
    expect(result.claudeActions.length).toBeGreaterThan(0);
    // No personas staffed on this bare project — the field exists but is empty.
    expect(result.personaActions).toEqual([]);

    const settings = await readLocalSettings();
    expect(settings.hooks).toBeDefined();
    expect(settings.statusLine).toBeDefined();
    expect((settings.env as Record<string, unknown>).ANTHROPIC_BASE_URL).toBe(
      `http://localhost:${PORT}`,
    );
    expect(await readVersionStamp(projectDir)).toBe("9.9.9");
  });

  it("is a no-op on a second run at the same version (stamp unchanged)", async () => {
    await syncProjectVersion({ projectDir, version: "9.9.9", proxyPort: PORT });
    const before = await readLocalSettings();

    const result = await syncProjectVersion({ projectDir, version: "9.9.9", proxyPort: PORT });
    expect(result.ran).toBe(false);
    expect(result.claudeActions).toHaveLength(0);

    const after = await readLocalSettings();
    expect(after).toStrictEqual(before);
  });

  it("re-runs the Claude wiring again on a later version bump", async () => {
    await syncProjectVersion({ projectDir, version: "9.9.9", proxyPort: PORT });
    const result = await syncProjectVersion({ projectDir, version: "9.9.10", proxyPort: PORT });
    expect(result.ran).toBe(true);
    expect(result.previous).toBe("9.9.9");
    expect(await readVersionStamp(projectDir)).toBe("9.9.10");
  });

  it("does nothing to an unwired directory (no .golem/)", async () => {
    const bare = await newTempDir();
    const result = await syncProjectVersion({
      projectDir: bare,
      version: "9.9.9",
      proxyPort: PORT,
    });
    expect(result.ran).toBe(false);
    await expect(
      readFile(path.join(bare, ".claude", "settings.local.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("syncs persona artifacts UNCONDITIONALLY — even on a no-op version run", async () => {
    // A settings edit has nothing to do with whether `golem` itself was
    // upgraded. Staffing a persona AFTER the version stamp is already current
    // must still reach disk on the very next call, with `ran: false`.
    await syncProjectVersion({ projectDir, version: "9.9.9", proxyPort: PORT });
    await mkdir(path.join(projectDir, ".golem"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".golem", "settings.json"),
      JSON.stringify({ inference: { personas: { coder: { model: "claude-sonnet-5" } } } }),
      "utf8",
    );

    const result = await syncProjectVersion({ projectDir, version: "9.9.9", proxyPort: PORT });
    expect(result.ran).toBe(false); // the version-gated sweep still no-ops
    expect(result.claudeActions).toHaveLength(0);
    expect(
      result.personaActions.some((a) =>
        a.path.replace(/\\/gu, "/").endsWith(".claude/agents/golem-coder.md"),
      ),
    ).toBe(true);
    await expect(
      readFile(path.join(projectDir, ".claude", "agents", "golem-coder.md"), "utf8"),
    ).resolves.toContain("model: claude-sonnet-5");
  });
});

describe("syncClaudeWiring", () => {
  it("writes the same wiring golem init would, and is idempotent on repeat", async () => {
    const first = await syncClaudeWiring(projectDir, PORT);
    expect(first.length).toBeGreaterThan(0);
    const settings = await readLocalSettings();
    expect(settings.hooks).toBeDefined();

    const second = await syncClaudeWiring(projectDir, PORT);
    expect(second.every((a) => a.kind === "skip")).toBe(true);
  });
});
