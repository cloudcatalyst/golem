/** R14.1: the read side — defaults applied after the merge, and prompt precedence. */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PERSONA_PROMPTS,
  effectivePersona,
  effectivePersonas,
  GENERIC_PERSONA_PROMPT,
  personaPromptPath,
  personasForDiscipline,
  resolvePersonaPrompt,
} from "../../../src/inference/personas.js";
import { useTempDirs } from "../../helpers/tmp.js";

let projectDir: string;
const newTempDir = useTempDirs("golem-personas-read-");

beforeEach(async () => {
  projectDir = await newTempDir();
});

async function writePrompt(id: string, text: string): Promise<void> {
  const file = personaPromptPath(projectDir, id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
}

describe("effectivePersona", () => {
  it("defaults owner to agent", () => {
    expect(effectivePersona("coder", {}).owner).toBe("agent");
  });

  it("is unstaffed with no model, and says so rather than guessing", () => {
    const p = effectivePersona("scribe", { discipline: "write" });
    expect(p.staffed).toBe(false);
    expect(p.dispatchable).toBe(false);
    expect(p.model).toBeUndefined();
  });

  it("treats an empty model string as unstaffed", () => {
    expect(effectivePersona("coder", { model: "" }).staffed).toBe(false);
  });

  it("is staffed but NOT dispatchable when the owner is a human", () => {
    // The permission axis survives into the registry: a caller that checks only
    // `staffed` must not be able to dispatch a role only a human fills.
    const p = effectivePersona("releaser", { model: "claude-sonnet-5", owner: "user" });
    expect(p.staffed).toBe(true);
    expect(p.dispatchable).toBe(false);
  });

  it("is dispatchable when staffed and agent-owned", () => {
    const p = effectivePersona("coder", { model: "claude-sonnet-5" });
    expect(p.dispatchable).toBe(true);
  });
});

describe("effectivePersonas", () => {
  it("returns them in stable id order", () => {
    const list = effectivePersonas({ scribe: {}, coder: {}, reviewer: {} });
    expect(list.map((p) => p.id)).toEqual(["coder", "reviewer", "scribe"]);
  });
});

describe("personasForDiscipline", () => {
  const bench = {
    coder: { discipline: "code", model: "claude-sonnet-5" },
    scribe: { discipline: "write" },
    other: { discipline: "Write" },
  };

  it("matches case-insensitively, because discipline is a label and not an enum", () => {
    expect(personasForDiscipline(bench, "WRITE").map((p) => p.id)).toEqual(["other", "scribe"]);
  });

  it("returns nothing for a discipline nobody staffs, without throwing", () => {
    // R14.4's decision: an unstaffed discipline is inert, never an error.
    expect(personasForDiscipline(bench, "astrology")).toEqual([]);
  });
});

describe("resolvePersonaPrompt precedence", () => {
  it("prefers an inline prompt over everything", async () => {
    await writePrompt("coder", "from the file");
    const r = await resolvePersonaPrompt("coder", { prompt: "inline wins" }, projectDir);
    expect(r.text).toBe("inline wins");
    expect(r.source).toBe("inline");
  });

  it("reads an explicit prompt_file relative to the project", async () => {
    await mkdir(path.join(projectDir, "prompts"), { recursive: true });
    await writeFile(path.join(projectDir, "prompts", "p.md"), "explicit file\n", "utf8");
    const r = await resolvePersonaPrompt("coder", { prompt_file: "prompts/p.md" }, projectDir);
    expect(r.text).toBe("explicit file");
    expect(r.source).toBe("prompt_file");
  });

  it("THROWS when a named prompt_file cannot be read", async () => {
    // The user named a file. Substituting a built-in would silently run the
    // persona on a prompt they did not write.
    await expect(
      resolvePersonaPrompt("coder", { prompt_file: "prompts/missing.md" }, projectDir),
    ).rejects.toThrow();
  });

  it("uses the conventional .golem/personas/<id>.md when present", async () => {
    await writePrompt("scribe", "  ejected and edited  ");
    const r = await resolvePersonaPrompt("scribe", {}, projectDir);
    expect(r.text).toBe("ejected and edited");
    expect(r.source).toBe("convention");
    expect(r.path).toBe(personaPromptPath(projectDir, "scribe"));
  });

  it("falls back to the built-in when no file exists — the zero-files case", async () => {
    const r = await resolvePersonaPrompt("scribe", {}, projectDir);
    expect(r.source).toBe("built-in");
    expect(r.text).toBe(DEFAULT_PERSONA_PROMPTS.scribe);
  });

  it("gives an unknown persona the generic prompt rather than nothing", async () => {
    const r = await resolvePersonaPrompt("migrator", {}, projectDir);
    expect(r.source).toBe("generic");
    expect(r.text).toBe(GENERIC_PERSONA_PROMPT);
  });

  it("ships a built-in for every persona on the starter bench", () => {
    for (const id of ["coder", "reviewer", "scribe"]) {
      expect(DEFAULT_PERSONA_PROMPTS[id], `no built-in prompt for "${id}"`).toBeTruthy();
    }
  });
});
