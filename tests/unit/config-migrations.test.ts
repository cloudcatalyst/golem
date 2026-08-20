/**
 * R9.6 — settings key migrations.
 *
 * The failure this prevents: a settings file naming a renamed key loads with
 * exit 0 and the setting silently stops taking effect. These tests pin that a
 * renamed key keeps working, is reported exactly once, and reports the key the
 * FILE names rather than the one the value landed on.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { setConfig } from "../../src/cli/config.js";
import { loadConfig } from "../../src/config/index.js";
import {
  assertLeafRename,
  liveKeyFor,
  migrationFrom,
  SETTING_MIGRATIONS,
} from "../../src/config/migrations.js";
import { useTempDirs } from "../helpers/tmp.js";

let base: string;
let userDir: string;
let projectDir: string;

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const userFile = (): string => path.join(userDir, "settings.json");
const projectFile = (): string => path.join(projectDir, ".golem", "settings.json");
const localFile = (): string => path.join(projectDir, ".golem", "settings.local.json");

const newTempDir = useTempDirs("golem-migrations-");

beforeEach(async () => {
  base = await newTempDir();
  userDir = path.join(base, "user-golem");
  projectDir = path.join(base, "project");
  await mkdir(projectDir, { recursive: true });
});

describe("the migration table", () => {
  // This is the guard that makes the retirement real: it fails if someone
  // registers a rename while leaving the old key writable, or points a
  // migration at a key that does not exist.
  it("every entry renames a retired leaf onto a live one, within one section", () => {
    expect(SETTING_MIGRATIONS.length).toBeGreaterThan(0);
    for (const m of SETTING_MIGRATIONS) {
      expect(assertLeafRename(m), `${m.from} → ${m.to}`).toBeUndefined();
    }
  });

  it("resolves a retired key to the live one and leaves other keys alone", () => {
    expect(liveKeyFor("proxy.active_account")).toBe("proxy.default_target");
    expect(liveKeyFor("proxy.active_account")).toBe("proxy.default_target");
    expect(liveKeyFor("compression.level")).toBe("compression.level");
    expect(migrationFrom("compression.level")).toBeUndefined();
  });
});

describe("loadConfig honours a renamed key", () => {
  it("reads the retired key onto the live leaf, so an existing file keeps working", async () => {
    await writeJson(projectFile(), { proxy: { active_account: "openrouter-qwen3" } });
    const { settings } = await loadConfig({ projectDir, userDir });
    expect(settings.proxy.default_target).toBe("openrouter-qwen3");
  });

  it("says so exactly once, and never also calls it an unknown setting", async () => {
    await writeJson(projectFile(), { proxy: { active_account: "openrouter-qwen3" } });
    const { warnings } = await loadConfig({ projectDir, userDir });
    const mentions = warnings.filter((w) => w.includes("proxy.active_account"));
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatch(/was renamed to "proxy\.default_target" in R9\.1/);
    expect(warnings.some((w) => w.includes("unknown setting"))).toBe(false);
  });

  it("reports the key the FILE names, not the one the value landed on", async () => {
    await writeJson(projectFile(), { proxy: { active_account: "openrouter-qwen3" } });
    const { provenance } = await loadConfig({ projectDir, userDir });
    const entry = provenance["proxy.default_target"];
    expect(entry?.layer).toBe("project");
    expect(entry?.source).toBe(projectFile());
    // Without this the user is told to edit a key their file does not contain.
    expect(entry?.key).toBe("proxy.active_account");
  });

  it("leaves provenance.key absent when the file names the live key", async () => {
    await writeJson(projectFile(), { proxy: { default_target: "openrouter-qwen3" } });
    const { provenance } = await loadConfig({ projectDir, userDir });
    expect(provenance["proxy.default_target"]?.key).toBeUndefined();
  });

  it("lets the live key win when ONE layer sets both, and says which lost", async () => {
    await writeJson(projectFile(), {
      proxy: { active_account: "openrouter-qwen3", default_target: "openrouter-laguna" },
    });
    const { settings, warnings } = await loadConfig({ projectDir, userDir });
    expect(settings.proxy.default_target).toBe("openrouter-laguna");
    expect(warnings.some((w) => /sets both .*active_account.* and .*default_target/.test(w))).toBe(
      true,
    );
  });

  it("wins by the live key regardless of key order in the file", async () => {
    // Object key order is insertion order, so the old key listed LAST must still
    // not clobber the new one.
    await writeJson(projectFile(), {
      proxy: { default_target: "openrouter-laguna", active_account: "openrouter-qwen3" },
    });
    const { settings } = await loadConfig({ projectDir, userDir });
    expect(settings.proxy.default_target).toBe("openrouter-laguna");
  });

  it("applies normal precedence across layers — a higher layer's live key wins", async () => {
    await writeJson(userFile(), { proxy: { active_account: "openrouter-qwen3" } });
    await writeJson(localFile(), { proxy: { default_target: "openrouter-laguna" } });
    const { settings, provenance } = await loadConfig({ projectDir, userDir });
    expect(settings.proxy.default_target).toBe("openrouter-laguna");
    expect(provenance["proxy.default_target"]?.layer).toBe("local");
  });

  it("applies the retired key from a HIGHER layer over the live key from a lower one", async () => {
    await writeJson(userFile(), { proxy: { default_target: "openrouter-laguna" } });
    await writeJson(localFile(), { proxy: { active_account: "openrouter-qwen3" } });
    const { settings, provenance } = await loadConfig({ projectDir, userDir });
    expect(settings.proxy.default_target).toBe("openrouter-qwen3");
    expect(provenance["proxy.default_target"]?.layer).toBe("local");
    expect(provenance["proxy.default_target"]?.key).toBe("proxy.active_account");
  });

  it("still reports a genuinely unknown key as unknown", async () => {
    await writeJson(projectFile(), { proxy: { not_a_real_key: "x" } });
    const { warnings } = await loadConfig({ projectDir, userDir });
    expect(warnings.some((w) => w.includes('unknown setting "proxy.not_a_real_key"'))).toBe(true);
  });
});

describe("golem config set on a retired key", () => {
  it("writes the live key rather than one the loader would warn about", async () => {
    const result = await setConfig("local", "proxy.active_account", "openrouter-qwen3", {
      projectDir,
      userDir,
    });
    expect(result.key).toBe("proxy.default_target");
    expect(result.renamedFrom?.from).toBe("proxy.active_account");

    // The written file must load clean — no rename warning, because the key
    // written is the live one.
    const { settings, warnings } = await loadConfig({ projectDir, userDir });
    expect(settings.proxy.default_target).toBe("openrouter-qwen3");
    expect(warnings.filter((w) => w.includes("active_account"))).toHaveLength(0);
  });
});

describe("golem config set cleans up after itself (R9.6/R9.10)", () => {
  it("drops the retired key from the file it just wrote the live one to", async () => {
    // A file from before the rename, holding only the old key.
    await writeJson(localFile(), { proxy: { active_account: "openrouter-qwen3" } });

    await setConfig("local", "proxy.active_account", "openrouter-laguna", {
      projectDir,
      userDir,
    });

    const raw = JSON.parse(await readFile(localFile(), "utf8")) as {
      proxy: Record<string, unknown>;
    };
    expect(raw.proxy.default_target).toBe("openrouter-laguna");
    // Leaving both would hand the user a dead duplicate and a shadowed-key
    // warning on every load — worse than the rename they just followed.
    expect(raw.proxy.active_account).toBeUndefined();

    const { warnings } = await loadConfig({ projectDir, userDir });
    expect(warnings.filter((w) => w.includes("active_account"))).toHaveLength(0);
  });

  it("leaves other scopes alone — it only cleans the file it wrote", async () => {
    await writeJson(userFile(), { proxy: { active_account: "openrouter-qwen3" } });
    await setConfig("local", "proxy.active_account", "openrouter-laguna", {
      projectDir,
      userDir,
    });
    const raw = JSON.parse(await readFile(userFile(), "utf8")) as {
      proxy: Record<string, unknown>;
    };
    expect(raw.proxy.active_account).toBe("openrouter-qwen3");
  });
});
