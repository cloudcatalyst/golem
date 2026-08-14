/**
 * Decision 56 / R8.31 — the wiring ownership rule.
 *
 * `golem proxy unwire` edits `.claude/settings.json`, the file that decides where
 * Claude Code sends every request. The rule that matters is therefore negative:
 * Golem removes ONLY its own wiring. A third-party gateway's
 * `ANTHROPIC_BASE_URL` must survive an unwire untouched — the task's gate names
 * this explicitly, because re-deriving the guard is how such a value eventually
 * gets clobbered.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ENV_BASE_URL,
  ENV_EXTRA_CA,
  ENV_TOOL_SEARCH,
  isStaleGolemCaPath,
  proxyBaseUrl,
  readWiringState,
  removeGolemEnv,
  unwireProxyEnv,
  wireProxyEnv,
  wiringGap,
  writeLocalCaTrust,
} from "../../../src/cli/proxy-wiring.js";
import { useTempDirs } from "../../helpers/tmp.js";

const OURS = proxyBaseUrl(4653);
const FOREIGN = "http://localhost:9999";

let projectDir: string;

const newTempDir = useTempDirs("golem-proxy-wiring-");

beforeEach(async () => {
  projectDir = await newTempDir();
});

// The DEFAULT write target since `claude.settings_scope` landed: the gitignored
// local file. The committed one is still read (and swept), which the migration
// tests below exercise explicitly.
async function writeSettingsFile(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

async function readSettingsFile(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

const localFile = (): string => path.join(projectDir, ".claude", "settings.local.json");
const committedFile = (): string => path.join(projectDir, ".claude", "settings.json");

async function writeClaudeSettings(value: unknown): Promise<void> {
  await writeSettingsFile(localFile(), value);
}

async function readClaudeSettings(): Promise<Record<string, unknown>> {
  return readSettingsFile(localFile());
}

async function writeCommittedSettings(value: unknown): Promise<void> {
  await writeSettingsFile(committedFile(), value);
}

async function readCommittedSettings(): Promise<Record<string, unknown>> {
  return readSettingsFile(committedFile());
}

describe("removeGolemEnv — ownership", () => {
  it("removes our base URL and the tool-search flag we set", () => {
    const env: Record<string, unknown> = {
      [ENV_BASE_URL]: OURS,
      [ENV_TOOL_SEARCH]: "true",
    };
    expect(removeGolemEnv(env, OURS)).toBe(true);
    expect(env).toEqual({});
  });

  it("leaves a FOREIGN base URL alone", () => {
    const env: Record<string, unknown> = { [ENV_BASE_URL]: FOREIGN };
    expect(removeGolemEnv(env, OURS)).toBe(false);
    expect(env[ENV_BASE_URL]).toBe(FOREIGN);
  });

  it("leaves unrelated env entries alone", () => {
    const env: Record<string, unknown> = { [ENV_BASE_URL]: OURS, MY_VAR: "keep me" };
    expect(removeGolemEnv(env, OURS)).toBe(true);
    expect(env).toEqual({ MY_VAR: "keep me" });
  });

  it("only drops the Foundry pair when it points at OUR proxy", () => {
    const mine: Record<string, unknown> = {
      ANTHROPIC_FOUNDRY_BASE_URL: `${OURS}/anthropic`,
      CLAUDE_CODE_USE_FOUNDRY: "true",
    };
    expect(removeGolemEnv(mine, OURS)).toBe(true);
    expect(mine).toEqual({});

    const theirs: Record<string, unknown> = {
      ANTHROPIC_FOUNDRY_BASE_URL: `${FOREIGN}/anthropic`,
      CLAUDE_CODE_USE_FOUNDRY: "true",
    };
    expect(removeGolemEnv(theirs, OURS)).toBe(false);
    expect(theirs.ANTHROPIC_FOUNDRY_BASE_URL).toBe(`${FOREIGN}/anthropic`);
    expect(theirs.CLAUDE_CODE_USE_FOUNDRY).toBe("true");
  });
});

describe("unwireProxyEnv", () => {
  it("removes our wiring and reports that a reload is required", async () => {
    await writeClaudeSettings({ env: { [ENV_BASE_URL]: OURS, [ENV_TOOL_SEARCH]: "true" } });

    const result = await unwireProxyEnv(projectDir, OURS);

    expect(result.changed).toBe(true);
    // `env` is not hot-reloaded (§13/§112b) — a caller that reported plain
    // success here would leave the user proxied and puzzled.
    expect(result.needsReload).toBe(true);
    expect(await readClaudeSettings()).not.toHaveProperty("env");
  });

  it("leaves a FOREIGN base URL untouched and says so", async () => {
    await writeClaudeSettings({ env: { [ENV_BASE_URL]: FOREIGN, [ENV_TOOL_SEARCH]: "true" } });

    const result = await unwireProxyEnv(projectDir, OURS);

    expect(result.changed).toBe(false);
    expect(result.foreignBaseUrl).toBe(FOREIGN);
    expect(result.needsReload).toBe(false);
    // Nothing was removed — not even ENABLE_TOOL_SEARCH, which we do not own
    // while somebody else owns the base URL.
    const env = (await readClaudeSettings()).env as Record<string, unknown>;
    expect(env[ENV_BASE_URL]).toBe(FOREIGN);
    expect(env[ENV_TOOL_SEARCH]).toBe("true");
  });

  it("is idempotent on an already-unwired project", async () => {
    await writeClaudeSettings({ permissions: { allow: ["mcp__golem__*"] } });

    const result = await unwireProxyEnv(projectDir, OURS);

    expect(result.changed).toBe(false);
    expect(result.needsReload).toBe(false);
    expect(await readClaudeSettings()).toHaveProperty("permissions");
  });

  it("does not write when dryRun is set", async () => {
    await writeClaudeSettings({ env: { [ENV_BASE_URL]: OURS } });

    const result = await unwireProxyEnv(projectDir, OURS, { dryRun: true });

    expect(result.changed).toBe(true);
    const env = (await readClaudeSettings()).env as Record<string, unknown>;
    expect(env[ENV_BASE_URL]).toBe(OURS);
  });

  it("is a no-op on a project with no .claude settings at all", async () => {
    const result = await unwireProxyEnv(projectDir, OURS);
    expect(result).toEqual({ changed: false, needsReload: false });
  });
});

describe("wireProxyEnv", () => {
  it("writes the base URL and the tool-search flag, preserving other keys", async () => {
    await writeClaudeSettings({ env: { MY_VAR: "keep me" } });

    const result = await wireProxyEnv(projectDir, OURS);

    expect(result.changed).toBe(true);
    expect(result.needsReload).toBe(true);
    const env = (await readClaudeSettings()).env as Record<string, unknown>;
    expect(env[ENV_BASE_URL]).toBe(OURS);
    // notes §12: a non-first-party base URL disables tool search unless this is set.
    expect(env[ENV_TOOL_SEARCH]).toBe("true");
    expect(env.MY_VAR).toBe("keep me");
  });

  it("refuses to overwrite a FOREIGN base URL", async () => {
    await writeClaudeSettings({ env: { [ENV_BASE_URL]: FOREIGN } });

    const result = await wireProxyEnv(projectDir, OURS);

    expect(result.changed).toBe(false);
    expect(result.foreignBaseUrl).toBe(FOREIGN);
    const env = (await readClaudeSettings()).env as Record<string, unknown>;
    expect(env[ENV_BASE_URL]).toBe(FOREIGN);
  });

  it("is idempotent when already wired", async () => {
    await writeClaudeSettings({ env: { [ENV_BASE_URL]: OURS, [ENV_TOOL_SEARCH]: "true" } });
    const result = await wireProxyEnv(projectDir, OURS);
    expect(result.changed).toBe(false);
    expect(result.needsReload).toBe(false);
  });

  it("round-trips with unwireProxyEnv", async () => {
    await wireProxyEnv(projectDir, OURS);
    expect((await readWiringState(projectDir, OURS)).owner).toBe("golem");
    await unwireProxyEnv(projectDir, OURS);
    expect((await readWiringState(projectDir, OURS)).owner).toBe("none");
  });

  // R10.1. This used to destroy the file: the read swallowed the parse failure,
  // fell back to `{}`, and wrote that — so a stray trailing comma cost a user
  // every other key in their `.claude/settings.json`. `golem init` had always
  // refused to clobber a file it could not parse; `wire` did the opposite.
  it("refuses to overwrite a MALFORMED settings file, leaving its bytes untouched", async () => {
    const dir = path.join(projectDir, ".claude");
    await mkdir(dir, { recursive: true });
    const file = localFile();
    const original = '{ "env": { "MY_VAR": "keep me" },, }';
    await writeFile(file, original, "utf8");

    await expect(wireProxyEnv(projectDir, OURS)).rejects.toThrow(/not valid JSON/);
    expect(await readFile(file, "utf8")).toBe(original);
  });
});

/**
 * `claude.settings_scope` — WHICH of the two files Golem writes. The rule the
 * tests below pin: writes go to exactly one file and the other is swept, so a
 * scope flip MOVES the wiring. A duplicate left in the shadowed file is dead
 * weight in everyone's diff; a duplicate left in the SHADOWING file silently
 * wins over the file the user just chose.
 */
describe("wireProxyEnv — settings scope", () => {
  it("writes the gitignored local file by default", async () => {
    await wireProxyEnv(projectDir, OURS);

    expect((await readClaudeSettings()).env).toMatchObject({ [ENV_BASE_URL]: OURS });
    await expect(readCommittedSettings()).rejects.toThrow();
  });

  it("writes the committed file when the scope says project", async () => {
    await wireProxyEnv(projectDir, OURS, { scope: "project" });

    expect((await readCommittedSettings()).env).toMatchObject({ [ENV_BASE_URL]: OURS });
    await expect(readClaudeSettings()).rejects.toThrow();
  });

  it("MOVES wiring out of the committed file, keeping that file's foreign keys", async () => {
    await writeCommittedSettings({
      env: { [ENV_BASE_URL]: OURS, [ENV_TOOL_SEARCH]: "true", MY_VAR: "keep me" },
      permissions: { allow: ["Bash(ls:*)"] },
    });

    const result = await wireProxyEnv(projectDir, OURS);

    expect(result.changed).toBe(true);
    expect(result.movedFrom).toBe(committedFile());
    expect((await readClaudeSettings()).env).toMatchObject({ [ENV_BASE_URL]: OURS });
    const committed = await readCommittedSettings();
    expect(committed.env).toEqual({ MY_VAR: "keep me" });
    expect(committed.permissions).toEqual({ allow: ["Bash(ls:*)"] });
  });

  it("leaves the local CA trust alone when moving wiring the other way", async () => {
    // R9.22: NODE_EXTRA_CA_CERTS lives in the local file whatever the scope is —
    // the path is machine-absolute. Sweeping for a `project` write must not take it.
    const caPath = path.join(projectDir, ".golem", "loopback", "ca.pem");
    await writeClaudeSettings({ env: { [ENV_BASE_URL]: OURS, [ENV_EXTRA_CA]: caPath } });

    await wireProxyEnv(projectDir, OURS, { scope: "project" });

    expect((await readClaudeSettings()).env).toEqual({ [ENV_EXTRA_CA]: caPath });
    expect((await readCommittedSettings()).env).toMatchObject({ [ENV_BASE_URL]: OURS });
  });

  it("unwires BOTH files, so a project that flipped scope comes out clean", async () => {
    await writeCommittedSettings({ env: { [ENV_BASE_URL]: OURS, [ENV_TOOL_SEARCH]: "true" } });
    await writeClaudeSettings({ env: { [ENV_BASE_URL]: OURS } });

    const result = await unwireProxyEnv(projectDir, OURS);

    expect(result.changed).toBe(true);
    expect(await readCommittedSettings()).toEqual({});
    expect(await readClaudeSettings()).toEqual({});
  });
});

describe("readWiringState", () => {
  it("classifies ours / foreign / none", async () => {
    expect(await readWiringState(projectDir, OURS)).toEqual({ owner: "none", baseUrl: null });

    await writeClaudeSettings({ env: { [ENV_BASE_URL]: OURS } });
    expect(await readWiringState(projectDir, OURS)).toEqual({ owner: "golem", baseUrl: OURS });

    await writeClaudeSettings({ env: { [ENV_BASE_URL]: FOREIGN } });
    expect(await readWiringState(projectDir, OURS)).toEqual({ owner: "foreign", baseUrl: FOREIGN });
  });

  it("reads the committed file too — the scope key moves writes, not reads", async () => {
    await writeCommittedSettings({ env: { [ENV_BASE_URL]: OURS } });
    expect(await readWiringState(projectDir, OURS)).toEqual({ owner: "golem", baseUrl: OURS });
  });

  it("lets the local file shadow the committed one, as Claude Code does (notes §13)", async () => {
    await writeCommittedSettings({ env: { [ENV_BASE_URL]: FOREIGN } });
    await writeClaudeSettings({ env: { [ENV_BASE_URL]: OURS } });
    expect(await readWiringState(projectDir, OURS)).toEqual({ owner: "golem", baseUrl: OURS });
  });
});

/**
 * R8.32 — the running-but-unwired gap. Every status surface routes its wording
 * through `wiringGap`, so these assertions are the contract the four surfaces
 * inherit rather than four separate strings that drift apart.
 */
describe("wiringGap", () => {
  it("is silent when the wiring points at us — no false alarm on the healthy path", () => {
    expect(wiringGap({ owner: "golem", baseUrl: OURS }, OURS)).toBeNull();
  });

  it("names the bypass and offers `golem proxy wire` when nothing is wired", () => {
    const gap = wiringGap({ owner: "none", baseUrl: null }, OURS);
    expect(gap).not.toBeNull();
    // The user's actual exposure, stated plainly — this is the whole point of
    // the task: requests succeed, so nothing else tells them.
    expect(gap?.problem).toContain("NOT in the request path");
    expect(gap?.problem).toContain("no redaction");
    expect(gap?.remedy).toContain("golem proxy wire");
    expect(gap?.remedy).toContain(OURS);
    // `env` is not hot-reloaded (§112b) — a remedy that omits this leaves the
    // user believing the fix took effect in the running window.
    expect(gap?.remedy).toContain("reload");
  });

  it("reports a foreign gateway but offers NO remedy — it is not ours to change", () => {
    const gap = wiringGap({ owner: "foreign", baseUrl: FOREIGN }, OURS);
    expect(gap?.problem).toContain(FOREIGN);
    expect(gap?.problem).toContain("NOT in the request path");
    // The ownership rule forbids touching it, so suggesting `wire` here would be
    // advice to clobber another gateway's config.
    expect(gap?.remedy).toBeNull();
    expect(gap?.problem).not.toContain("golem proxy wire");
  });

  it("distinguishes foreign from none — different situations, different advice", () => {
    const none = wiringGap({ owner: "none", baseUrl: null }, OURS);
    const foreign = wiringGap({ owner: "foreign", baseUrl: FOREIGN }, OURS);
    expect(none?.problem).not.toBe(foreign?.problem);
  });
});

/**
 * R9.22 — the CA trust is a machine-absolute path, so it belongs in the
 * gitignored local scope. These pin the two halves that make that safe: telling
 * a stale Golem path apart from a value the user owns, and never writing when
 * the answer is "theirs".
 */
describe("isStaleGolemCaPath", () => {
  const ours = "/home/me/repos/golem/.golem/loopback/ca.pem";

  it("recognises the same CA under a different checkout root", () => {
    expect(isStaleGolemCaPath("/home/someone-else/work/golem/.golem/loopback/ca.pem", ours)).toBe(
      true,
    );
    expect(
      isStaleGolemCaPath("D:\\Personar\\Source\\repos\\golem\\.golem\\loopback\\ca.pem", ours),
    ).toBe(true);
  });

  it("is false for our own path — that is ours, not stale", () => {
    expect(isStaleGolemCaPath(ours, ours)).toBe(false);
  });

  it("leaves anything that is not Golem-shaped alone", () => {
    expect(isStaleGolemCaPath("/corp/zscaler-root.pem", ours)).toBe(false);
    expect(isStaleGolemCaPath("/etc/ssl/certs/.golem/other/ca.pem", ours)).toBe(false);
    expect(isStaleGolemCaPath("", ours)).toBe(false);
  });
});

describe("writeLocalCaTrust — R9.22", () => {
  const caPath = (): string => path.join(projectDir, ".golem", "loopback", "ca.pem");

  async function readLocal(): Promise<Record<string, unknown>> {
    const raw = await readFile(path.join(projectDir, ".claude", "settings.local.json"), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  }

  it("writes the local file and leaves the committed one without the key", async () => {
    await writeCommittedSettings({ env: { [ENV_BASE_URL]: OURS } });
    const result = await writeLocalCaTrust(projectDir, caPath());

    expect(result).toStrictEqual({ wrote: true, healedCommitted: false });
    expect((await readLocal()).env).toStrictEqual({ [ENV_EXTRA_CA]: caPath() });
    expect((await readCommittedSettings()).env).toStrictEqual({ [ENV_BASE_URL]: OURS });
  });

  it("heals a stale Golem path out of the committed file, keeping its other keys", async () => {
    await writeCommittedSettings({
      env: { [ENV_BASE_URL]: OURS, [ENV_EXTRA_CA]: "/elsewhere/golem/.golem/loopback/ca.pem" },
    });
    const result = await writeLocalCaTrust(projectDir, caPath());

    expect(result.healedCommitted).toBe(true);
    expect((await readCommittedSettings()).env).toStrictEqual({ [ENV_BASE_URL]: OURS });
    expect((await readLocal()).env).toStrictEqual({ [ENV_EXTRA_CA]: caPath() });
  });

  it("writes nothing at all when the value is the user's (§121-C)", async () => {
    await writeCommittedSettings({ env: { [ENV_EXTRA_CA]: "/corp/zscaler-root.pem" } });
    const result = await writeLocalCaTrust(projectDir, caPath());

    expect(result).toStrictEqual({
      wrote: false,
      healedCommitted: false,
      foreign: "/corp/zscaler-root.pem",
    });
    // Neither file touched: the committed value survives and no local file appears.
    expect((await readCommittedSettings()).env).toStrictEqual({
      [ENV_EXTRA_CA]: "/corp/zscaler-root.pem",
    });
    await expect(readLocal()).rejects.toThrow();
  });

  it("is idempotent — a second call reports no write", async () => {
    await writeLocalCaTrust(projectDir, caPath());
    expect(await writeLocalCaTrust(projectDir, caPath())).toStrictEqual({
      wrote: false,
      healedCommitted: false,
    });
  });

  it("dry run computes the result without touching either file", async () => {
    await writeCommittedSettings({
      env: { [ENV_EXTRA_CA]: "/elsewhere/golem/.golem/loopback/ca.pem" },
    });
    const result = await writeLocalCaTrust(projectDir, caPath(), { dryRun: true });

    expect(result).toStrictEqual({ wrote: true, healedCommitted: true });
    expect((await readCommittedSettings()).env).toStrictEqual({
      [ENV_EXTRA_CA]: "/elsewhere/golem/.golem/loopback/ca.pem",
    });
    await expect(readLocal()).rejects.toThrow();
  });
});
