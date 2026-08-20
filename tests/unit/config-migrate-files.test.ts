/**
 * R9.13 — the sweep that fixes the settings files themselves.
 *
 * R9.6's tests pin that a retired key keeps *working*. These pin that it stops
 * being retired: the file is rewritten, in position, with a backup, and a file
 * Golem cannot parse is reported rather than clobbered.
 *
 * The migration table is real, not a fixture, so these use `SETTING_MIGRATIONS`
 * itself — a test that invented its own rename would pass against a table that
 * had gone empty.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.js";
import {
  backupPath,
  migrateOnVersionChange,
  readVersionStamp,
  removeVersionStamp,
  renderSweep,
  sweepSettingsFiles,
  versionStampPath,
  writeVersionStamp,
} from "../../src/config/migrate-files.js";
import { SETTING_MIGRATIONS } from "../../src/config/migrations.js";
import { useTempDirs } from "../helpers/tmp.js";

const VERSION = "9.9.9";

/** The first rename in the live table — the one every case below exercises. */
const M = SETTING_MIGRATIONS[0];
if (M === undefined) throw new Error("SETTING_MIGRATIONS is empty; these tests need one entry");
const [SECTION, FROM_LEAF] = [
  M.from.slice(0, M.from.indexOf(".")),
  M.from.slice(M.from.indexOf(".") + 1),
];
const TO_LEAF = M.to.slice(M.to.indexOf(".") + 1);

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

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

const newTempDir = useTempDirs("golem-migrate-files-");

beforeEach(async () => {
  base = await newTempDir();
  userDir = path.join(base, "user-golem");
  projectDir = path.join(base, "project");
  await mkdir(path.join(projectDir, ".golem"), { recursive: true });
});

describe("sweepSettingsFiles", () => {
  it("renames a retired key and preserves its value", async () => {
    await writeJson(projectFile(), { [SECTION]: { [FROM_LEAF]: "kept-value" } });

    const sweep = await sweepSettingsFiles({ projectDir, userDir, write: true, version: VERSION });

    expect(sweep.changed).toBe(true);
    expect(sweep.results).toHaveLength(1);
    expect(sweep.results[0]?.changes).toEqual([{ ...M, action: "renamed" }]);

    const root = await readJson(projectFile());
    const section = root[SECTION] as Record<string, unknown>;
    expect(section[TO_LEAF]).toBe("kept-value");
    expect(FROM_LEAF in section).toBe(false);
  });

  it("renames in position, so a committed file gets a one-line diff", async () => {
    await writeJson(projectFile(), {
      [SECTION]: { first: 1, [FROM_LEAF]: "kept-value", last: 3 },
    });

    await sweepSettingsFiles({ projectDir, userDir, write: true, version: VERSION });

    const section = (await readJson(projectFile()))[SECTION] as Record<string, unknown>;
    // The whole point: not ["first", "last", TO_LEAF].
    expect(Object.keys(section)).toEqual(["first", TO_LEAF, "last"]);
  });

  it("drops the retired key when the live one is set in the same file", async () => {
    await writeJson(projectFile(), {
      [SECTION]: { [FROM_LEAF]: "ignored", [TO_LEAF]: "wins" },
    });

    const sweep = await sweepSettingsFiles({ projectDir, userDir, write: true, version: VERSION });

    expect(sweep.results[0]?.changes).toEqual([{ ...M, action: "dropped" }]);
    const section = (await readJson(projectFile()))[SECTION] as Record<string, unknown>;
    expect(section).toEqual({ [TO_LEAF]: "wins" });
  });

  it("sweeps all three scopes in one run", async () => {
    await writeJson(userFile(), { [SECTION]: { [FROM_LEAF]: "u" } });
    await writeJson(projectFile(), { [SECTION]: { [FROM_LEAF]: "p" } });
    await writeJson(localFile(), { [SECTION]: { [FROM_LEAF]: "l" } });

    const sweep = await sweepSettingsFiles({ projectDir, userDir, write: true, version: VERSION });

    expect(sweep.results.map((r) => r.scope)).toEqual(["user", "project", "local"]);
    for (const file of [userFile(), projectFile(), localFile()]) {
      const section = (await readJson(file))[SECTION] as Record<string, unknown>;
      expect(FROM_LEAF in section).toBe(false);
      expect(TO_LEAF in section).toBe(true);
    }
  });

  it("writes a backup of the original before rewriting", async () => {
    const original = { [SECTION]: { [FROM_LEAF]: "kept-value" } };
    await writeJson(projectFile(), original);

    const sweep = await sweepSettingsFiles({ projectDir, userDir, write: true, version: VERSION });

    const backup = sweep.results[0]?.backup;
    expect(backup).toBe(backupPath(projectDir, "project", VERSION));
    expect(await readJson(backup as string)).toEqual(original);
  });

  it("check mode reports without touching anything", async () => {
    const original = { [SECTION]: { [FROM_LEAF]: "kept-value" } };
    await writeJson(projectFile(), original);

    const sweep = await sweepSettingsFiles({ projectDir, userDir, write: false, version: VERSION });

    expect(sweep.changed).toBe(true);
    expect(sweep.results[0]?.backup).toBeUndefined();
    expect(await readJson(projectFile())).toEqual(original);
    expect(renderSweep(sweep, false).at(-1)).toContain("golem config migrate --write");
  });

  it("is silent and idempotent on a file that uses current names", async () => {
    await writeJson(projectFile(), { [SECTION]: { [TO_LEAF]: "current" } });

    const sweep = await sweepSettingsFiles({ projectDir, userDir, write: true, version: VERSION });

    expect(sweep.changed).toBe(false);
    expect(sweep.results).toEqual([]);
    expect(renderSweep(sweep, true)).toEqual([]);
  });

  it("reports a malformed file and leaves it exactly as it was", async () => {
    const broken = "{ not json";
    await mkdir(path.dirname(projectFile()), { recursive: true });
    await writeFile(projectFile(), broken, "utf8");

    const sweep = await sweepSettingsFiles({ projectDir, userDir, write: true, version: VERSION });

    expect(sweep.changed).toBe(false);
    expect(sweep.results[0]?.error).toContain("invalid JSON");
    expect(await readFile(projectFile(), "utf8")).toBe(broken);
    expect(renderSweep(sweep, true)[0]).toContain("NOT migrated");
  });

  it("preserves tab indentation and the absence of a trailing newline", async () => {
    await mkdir(path.dirname(projectFile()), { recursive: true });
    await writeFile(
      projectFile(),
      `{\n\t"${SECTION}": {\n\t\t"${FROM_LEAF}": "kept-value"\n\t}\n}`,
      "utf8",
    );

    await sweepSettingsFiles({ projectDir, userDir, write: true, version: VERSION });

    const text = await readFile(projectFile(), "utf8");
    expect(text).toContain(`\t"${SECTION}"`);
    expect(text.endsWith("\n")).toBe(false);
  });

  it("leaves the loader with nothing left to warn about", async () => {
    await writeJson(projectFile(), { [SECTION]: { [FROM_LEAF]: "kept-value" } });

    const before = await loadConfig({ projectDir, userDir, env: {} });
    expect(before.warnings.some((w) => w.includes(M.from))).toBe(true);

    await sweepSettingsFiles({ projectDir, userDir, write: true, version: VERSION });

    const after = await loadConfig({ projectDir, userDir, env: {} });
    expect(after.warnings.some((w) => w.includes(M.from))).toBe(false);
  });
});

describe("migrateOnVersionChange", () => {
  it("runs on a version change, then stamps and stops running", async () => {
    await writeJson(projectFile(), { [SECTION]: { [FROM_LEAF]: "kept-value" } });

    const first = await migrateOnVersionChange({ projectDir, userDir, version: VERSION });
    expect(first.ran).toBe(true);
    expect(first.previous).toBeNull();
    expect(first.lines.join("\n")).toContain(M.to);
    expect(await readVersionStamp(projectDir)).toBe(VERSION);

    const second = await migrateOnVersionChange({ projectDir, userDir, version: VERSION });
    expect(second.ran).toBe(false);
    expect(second.lines).toEqual([]);
  });

  it("runs again when the version moves on", async () => {
    await writeVersionStamp(projectDir, "0.0.1");
    await writeJson(projectFile(), { [SECTION]: { [FROM_LEAF]: "kept-value" } });

    const outcome = await migrateOnVersionChange({ projectDir, userDir, version: VERSION });

    expect(outcome.ran).toBe(true);
    expect(outcome.previous).toBe("0.0.1");
    expect(await readVersionStamp(projectDir)).toBe(VERSION);
  });

  it("does nothing, and creates nothing, outside a Golem project", async () => {
    const bare = path.join(base, "bare");
    await mkdir(bare, { recursive: true });

    const outcome = await migrateOnVersionChange({ projectDir: bare, userDir, version: VERSION });

    expect(outcome).toEqual({ ran: false, previous: null, lines: [] });
    await expect(readFile(versionStampPath(bare), "utf8")).rejects.toThrow();
  });

  it("still stamps when the version changed but no file needed fixing", async () => {
    await writeJson(projectFile(), { [SECTION]: { [TO_LEAF]: "current" } });

    const outcome = await migrateOnVersionChange({ projectDir, userDir, version: VERSION });

    expect(outcome.ran).toBe(true);
    expect(outcome.lines).toEqual([]);
    expect(await readVersionStamp(projectDir)).toBe(VERSION);
  });

  it("uninit removes the stamp", async () => {
    await writeVersionStamp(projectDir, VERSION);
    await removeVersionStamp(projectDir);
    expect(await readVersionStamp(projectDir)).toBeNull();
  });
});

/**
 * R11.1 / ADR-0004 — the retired slider is the one migration that TRANSFORMS
 * rather than renames: one key becomes two or three, with values computed from
 * it. That is why it is not a `SETTING_MIGRATIONS` row and why it needs its own
 * cases.
 *
 * The promise these pin is the one the ADR made: **no project changes behaviour
 * by upgrading.** Every case below is the same question — does the file now say
 * explicitly what the slider was implicitly doing?
 */
describe("sweepSettingsFiles — the retired slider (R11.1)", () => {
  it("resolves a slider level into the two dial values it was producing", async () => {
    await writeJson(projectFile(), { slider: { level: 3 } });

    await sweepSettingsFiles({ projectDir, userDir, write: true, version: VERSION });

    // Level 3 drove compression 3 and the brevity preset `full`.
    expect(await readJson(projectFile())).toEqual({
      compression: { level: "3" },
      brevity: { level: "full" },
    });
  });

  it("lets a REAL pin win, exactly as the retired resolver did", async () => {
    // A pinned dial always beat the preset, and must keep beating it — otherwise
    // upgrading would silently raise this project's compression from 1 to 3.
    await writeJson(projectFile(), { slider: { level: 3 }, compression: { level: "1" } });

    await sweepSettingsFiles({ projectDir, userDir, write: true, version: VERSION });

    const after = await readJson(projectFile());
    expect(after.compression).toEqual({ level: "1" });
    expect(after.brevity).toEqual({ level: "full" });
  });

  it('treats "auto" as NOT a pin — it meant "follow the slider"', async () => {
    await writeJson(projectFile(), { slider: { level: 2 }, brevity: { level: "auto" } });

    await sweepSettingsFiles({ projectDir, userDir, write: true, version: VERSION });

    // `auto` is replaced by what it resolved to (level 2's preset), not preserved
    // as a value — the enum no longer has it.
    expect(await readJson(projectFile())).toEqual({
      brevity: { level: "lite" },
      compression: { level: "2" },
    });
  });

  it("turns level 0 into proxy.bypass_all, with both dials off", async () => {
    // Level 0 was a FULL bypass, redaction included. Migrating it to
    // `compression: off` alone would silently turn redaction back ON for a
    // project that had deliberately switched it off — a behaviour change in the
    // safe direction, but a behaviour change, and a surprising one.
    await writeJson(projectFile(), { slider: { level: 0 } });

    await sweepSettingsFiles({ projectDir, userDir, write: true, version: VERSION });

    expect(await readJson(projectFile())).toEqual({
      proxy: { bypass_all: true },
      compression: { level: "off" },
      brevity: { level: "off" },
    });
  });

  it("clamps a legacy 4/5 the way every read used to", async () => {
    await writeJson(projectFile(), { slider: { level: 5 } });

    await sweepSettingsFiles({ projectDir, userDir, write: true, version: VERSION });

    expect(await readJson(projectFile())).toEqual({
      compression: { level: "3" },
      brevity: { level: "full" },
    });
  });

  it("leaves a file that never had a slider completely alone", async () => {
    const original = { compression: { level: "2" }, proxy: { port: 4000 } };
    await writeJson(projectFile(), original);

    await sweepSettingsFiles({ projectDir, userDir, write: true, version: VERSION });

    expect(await readJson(projectFile())).toEqual(original);
  });

  it("is idempotent — a second sweep changes nothing", async () => {
    await writeJson(projectFile(), { slider: { level: 2 } });

    await sweepSettingsFiles({ projectDir, userDir, write: true, version: VERSION });
    const once = await readJson(projectFile());
    const second = await sweepSettingsFiles({ projectDir, userDir, write: true, version: VERSION });

    expect(await readJson(projectFile())).toEqual(once);
    // And it reports nothing the second time: a sweep over a clean project is
    // silent, which is what makes it safe to run on every proxy start.
    expect(second.results.filter((r) => (r.changes ?? []).length > 0)).toHaveLength(0);
  });

  it("reports the transform so the operator can see what happened", async () => {
    await writeJson(projectFile(), { slider: { level: 2 } });

    const results = await sweepSettingsFiles({
      projectDir,
      userDir,
      write: true,
      version: VERSION,
    });

    const changes = results.results.flatMap((r) => r.changes ?? []);
    expect(changes.some((c) => c.to === "compression.level" && c.action === "resolved")).toBe(true);
    expect(changes.some((c) => c.to === "brevity.level" && c.action === "resolved")).toBe(true);
    expect(changes.some((c) => c.action === "dropped" && c.from === "slider.level")).toBe(true);
  });
});
