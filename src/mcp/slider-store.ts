/**
 * Slider-level persistence for the MCP server (WS-B task B1).
 *
 * WS-E owns the full settings hierarchy (`src/config/`, task E1). Until that
 * lands, the MCP server persists the slider level behind this small injected
 * interface so `golem_set_slider` survives restarts without WS-B growing a
 * config loader. The JSON file implementation uses the documented Golem user
 * settings location (`~/.golem/settings.json`) and the snake_case key
 * `slider_level` (CLAUDE.md conventions), merging with — and preserving —
 * any other keys already in the file so WS-E's loader can take over later.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { SliderLevel } from "../interfaces/index.js";

/** Default slider level when nothing has been persisted yet (P0: lossless). */
export const DEFAULT_SLIDER_LEVEL: SliderLevel = 1;

/** Snake_case settings key holding the slider level (CLAUDE.md conventions). */
export const SLIDER_LEVEL_SETTINGS_KEY = "slider_level";

/** Minimal persistence boundary for the slider level. */
export interface SliderStore {
  /** Current level, or DEFAULT_SLIDER_LEVEL when nothing is persisted. */
  get(): Promise<SliderLevel>;
  /** Persist a new level. */
  set(level: SliderLevel): Promise<void>;
}

const sliderLevelSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

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

/**
 * Persists `slider_level` inside a JSON settings file via read-merge-write,
 * leaving all other keys untouched. Writes go through a temp file + rename in
 * the same directory to avoid torn writes (rename replaces atomically on all
 * three supported platforms in Node >= 22).
 */
export class JsonFileSliderStore implements SliderStore {
  readonly #filePath: string;

  constructor(filePath: string = defaultGolemSettingsPath()) {
    this.#filePath = filePath;
  }

  async get(): Promise<SliderLevel> {
    const settings = await this.#readSettings();
    const parsed = sliderLevelSchema.safeParse(settings[SLIDER_LEVEL_SETTINGS_KEY]);
    return parsed.success ? parsed.data : DEFAULT_SLIDER_LEVEL;
  }

  async set(level: SliderLevel): Promise<void> {
    const settings = await this.#readSettings();
    settings[SLIDER_LEVEL_SETTINGS_KEY] = level;
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
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      // Corrupt settings file: fall through and start fresh rather than crash
      // the MCP server. WS-E's loader will own richer diagnostics.
    }
    return {};
  }
}
