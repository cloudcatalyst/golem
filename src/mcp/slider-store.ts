/**
 * Slider-level persistence for the MCP server (WS-B task B1; key shape
 * reconciled with the E1 config schema in WS-E task E3).
 *
 * The level lives at the NESTED `slider.level` path — the exact key the E1
 * config loader (`src/config/schema.ts`) validates — inside a Golem settings
 * file, so `/mcp__golem__slider` (level), `golem slider`, and
 * `loadConfig()` all read and write one value. The CLI wires this store at
 * the PROJECT settings file (`<project>/.golem/settings.json`); the default
 * remains the user-scope file (`~/.golem/settings.json`) for standalone runs.
 *
 * B1 originally persisted a flat root-level `slider_level` key; get() still
 * falls back to it and set() migrates it away (see verification-notes §20,
 * 2026-07-04). Reads/writes merge with — and preserve — any other keys in the
 * file so it round-trips cleanly with the E1 loader and writeSetting.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { migrateSliderLevel, type SliderLevel } from "../interfaces/index.js";

/** Default slider level when nothing has been persisted yet (P0: lossless). */
export const DEFAULT_SLIDER_LEVEL: SliderLevel = 1;

/** Dotted settings path holding the slider level (config schema: slider.level). */
export const SLIDER_LEVEL_SETTINGS_KEY = "slider.level";

/** Pre-reconciliation flat key written by B1; read as a fallback, migrated on set(). */
export const LEGACY_SLIDER_LEVEL_KEY = "slider_level";

/** Minimal persistence boundary for the slider level. */
export interface SliderStore {
  /** Current level, or DEFAULT_SLIDER_LEVEL when nothing is persisted. */
  get(): Promise<SliderLevel>;
  /** Persist a new level. */
  set(level: SliderLevel): Promise<void>;
}

/**
 * Accepts any legacy 0–5 value on disk; callers migrate the parsed number onto
 * the current 0–3 scale via {@link migrateSliderLevel} (Decision 30).
 */
const persistedLevelSchema = z.number().int().min(0).max(5);

/** Non-persistent store for tests and standalone runs. */
export class InMemorySliderStore implements SliderStore {
  #level: SliderLevel;

  constructor(initialLevel: SliderLevel = DEFAULT_SLIDER_LEVEL) {
    this.#level = initialLevel;
  }

  get(): Promise<SliderLevel> {
    return Promise.resolve(this.#level);
  }

  set(level: SliderLevel): Promise<void> {
    this.#level = level;
    return Promise.resolve();
  }
}

/** `~/.golem/settings.json` — Golem's user-level settings file (CLAUDE.md). */
export function defaultGolemSettingsPath(): string {
  return join(homedir(), ".golem", "settings.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Persists `slider.level` (nested, matching the E1 config schema) inside a
 * JSON settings file via read-merge-write, leaving all other keys — including
 * other `slider` section keys — untouched. Writes go through a temp file +
 * rename in the same directory to avoid torn writes (rename replaces
 * atomically on all three supported platforms in Node >= 22).
 */
export class JsonFileSliderStore implements SliderStore {
  readonly #filePath: string;

  constructor(filePath: string = defaultGolemSettingsPath()) {
    this.#filePath = filePath;
  }

  async get(): Promise<SliderLevel> {
    const settings = await this.#readSettings();
    const section = settings.slider;
    if (isPlainObject(section)) {
      const nested = persistedLevelSchema.safeParse(section.level);
      if (nested.success) return migrateSliderLevel(nested.data);
    }
    // B1's pre-reconciliation flat key (migrated away on the next set()).
    const legacy = persistedLevelSchema.safeParse(settings[LEGACY_SLIDER_LEVEL_KEY]);
    return legacy.success ? migrateSliderLevel(legacy.data) : DEFAULT_SLIDER_LEVEL;
  }

  async set(level: SliderLevel): Promise<void> {
    const settings = await this.#readSettings();
    const existingSection = settings.slider;
    const section = isPlainObject(existingSection) ? existingSection : {};
    section.level = level;
    settings.slider = section;
    delete settings[LEGACY_SLIDER_LEVEL_KEY]; // migrate the flat B1 key
    await mkdir(dirname(this.#filePath), { recursive: true });
    const tempPath = `${this.#filePath}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await rename(tempPath, this.#filePath);
  }

  async #readSettings(): Promise<Record<string, unknown>> {
    let raw: string;
    try {
      raw = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    try {
      // Windows editors may prepend a UTF-8 BOM; JSON.parse rejects it.
      const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      const parsed: unknown = JSON.parse(stripped);
      if (isPlainObject(parsed)) {
        return { ...parsed };
      }
    } catch {
      // Corrupt settings file: fall through and start fresh rather than crash
      // the MCP server. The E1 loader owns richer diagnostics.
    }
    return {};
  }
}
