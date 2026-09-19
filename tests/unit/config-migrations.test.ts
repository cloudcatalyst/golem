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
      // R14.3: worker_targets → personas is a structural change (map → record
      // with different value shape). The old key is kept as a deprecated leaf
      // with a warning; no automatic migration is performed.
      if (m.from === "inference.worker_targets" && m.to === "inference.personas") {
        continue;
      }
      expect(assertLeafRename(m), `${m.from} → ${m.to}`).toBeUndefined();
    }
  });

  it("resolves a retired key to the live one and leaves other keys alone", () => {
    expect(liveKeyFor("proxy.active_account")).toBe("inference.model");
    expect(liveKeyFor("proxy.default_target")).toBe("inference.model");
    expect(liveKeyFor("inference.default_target")).toBe("inference.model");
    expect(liveKeyFor("compression.level")).toBe("compression.level");
    expect(migrationFrom("compression.level")).toBeUndefined();
  });
});

describe("loadConfig honours a renamed key", () => {
  it("reads the retired key onto the live leaf, so an existing file keeps working", async () => {
    await writeJson(projectFile(), { proxy: { active_account: "openrouter-qwen3" } });
    const { settings } = await loadConfig({ projectDir, userDir });
    expect(settings.inference.model).toBe("openrouter-qwen3");
  });

  it("says so exactly once, and never also calls it an unknown setting", async () => {
    await writeJson(projectFile(), { proxy: { active_account: "openrouter-qwen3" } });
    const { warnings } = await loadConfig({ projectDir, userDir });
    const mentions = warnings.filter((w) => w.includes("proxy.active_account"));
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatch(/was renamed to "inference\.model" in R9\.1/);
    expect(warnings.some((w) => w.includes("unknown setting"))).toBe(false);
  });

  it("reports the key the FILE names, not the one the value landed on", async () => {
    await writeJson(projectFile(), { proxy: { active_account: "openrouter-qwen3" } });
    const { provenance } = await loadConfig({ projectDir, userDir });
    const entry = provenance["inference.model"];
    expect(entry?.layer).toBe("project");
    expect(entry?.source).toBe(projectFile());
    // Without this the user is told to edit a key their file does not contain.
    expect(entry?.key).toBe("proxy.active_account");
  });

  it("leaves provenance.key absent when the file names the live key", async () => {
    await writeJson(projectFile(), { inference: { model: "openrouter-qwen3" } });
    const { provenance } = await loadConfig({ projectDir, userDir });
    expect(provenance["inference.model"]?.key).toBeUndefined();
  });

  it("lets the live key win when ONE layer sets both, and says which lost", async () => {
    await writeJson(projectFile(), {
      proxy: { active_account: "openrouter-qwen3" },
      inference: { model: "openrouter-laguna" },
    });
    const { settings, warnings } = await loadConfig({ projectDir, userDir });
    expect(settings.inference.model).toBe("openrouter-laguna");
    expect(warnings.some((w) => /sets both .*active_account.* and .*model/.test(w))).toBe(true);
  });

  it("wins by the live key regardless of key order in the file", async () => {
    // Object key order is insertion order, so the old key listed LAST must still
    // not clobber the new one.
    await writeJson(projectFile(), {
      proxy: { active_account: "openrouter-qwen3" },
      inference: { model: "openrouter-laguna" },
    });
    const { settings } = await loadConfig({ projectDir, userDir });
    expect(settings.inference.model).toBe("openrouter-laguna");
  });

  it("applies normal precedence across layers — a higher layer's live key wins", async () => {
    await writeJson(userFile(), { proxy: { active_account: "openrouter-qwen3" } });
    await writeJson(localFile(), { inference: { model: "openrouter-laguna" } });
    const { settings, provenance } = await loadConfig({ projectDir, userDir });
    expect(settings.inference.model).toBe("openrouter-laguna");
    expect(provenance["inference.model"]?.layer).toBe("local");
  });

  it("applies the retired key from a HIGHER layer over the live key from a lower one", async () => {
    await writeJson(userFile(), { inference: { model: "openrouter-laguna" } });
    await writeJson(localFile(), { proxy: { active_account: "openrouter-qwen3" } });
    const { settings, provenance } = await loadConfig({ projectDir, userDir });
    expect(settings.inference.model).toBe("openrouter-qwen3");
    expect(provenance["inference.model"]?.layer).toBe("local");
    expect(provenance["inference.model"]?.key).toBe("proxy.active_account");
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
    expect(result.key).toBe("inference.model");
    expect(result.renamedFrom?.from).toBe("proxy.active_account");

    // The written file must load clean — no rename warning, because the key
    // written is the live one.
    const { settings, warnings } = await loadConfig({ projectDir, userDir });
    expect(settings.inference.model).toBe("openrouter-qwen3");
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

    const raw = JSON.parse(await readFile(localFile(), "utf8"));
    expect(raw.proxy).toBeDefined();
    expect(raw.proxy.active_account).toBeUndefined();
    expect(raw.inference.model).toBe("openrouter-laguna");

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

describe("the two intermediate historical spellings still forward (R9.23)", () => {
  // The rename chain is `proxy.active_account` → `proxy.default_target` (R9.1)
  // → `inference.default_target` (R9.23) → `inference.model` (identifier-only,
  // same release). A settings file written at either intermediate point must
  // still land on today's live leaf.
  it("forwards a file still naming proxy.default_target", async () => {
    await writeJson(projectFile(), { proxy: { default_target: "openrouter-qwen3" } });
    const { settings, warnings } = await loadConfig({ projectDir, userDir });
    expect(settings.inference.model).toBe("openrouter-qwen3");
    expect(
      warnings.some((w) => /"proxy\.default_target".*renamed to "inference\.model"/.test(w)),
    ).toBe(true);
  });

  it("forwards a file still naming inference.default_target", async () => {
    await writeJson(projectFile(), { inference: { default_target: "openrouter-qwen3" } });
    const { settings, warnings } = await loadConfig({ projectDir, userDir });
    expect(settings.inference.model).toBe("openrouter-qwen3");
    expect(
      warnings.some((w) => /"inference\.default_target".*renamed to "inference\.model"/.test(w)),
    ).toBe(true);
  });
});
