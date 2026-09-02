/** R14.1: `golem personas` — the report, its provenance, and the eject verb. */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { collectPersonas, ejectPersonaPrompt, renderPersonas } from "../../../src/cli/personas.js";
import { DEFAULT_PERSONA_PROMPTS, personaPromptPath } from "../../../src/inference/personas.js";
import { useTempDirs } from "../../helpers/tmp.js";

let projectDir: string;
const newTempDir = useTempDirs("golem-cli-personas-");

beforeEach(async () => {
  projectDir = await newTempDir();
  await mkdir(path.join(projectDir, ".golem"), { recursive: true });
});

async function writeSettings(file: "settings.json" | "settings.local.json", value: unknown) {
  await writeFile(
    path.join(projectDir, ".golem", file),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

describe("collectPersonas", () => {
  it("reports the shipped bench as unstaffed on an untouched project", async () => {
    await writeSettings("settings.json", {});
    const report = await collectPersonas(projectDir, {});
    expect(report.rows.map((r) => r.persona.id)).toEqual(["coder", "reviewer", "scribe"]);
    expect(report.rows.every((r) => !r.persona.staffed)).toBe(true);
  });

  it("names the layer that supplied each field, not merely the bench", async () => {
    // "Why is the reviewer on Haiku" is unanswerable without this.
    await writeSettings("settings.json", {
      inference: { personas: { reviewer: { model: "claude-sonnet-5" } } },
    });
    await writeSettings("settings.local.json", {
      inference: { personas: { reviewer: { model: "claude-haiku-4-5" } } },
    });

    const report = await collectPersonas(projectDir, {});
    const reviewer = report.rows.find((r) => r.persona.id === "reviewer");
    expect(reviewer?.persona.model).toBe("claude-haiku-4-5");
    expect(reviewer?.fieldLayers.model).toBe("local");
  });

  it("reports an unreadable prompt_file instead of throwing the whole listing away", async () => {
    // Listing the bench is exactly when you want to SEE that the path is wrong.
    await writeSettings("settings.json", {
      inference: { personas: { coder: { prompt_file: "nope/missing.md" } } },
    });
    const report = await collectPersonas(projectDir, {});
    const coder = report.rows.find((r) => r.persona.id === "coder");
    expect(coder?.promptPath).toMatch(/UNREADABLE/);
  });
});

describe("renderPersonas", () => {
  it("says a persona is unstaffed and how to staff it", async () => {
    await writeSettings("settings.json", {});
    const out = renderPersonas(await collectPersonas(projectDir, {}));
    expect(out).toContain("UNSTAFFED");
    expect(out).toContain("inference.personas.coder.model");
    expect(out).toContain("0 staffed");
  });

  it("marks a human-owned role as undispatchable", async () => {
    await writeSettings("settings.json", {
      inference: { personas: { releaser: { model: "claude-sonnet-5", owner: "user" } } },
    });
    const out = renderPersonas(await collectPersonas(projectDir, {}));
    expect(out).toContain("owner=user");
    expect(out).toContain("nothing may dispatch it");
  });

  it("never prints a credential-shaped field, because none exists", async () => {
    await writeSettings("settings.json", {
      inference: { personas: { coder: { model: "claude-sonnet-5" } } },
    });
    const out = renderPersonas(await collectPersonas(projectDir, {}));
    expect(out).toContain("never holds a credential");
    expect(out).not.toMatch(/api[_-]?key/i);
  });
});

describe("ejectPersonaPrompt", () => {
  it("writes the effective prompt to .golem/personas/<id>.md", async () => {
    await writeSettings("settings.json", {});
    const result = await ejectPersonaPrompt(projectDir, "scribe", {});
    expect(result.created).toBe(true);
    expect(result.path).toBe(personaPromptPath(projectDir, "scribe"));
    const written = await readFile(result.path, "utf8");
    expect(written.trim()).toBe(DEFAULT_PERSONA_PROMPTS.scribe);
  });

  it("NEVER overwrites an edited prompt", async () => {
    await writeSettings("settings.json", {});
    const first = await ejectPersonaPrompt(projectDir, "scribe", {});
    await writeFile(first.path, "my own words\n", "utf8");

    const second = await ejectPersonaPrompt(projectDir, "scribe", {});
    expect(second.created).toBe(false);
    expect((await readFile(first.path, "utf8")).trim()).toBe("my own words");
  });

  it("refuses an undeclared persona and names the ones that exist", async () => {
    await writeSettings("settings.json", {});
    await expect(ejectPersonaPrompt(projectDir, "nobody", {})).rejects.toThrow(
      /no persona "nobody".*coder, reviewer, scribe/s,
    );
  });
});
