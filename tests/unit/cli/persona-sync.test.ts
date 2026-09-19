/**
 * R14.x — `resolveDesiredAgents` / `syncPersonaArtifacts` (src/cli/persona-sync.ts).
 *
 * These behaviors were previously only reachable through `golemInit()` end to
 * end (see `tests/integration/cli-init-coder-agent.test.ts` and
 * `cli-init-persona-agents.test.ts`, which still cover the full write/prune
 * pipeline and provenance). This file exercises the RESOLUTION step directly,
 * now that it is its own function — no proxy wiring, no skills, no credential
 * store in the way.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveDesiredAgents, syncPersonaArtifacts } from "../../../src/cli/persona-sync.js";
import { useTempDirs } from "../../helpers/tmp.js";

let projectDir: string;
let userDir: string;
const newTempDir = useTempDirs("golem-persona-sync-");

beforeEach(async () => {
  projectDir = await newTempDir();
  await mkdir(path.join(projectDir, ".golem"), { recursive: true });
  userDir = path.join(await newTempDir(), ".golem");
});

async function writeSettings(value: unknown): Promise<void> {
  await writeFile(
    path.join(projectDir, ".golem", "settings.json"),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

describe("resolveDesiredAgents", () => {
  it("carries a configured inference.coder_prompt into the coder's resolved prompt", async () => {
    await writeSettings({
      inference: {
        personas: { coder: { model: "claude-sonnet-5" } },
        coder_prompt: "Be terse. Return only a unified diff.",
      },
    });
    const { desired, problems } = await resolveDesiredAgents(projectDir);
    expect(problems).toEqual([]);
    const coder = desired.find((d) => d.id === "coder");
    expect(coder?.prompt).toBe("Be terse. Return only a unified diff.");
  });

  it("an explicit per-persona prompt wins over inference.coder_prompt", async () => {
    await writeSettings({
      inference: {
        personas: { coder: { model: "claude-sonnet-5", prompt: "My own words." } },
        coder_prompt: "Be terse. Return only a unified diff.",
      },
    });
    const { desired } = await resolveDesiredAgents(projectDir);
    expect(desired.find((d) => d.id === "coder")?.prompt).toBe("My own words.");
  });

  it("isolates one malformed persona — a bad model doesn't stop a sibling from resolving", async () => {
    await writeSettings({
      inference: {
        personas: {
          coder: { model: "openrouter:nope/typo" }, // names neither a target nor a usable model id
          scribe: { model: "claude-haiku-4-5" },
        },
      },
    });
    const { desired, problems } = await resolveDesiredAgents(projectDir);

    expect(desired.map((d) => d.id)).toEqual(["scribe"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe("conflict");
    expect(problems[0]?.path.replace(/\\/gu, "/")).toMatch(/golem-coder\.md$/);
    expect(problems[0]?.detail).toMatch(/not written/);
  });

  it("excludes a WORKER-lane persona — Golem dispatches that itself, no definition", async () => {
    await writeSettings({
      proxy: {
        gateways: [
          {
            id: "openrouter",
            provider: "openrouter",
            base_url: "https://openrouter.ai/api/v1",
            models: ["qwen/qwen3.7-flash"],
          },
        ],
        targets: [
          { id: "cheap", gateway: "openrouter", model: "qwen/qwen3.7-flash", trust: "third-party" },
        ],
      },
      inference: { personas: { triage: { model: "cheap" } } },
    });
    const { desired, problems } = await resolveDesiredAgents(projectDir);
    expect(desired).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("excludes a human-owned (`owner: user`) persona", async () => {
    await writeSettings({
      inference: { personas: { releaser: { model: "claude-sonnet-5", owner: "user" } } },
    });
    const { desired } = await resolveDesiredAgents(projectDir);
    expect(desired).toEqual([]);
  });

  it("accepts a userDir override — merges a persona staffed only at that user layer", async () => {
    await mkdir(userDir, { recursive: true });
    await writeFile(
      path.join(userDir, "settings.json"),
      `${JSON.stringify({ inference: { personas: { scribe: { model: "claude-haiku-4-5" } } } }, null, 2)}\n`,
      "utf8",
    );
    await writeSettings({ inference: { personas: { coder: { model: "claude-sonnet-5" } } } });

    const { desired } = await resolveDesiredAgents(projectDir, userDir);
    expect(desired.map((d) => d.id).sort()).toEqual(["coder", "scribe"]);
  });

  it("reports one conflict at the agents directory when config itself is unreadable, rather than throwing", async () => {
    // An unknown persona field fails schema validation inside loadConfig — the
    // whole-config failure this function's own top-level catch exists for,
    // distinct from the per-persona catch above.
    await writeSettings({ inference: { personas: { coder: { modle: "claude-sonnet-5" } } } });

    const { desired, problems } = await resolveDesiredAgents(projectDir);
    expect(desired).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe("conflict");
    expect(problems[0]?.path.replace(/\\/gu, "/")).toMatch(/\.claude\/agents$/);
    expect(problems[0]?.detail).toMatch(/no agent definitions written/);
  });
});

describe("syncPersonaArtifacts", () => {
  it("writes the agent definition AND the preference rule from one call", async () => {
    await writeSettings({ inference: { personas: { coder: { model: "claude-sonnet-5" } } } });
    const actions = await syncPersonaArtifacts(projectDir, false);

    expect(
      actions.some((a) => a.path.replace(/\\/gu, "/").endsWith(".claude/agents/golem-coder.md")),
    ).toBe(true);
    expect(
      actions.some((a) =>
        a.path.replace(/\\/gu, "/").endsWith(".claude/rules/golem-prefer-persona-agents.md"),
      ),
    ).toBe(true);
  });

  it("dry run reports actions without writing", async () => {
    await writeSettings({ inference: { personas: { coder: { model: "claude-sonnet-5" } } } });
    const actions = await syncPersonaArtifacts(projectDir, true);
    expect(actions.some((a) => a.kind === "create")).toBe(true);
    const { readFile } = await import("node:fs/promises");
    await expect(
      readFile(path.join(projectDir, ".claude", "agents", "golem-coder.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
