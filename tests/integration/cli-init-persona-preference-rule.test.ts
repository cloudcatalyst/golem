/**
 * R14.x — `golem init` generates `.claude/rules/golem-prefer-persona-agents.md`,
 * the sibling to `.claude/agents/golem-<id>.md` that tells a session to reach for
 * the persona bench before the built-in `fork` subagent type.
 *
 * Mirrors `cli-init-persona-agents.test.ts` and `cli-init-coder-agent.test.ts`:
 * same managed-file provenance discipline, same "presence follows staffing, no
 * separate toggle" rule — just for one file whose content is the whole roster
 * rather than one file per persona.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { golemInit, golemUninit, type InitProbe } from "../../src/cli/init.js";
import { useTempDirs } from "../helpers/tmp.js";

vi.setConfig({ testTimeout: 90_000 });

const newTempDir = useTempDirs("golem-init-persona-pref-rule");

const okProbe: InitProbe = {
  claudeCodeInstalled: () => Promise.resolve(true),
  headroomWrapActive: () => Promise.resolve(false),
};

let projectDir: string;
const RULE_REL = path.join(".claude", "rules", "golem-prefer-persona-agents.md");

beforeEach(async () => {
  projectDir = await newTempDir();
});

async function writeGolemSettings(settings: Record<string, unknown>): Promise<void> {
  await mkdir(path.join(projectDir, ".golem"), { recursive: true });
  await writeFile(
    path.join(projectDir, ".golem", "settings.json"),
    JSON.stringify(settings, null, 2),
    "utf8",
  );
}

async function readRule(): Promise<string | null> {
  try {
    return await readFile(path.join(projectDir, RULE_REL), "utf8");
  } catch {
    return null;
  }
}

function actionFor(
  report: Awaited<ReturnType<typeof golemInit>>,
): { kind: string; detail: string } | undefined {
  return report.actions.find((a) =>
    a.path.replace(/\\/gu, "/").endsWith("golem-prefer-persona-agents.md"),
  );
}

describe("golem init — the golem-prefer-persona-agents rule", () => {
  it("writes NOTHING when no persona is staffed on the agent lane", async () => {
    await golemInit({ projectDir, probe: okProbe });
    expect(await readRule()).toBeNull();
  });

  it("writes the rule once at least one persona resolves to the agent lane", async () => {
    await writeGolemSettings({ inference: { personas: { coder: { model: "claude-sonnet-5" } } } });
    const report = await golemInit({ projectDir, probe: okProbe });

    const content = await readRule();
    expect(content).not.toBeNull();
    expect(content).toContain("golem-coder");
    expect(content).toContain("claude-sonnet-5");
    // The reason fork does not substitute for a staffed persona.
    expect(content).toContain("fork");
    expect(content).toContain('a `model` override on a fork call "is\nignored"');
    expect(actionFor(report)?.kind).toBe("create");
  });

  it("lists every agent-lane persona, with its model and description", async () => {
    await writeGolemSettings({
      inference: {
        personas: {
          coder: { model: "claude-sonnet-5", description: "Writes code." },
          scribe: { model: "claude-haiku-4-5" },
        },
      },
    });
    await golemInit({ projectDir, probe: okProbe });

    const content = (await readRule()) ?? "";
    expect(content).toContain("golem-coder");
    expect(content).toContain("claude-sonnet-5");
    expect(content).toContain("Writes code.");
    expect(content).toContain("golem-scribe");
    expect(content).toContain("claude-haiku-4-5");
  });

  it("shows a persona's discipline in its roster line when it has one", async () => {
    await writeGolemSettings({
      inference: {
        personas: {
          coder: { model: "claude-sonnet-5", discipline: "code", description: "Writes code." },
        },
      },
    });
    await golemInit({ projectDir, probe: okProbe });

    const content = (await readRule()) ?? "";
    expect(content).toContain("- `golem-coder` — claude-sonnet-5 (code) — Writes code.");
  });

  it("renders exactly as before for a persona with no discipline set", async () => {
    // A custom id outside the shipped bench, so no schema default supplies a
    // discipline the way it would for `coder`/`reviewer`/`scribe`/`planner`.
    await writeGolemSettings({
      inference: {
        personas: { migrator: { model: "claude-sonnet-5", description: "Moves data." } },
      },
    });
    await golemInit({ projectDir, probe: okProbe });

    const content = (await readRule()) ?? "";
    expect(content).toContain("- `golem-migrator` — claude-sonnet-5 — Moves data.");
  });

  it("omits a WORKER-lane persona and a human-owned one from the roster", async () => {
    await writeGolemSettings({
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
      inference: {
        personas: {
          coder: { model: "claude-sonnet-5" },
          triage: { model: "cheap" },
          releaser: { model: "claude-sonnet-5", owner: "user" },
        },
      },
    });
    await golemInit({ projectDir, probe: okProbe });

    const content = (await readRule()) ?? "";
    expect(content).toContain("golem-coder");
    expect(content).not.toContain("golem-triage");
    expect(content).not.toContain("golem-releaser");
  });

  it("updates content when the staffed set changes", async () => {
    await writeGolemSettings({ inference: { personas: { coder: { model: "claude-sonnet-5" } } } });
    await golemInit({ projectDir, probe: okProbe });
    expect(await readRule()).not.toContain("golem-scribe");

    await writeGolemSettings({
      inference: {
        personas: {
          coder: { model: "claude-sonnet-5" },
          scribe: { model: "claude-haiku-4-5" },
        },
      },
    });
    const report = await golemInit({ projectDir, probe: okProbe });
    expect(await readRule()).toContain("golem-scribe");
    expect(actionFor(report)?.kind).toBe("modify");
  });

  it("is deterministic — a second init reports `skip`, not a rewrite", async () => {
    await writeGolemSettings({ inference: { personas: { coder: { model: "claude-sonnet-5" } } } });
    await golemInit({ projectDir, probe: okProbe });
    const first = await readRule();

    const report = await golemInit({ projectDir, probe: okProbe });
    expect(await readRule()).toBe(first);
    expect(actionFor(report)?.kind).toBe("skip");
  });

  it("removes the rule when the set of agent-lane personas becomes empty", async () => {
    await writeGolemSettings({ inference: { personas: { coder: { model: "claude-sonnet-5" } } } });
    await golemInit({ projectDir, probe: okProbe });
    expect(await readRule()).not.toBeNull();

    await writeGolemSettings({ inference: { personas: { coder: {} } } });
    const report = await golemInit({ projectDir, probe: okProbe });
    expect(await readRule()).toBeNull();
    expect(actionFor(report)?.kind).toBe("remove");
  });

  it("KEEPS a user-edited rule and reports a conflict (R9.5 provenance)", async () => {
    await writeGolemSettings({ inference: { personas: { coder: { model: "claude-sonnet-5" } } } });
    await golemInit({ projectDir, probe: okProbe });

    const edited = `${await readRule()}\n\nMy own house rule.\n`;
    await writeFile(path.join(projectDir, RULE_REL), edited, "utf8");

    await writeGolemSettings({
      inference: {
        personas: {
          coder: { model: "claude-sonnet-5" },
          scribe: { model: "claude-haiku-4-5" },
        },
      },
    });
    const report = await golemInit({ projectDir, probe: okProbe });

    expect(await readRule()).toBe(edited); // untouched
    expect(actionFor(report)?.kind).toBe("conflict");
  });

  it("does NOT delete a user-edited rule when the roster becomes empty either", async () => {
    await writeGolemSettings({ inference: { personas: { coder: { model: "claude-sonnet-5" } } } });
    await golemInit({ projectDir, probe: okProbe });
    const edited = `${await readRule()}\n\nEdited.\n`;
    await writeFile(path.join(projectDir, RULE_REL), edited, "utf8");

    await writeGolemSettings({ inference: { personas: { coder: {} } } });
    const report = await golemInit({ projectDir, probe: okProbe });

    expect(await readRule()).toBe(edited);
    expect(actionFor(report)?.kind).toBe("conflict");
  });

  it("dry-run makes no filesystem changes", async () => {
    await writeGolemSettings({ inference: { personas: { coder: { model: "claude-sonnet-5" } } } });
    const report = await golemInit({ projectDir, probe: okProbe, dryRun: true });

    expect(await readRule()).toBeNull();
    expect(actionFor(report)?.kind).toBe("create");
  });

  it("uninit removes it", async () => {
    await writeGolemSettings({ inference: { personas: { coder: { model: "claude-sonnet-5" } } } });
    await golemInit({ projectDir, probe: okProbe });
    expect(await readRule()).not.toBeNull();

    await golemUninit({ projectDir, probe: okProbe });
    expect(await readRule()).toBeNull();
  });
});
