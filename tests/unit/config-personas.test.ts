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
  it("ships planner, coder, reviewer and scribe", () => {
    expect(Object.keys(DEFAULT_SETTINGS.inference.personas).sort()).toEqual([
      "coder",
      "planner",
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

  it("staffs the phases, not the hierarchy — no manager", () => {
    // There is no `manager`: the interactive session is the only thing that
    // can spawn a subagent, so a persona whose job is to dispatch is a
    // fiction. `planner` IS on the bench (R14.x) — planning is a phase like
    // any other, not a hierarchy role.
    const ids = Object.keys(DEFAULT_SETTINGS.inference.personas);
    expect(ids).not.toContain("manager");
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

  it("follows the most specific layer's declared order for keys it mentions", async () => {
    // Fixed 2026-09-17: a naive `{ ...previous }` then per-key reassignment
    // let the SCHEMA DEFAULT's order (coder, reviewer, scribe) win forever,
    // because JS fixes a key's position at first insertion — reassigning an
    // EXISTING key updates its value without moving it. A user who reordered
    // `inference.personas` in settings.local.json saw no change on any
    // consumer that reads key order (`golem statusline`'s persona list).
    await writeJson(localFile(), {
      inference: {
        personas: {
          planner: { discipline: "plan" },
          scribe: { discipline: "write" },
          coder: { discipline: "code" },
        },
      },
    });

    const { settings } = await loadConfig({ projectDir, userDir, env: {} });
    // `planner`, `scribe`, `coder` in the order THIS layer wrote them —
    // reversing coder-before-scribe from the schema default. `reviewer`
    // wasn't mentioned by this layer at all, so it keeps its prior relative
    // order (last, since it was last in the default) and lands after.
    expect(Object.keys(settings.inference.personas)).toEqual([
      "planner",
      "scribe",
      "coder",
      "reviewer",
    ]);
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

describe("retiring inference.default_coder", () => {
  it("RAISES rather than warning, naming the file, the key and the replacement", async () => {
    // A warning would reproduce the exact failure migrations.ts exists to stop:
    // the file still says `default_coder`, the user still believes a model is
    // selected, and every surface reports success.
    await writeJson(projectFile(), { inference: { default_coder: "claude-sonnet-5" } });
    await expect(loadConfig({ projectDir, userDir, env: {} })).rejects.toThrow(
      /default_coder.*retired in R14\.1.*inference\.personas\.coder\.model/s,
    );
  });

  it("raises from whichever layer still carries it", async () => {
    await writeJson(localFile(), { inference: { default_coder: "sonnet" } });
    await expect(loadConfig({ projectDir, userDir, env: {} })).rejects.toThrow(
      /settings\.local\.json/,
    );
  });

  it("is not merely 'unknown setting' — that would only warn", async () => {
    await writeJson(projectFile(), { inference: { default_coder: "sonnet" } });
    const result = await loadConfig({ projectDir, userDir, env: {} }).catch((e: unknown) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).not.toMatch(/unknown setting/);
  });

  it("loads cleanly once migrated to the persona", async () => {
    await writeJson(projectFile(), {
      inference: { personas: { coder: { model: "claude-sonnet-5" } } },
    });
    const { settings, warnings } = await loadConfig({ projectDir, userDir, env: {} });
    expect(settings.inference.personas.coder?.model).toBe("claude-sonnet-5");
    expect(warnings).toEqual([]);
  });
});
