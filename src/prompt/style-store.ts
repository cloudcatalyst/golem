/**
 * R5.5 (WS-F7 / spec 20g) — accepted prompt-translation examples (spike).
 *
 * A tiny local store of (raw note → prompt the user accepted) pairs under
 * `<project>/.golem/prompt-style/examples.jsonl`, used as few-shot grounding so
 * translations drift toward the user's own accepted style over time. Local-only,
 * best-effort; never leaves the machine, never on the proxy path.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface StyleExample {
  readonly raw: string;
  readonly translated: string;
  readonly ts: string;
}

export function styleDir(projectDir: string): string {
  return path.join(projectDir, ".golem", "prompt-style");
}
const examplesPath = (projectDir: string): string =>
  path.join(styleDir(projectDir), "examples.jsonl");
const lastPath = (projectDir: string): string => path.join(styleDir(projectDir), "last.json");

/** Read accepted examples (most recent last). Never throws. */
export async function readExamples(projectDir: string, limit = 20): Promise<StyleExample[]> {
  try {
    const raw = await readFile(examplesPath(projectDir), "utf8");
    const out: StyleExample[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const e = JSON.parse(line) as StyleExample;
        if (typeof e.raw === "string" && typeof e.translated === "string") out.push(e);
      } catch {
        // skip a corrupt line
      }
    }
    return out.slice(-limit);
  } catch {
    return [];
  }
}

/** Append an accepted example. Best-effort; never throws. */
export async function appendExample(projectDir: string, example: StyleExample): Promise<void> {
  try {
    await mkdir(styleDir(projectDir), { recursive: true });
    await appendFile(examplesPath(projectDir), `${JSON.stringify(example)}\n`, "utf8");
  } catch {
    // teaching Golem your style is best-effort
  }
}

/** Stash the last suggestion so `golem prompt accept` can record it. Never throws. */
export async function writeLastSuggestion(
  projectDir: string,
  raw: string,
  translated: string,
): Promise<void> {
  try {
    await mkdir(styleDir(projectDir), { recursive: true });
    await writeFile(lastPath(projectDir), JSON.stringify({ raw, translated }, null, 2), "utf8");
  } catch {
    // best-effort
  }
}

/** Read the last stashed suggestion, or null. Never throws. */
export async function readLastSuggestion(
  projectDir: string,
): Promise<{ raw: string; translated: string } | null> {
  try {
    const j = JSON.parse(await readFile(lastPath(projectDir), "utf8")) as {
      raw?: unknown;
      translated?: unknown;
    };
    if (typeof j.raw === "string" && typeof j.translated === "string") {
      return { raw: j.raw, translated: j.translated };
    }
    return null;
  } catch {
    return null;
  }
}
