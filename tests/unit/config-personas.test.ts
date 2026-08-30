/**
 * R14.1: the persona registry — the starter bench, and the merge rule that
 * makes it the ONE leaf that does not replace wholesale.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadConfig } from "../../src/config/index.js";
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

const newTempDir = useTempDirs("golem-personas-test-");

beforeEach(async () => {
  base = await newTempDir();
  userDir = path.join(base, "user-golem");
  projectDir = path.join(base, "project");
  await mkdir(projectDir, { recursive: true });
});

describe("the starter bench", () => {
  it("ships coder, reviewer and scribe", () => {
    expect(Object.keys(DEFAULT_SETTINGS.inference.personas).sort()).toEqual([
      "coder",
      "reviewer",
      "scribe",
    ]);
  });

  it("ships every one of them UNSTAFFED — the property that keeps this inert", () => {
    // A shipped `model` would silently give every repo spawnable agents. The
    // bench is a template, not a team.
    for (const [id, persona] of Object.entries(DEFAULT_SETTINGS.inference.personas)) {
      expect(persona.model, `persona "${id}" must ship unstaffed`).toBeUndefined();
    }
  });

  it("staffs the phases, not the hierarchy — no manager, no planner", () => {
    const ids = Object.keys(DEFAULT_SETTINGS.inference.personas);
    expect(ids).not.toContain("manager");
    expect(ids).not.toContain("planner");
    expect(ids).not.toContain("architect");
  });

  it("leaves an unconfigured project's personas exactly as shipped", async () => {
    const config = await loadConfig({ projectDir, userDir, env: {} });
    expect(config.settings.inference.personas).toEqual(DEFAULT_SETTINGS.inference.personas);
    expect(config.warnings).toEqual([]);
  });
});

describe("per-persona-id merging", () => {
  it("does NOT let a project bench erase the user's", async () => {
    await writeJson(userFile(), {
      inference: { personas: { auditor: { discipline: "review" } } },
    });
    await writeJson(projectFile(), {
      inference: { personas: { migrator: { discipline: "code" } } },
    });

    const { settings } = await loadConfig({ projectDir, userDir, env: {} });
    const ids = Object.keys(settings.inference.personas);
    expect(ids).toContain("auditor"); // the user's — survives
    expect(ids).toContain("migrator"); // the project's
    expect(ids).toContain("coder"); // and the shipped bench beneath both
  });

  it("merges per FIELD within one persona, so a local override keeps the rest", async () => {
    await writeJson(projectFile(), {
      inference: {
        personas: {
          reviewer: { discipline: "review", description: "reads code as code", model: "opus" },
        },
      },
    });
    // The motivating case: thin budget this week, downgrade one persona without
    // restating the project's definition of it.
    await writeJson(localFile(), {
      inference: { personas: { reviewer: { model: "claude-haiku-4-5" } } },
    });

    const { settings } = await loadConfig({ projectDir, userDir, env: {} });
    const reviewer = settings.inference.personas.reviewer;
    expect(reviewer?.model).toBe("claude-haiku-4-5");
    expect(reviewer?.discipline).toBe("review");
    expect(reviewer?.description).toBe("reads code as code");
  });

  it("does not let a higher layer's silence overwrite a lower layer's explicit owner", async () => {
    // The bug a per-layer default would cause: `owner` is NOT defaulted while
    // parsing a layer, so a layer that merely mentions the persona cannot
    // silently demote a `user`-owned role to `agent`.
    await writeJson(projectFile(), {
      inference: { personas: { releaser: { discipline: "release", owner: "user" } } },
    });
    await writeJson(localFile(), {
      inference: { personas: { releaser: { model: "claude-sonnet-5" } } },
    });

    const { settings } = await loadConfig({ projectDir, userDir, env: {} });
    expect(settings.inference.personas.releaser?.owner).toBe("user");
  });

  it("REPLACES tools rather than merging them — an append-only allow-list is not one", async () => {
    await writeJson(projectFile(), {
      inference: { personas: { scribe: { tools: ["Read", "Write", "Bash"] } } },
    });
    await writeJson(localFile(), {
      inference: { personas: { scribe: { tools: ["Read"] } } },
    });

    const { settings } = await loadConfig({ projectDir, userDir, env: {} });
    expect(settings.inference.personas.scribe?.tools).toEqual(["Read"]);
  });

  it("reports provenance per persona field, not merely per leaf", async () => {
    await writeJson(projectFile(), {
      inference: { personas: { reviewer: { discipline: "review", model: "opus" } } },
    });
    await writeJson(localFile(), {
      inference: { personas: { reviewer: { model: "claude-haiku-4-5" } } },
    });

    const { provenance } = await loadConfig({ projectDir, userDir, env: {} });
    expect(provenance["inference.personas.reviewer.model"]?.layer).toBe("local");
    expect(provenance["inference.personas.reviewer.discipline"]?.layer).toBe("project");
  });
});

describe("fail-closed validation", () => {
  it("rejects a persona id that could escape a path", async () => {
    // The id becomes `.claude/agents/golem-<id>.md` (R14.3), so traversal must
    // be unrepresentable at the schema boundary, not sanitised downstream.
    await writeJson(projectFile(), {
      inference: { personas: { "../../evil": { discipline: "code" } } },
    });
    await expect(loadConfig({ projectDir, userDir, env: {} })).rejects.toThrow(
      /persona id|inference\.personas/i,
    );
  });

  it("rejects a persona id with a path separator", async () => {
    await writeJson(projectFile(), {
      inference: { personas: { "a/b": { discipline: "code" } } },
    });
    await expect(loadConfig({ projectDir, userDir, env: {} })).rejects.toThrow();
  });

  it("rejects an unknown persona field instead of silently ignoring it", async () => {
    // A silently-ignored line the user believes took effect is the failure
    // `unknownWorkerWarnings` exists to prevent — caught earlier here.
    await writeJson(projectFile(), {
      inference: { personas: { coder: { modle: "claude-sonnet-5" } } },
    });
    await expect(loadConfig({ projectDir, userDir, env: {} })).rejects.toThrow();
  });

  it("has no field for a credential, and refuses one if written", async () => {
    // ADR-0003 invariant 1: a persona names a model or a target; the gateway
    // behind it holds the key. There must be no way to put a secret here.
    await writeJson(projectFile(), {
      inference: { personas: { coder: { api_key: "sk-ant-nope" } } },
    });
    await expect(loadConfig({ projectDir, userDir, env: {} })).rejects.toThrow();
  });

  it("accepts a hyphenated id", async () => {
    await writeJson(projectFile(), {
      inference: { personas: { "api-reviewer": { discipline: "review" } } },
    });
    const { settings } = await loadConfig({ projectDir, userDir, env: {} });
    expect(settings.inference.personas["api-reviewer"]?.discipline).toBe("review");
  });
});
