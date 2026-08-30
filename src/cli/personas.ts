/**
 * R14.1 — `golem personas`: what the bench is, where each field came from, and
 * which roles nobody has staffed.
 *
 * Split from `commands/personas.ts` on the line `targets.ts` splits from
 * `commands/target.ts`: this collects and renders, that wires up the verbs.
 *
 * The reporting job here is mostly **provenance**. A persona's fields can come
 * from four layers at once — the shipped bench supplies a description, the
 * project names a discipline, `settings.local.json` overrides one model — and
 * "why is the reviewer on Haiku" is unanswerable without saying which file did
 * it. The loader already records that per `inference.personas.<id>.<field>`;
 * this is the surface that shows it.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/index.js";
import type { LayerName } from "../config/loader.js";
import {
  type EffectivePersona,
  effectivePersonas,
  personaPromptPath,
  type PromptSource,
  resolvePersonaPrompt,
} from "../inference/personas.js";

export interface PersonaRow {
  readonly persona: EffectivePersona;
  /** Which layer supplied each field that is set, keyed by field name. */
  readonly fieldLayers: Readonly<Record<string, LayerName>>;
  readonly promptSource: PromptSource;
  readonly promptPath?: string;
}

export interface PersonasReport {
  readonly rows: readonly PersonaRow[];
  readonly projectDir: string;
  readonly warnings: readonly string[];
}

const REPORTED_FIELDS = [
  "discipline",
  "description",
  "model",
  "prompt",
  "prompt_file",
  "tools",
  "owner",
] as const;

export async function collectPersonas(
  projectDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<PersonasReport> {
  const { settings, provenance, warnings } = await loadConfig({ projectDir, env });
  const personas = settings.inference.personas;

  const rows: PersonaRow[] = [];
  for (const persona of effectivePersonas(personas)) {
    const config = personas[persona.id] ?? {};
    const fieldLayers: Record<string, LayerName> = {};
    for (const field of REPORTED_FIELDS) {
      const entry = provenance[`inference.personas.${persona.id}.${field}`];
      if (entry !== undefined) fieldLayers[field] = entry.layer;
    }

    // A broken `prompt_file` must not take the whole listing down: reporting the
    // bench is exactly when you want to SEE that the path is wrong.
    let promptSource: PromptSource = "built-in";
    let promptPath: string | undefined;
    try {
      const resolved = await resolvePersonaPrompt(persona.id, config, projectDir);
      promptSource = resolved.source;
      promptPath = resolved.path;
    } catch (err) {
      promptSource = "prompt_file";
      promptPath = `${config.prompt_file} (UNREADABLE: ${err instanceof Error ? err.message : String(err)})`;
    }

    rows.push({
      persona,
      fieldLayers,
      promptSource,
      ...(promptPath === undefined ? {} : { promptPath }),
    });
  }

  return { rows, projectDir, warnings };
}

function layerNote(row: PersonaRow, field: string): string {
  const layer = row.fieldLayers[field];
  return layer === undefined ? "" : ` (${layer})`;
}

export function renderPersonas(report: PersonasReport): string {
  const lines: string[] = [];
  lines.push("Golem personas — the bench (a persona never holds a credential):");

  if (report.rows.length === 0) {
    lines.push("  none declared.");
    return `${lines.join("\n")}\n`;
  }

  const staffed = report.rows.filter((r) => r.persona.staffed).length;

  for (const row of report.rows) {
    const p = row.persona;
    const marker = p.staffed ? "*" : " ";
    const discipline = p.discipline ?? "—";
    lines.push(
      `  ${marker} ${p.id.padEnd(14)} discipline=${discipline}${layerNote(row, "discipline")}`,
    );

    if (p.staffed) {
      lines.push(`        model=${p.model}${layerNote(row, "model")}`);
    } else {
      lines.push(
        "        UNSTAFFED — no model, so it declines rather than guessing. " +
          `Set inference.personas.${p.id}.model to staff it.`,
      );
    }

    if (p.owner === "user") {
      lines.push(
        "        owner=user — a role only a human fills; nothing may dispatch it" +
          layerNote(row, "owner"),
      );
    }
    if (p.tools !== undefined) {
      lines.push(`        tools=${p.tools.join(", ")}${layerNote(row, "tools")}`);
    } else if (p.staffed) {
      lines.push("        tools inherited from the session (no allow-list set)");
    }

    const where = row.promptPath === undefined ? "" : ` — ${row.promptPath}`;
    lines.push(`        prompt: ${row.promptSource}${where}`);

    if (p.description !== undefined) {
      lines.push(`        ${p.description}`);
    }
  }

  lines.push("");
  lines.push(
    `${report.rows.length} persona(s), ${staffed} staffed. ` +
      "Staffing lane (subagent vs dispatched worker) arrives with R14.2.",
  );
  lines.push("Edit a prompt with: golem personas eject <id>");

  for (const warning of report.warnings) {
    lines.push(`  ⚠ ${warning}`);
  }
  return `${lines.join("\n")}\n`;
}

export interface EjectResult {
  readonly path: string;
  readonly created: boolean;
  readonly source: PromptSource;
}

/**
 * Write a persona's currently-effective prompt to `.golem/personas/<id>.md` so
 * the user can edit it.
 *
 * **Never overwrites.** If the file is already there it is reported and left
 * alone: it is the user's, and the whole reason it exists is that they wanted to
 * change it. Ejecting twice must not silently discard the edit.
 */
export async function ejectPersonaPrompt(
  projectDir: string,
  id: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<EjectResult> {
  const { settings } = await loadConfig({ projectDir, env });
  const personas = settings.inference.personas;
  if (!Object.hasOwn(personas, id)) {
    const known = Object.keys(personas).sort().join(", ");
    throw new Error(
      `no persona "${id}" is declared. Declared personas: ${known || "(none)"}. ` +
        "Add it under inference.personas first.",
    );
  }

  const file = personaPromptPath(projectDir, id);
  try {
    await readFile(file, "utf8");
    const resolved = await resolvePersonaPrompt(id, personas[id] ?? {}, projectDir);
    return { path: file, created: false, source: resolved.source };
  } catch {
    // Absent — the case worth writing.
  }

  const resolved = await resolvePersonaPrompt(id, personas[id] ?? {}, projectDir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${resolved.text.trim()}\n`, "utf8");
  return { path: file, created: true, source: resolved.source };
}
