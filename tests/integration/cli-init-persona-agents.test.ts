/**
 * R14.3 — `golem init` generates one `.claude/agents/golem-<id>.md` per staffed,
 * agent-lane persona, and takes them away again when config stops calling for one.
 *
 * R13.12's single-file version is covered by `cli-init-coder-agent.test.ts`.
 * What is new here is everything that only exists at N: several definitions at
 * once, the cases that must REMOVE one, and — the sharp edge — a `golem-*.md`
 * that Golem never wrote, which must never be deleted no matter what the roster
 * says.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { golemInit, golemUninit, type InitProbe } from "../../src/cli/init.js";
import { useTempDirs } from "../helpers/tmp.js";

vi.setConfig({ testTimeout: 90_000 });

const newTempDir = useTempDirs("golem-init-personas");

const okProbe: InitProbe = {
  claudeCodeInstalled: () => Promise.resolve(true),
  headroomWrapActive: () => Promise.resolve(false),
};

let projectDir: string;

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

const agentPath = (id: string): string =>
  path.join(projectDir, ".claude", "agents", `golem-${id}.md`);

async function readAgent(id: string): Promise<string | null> {
  try {
    return await readFile(agentPath(id), "utf8");
  } catch {
    return null;
  }
}

async function listAgents(): Promise<string[]> {
  try {
    return (await readdir(path.join(projectDir, ".claude", "agents"))).sort();
  } catch {
    return [];
  }
}

/** A registry with one real dispatch target, for the worker-lane case. */
const REGISTRY = {
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
};

describe("golem init — N persona definitions", () => {
  it("writes one definition per staffed agent-lane persona", async () => {
    await writeGolemSettings({
      inference: {
        personas: {
          coder: { model: "claude-sonnet-5" },
          scribe: { model: "claude-haiku-4-5" },
        },
      },
    });
    await golemInit({ projectDir, probe: okProbe });

    expect(await listAgents()).toEqual(["golem-coder.md", "golem-scribe.md"]);
    expect(await readAgent("scribe")).toContain("model: claude-haiku-4-5");
    expect(await readAgent("coder")).toContain("model: claude-sonnet-5");
  });

  it("writes NOTHING when the bench ships unstaffed — the inert default", async () => {
    await writeGolemSettings({});
    await golemInit({ projectDir, probe: okProbe });
    expect(await listAgents()).toEqual([]);
  });

  it("writes no definition for a WORKER-lane persona — Golem dispatches that itself", async () => {
    await writeGolemSettings({
      proxy: REGISTRY,
      inference: { personas: { triage: { model: "cheap" } } },
    });
    await golemInit({ projectDir, probe: okProbe });
    expect(await readAgent("triage")).toBeNull();
  });

  it("writes no definition for a human-owned role", async () => {
    await writeGolemSettings({
      inference: { personas: { releaser: { model: "claude-sonnet-5", owner: "user" } } },
    });
    await golemInit({ projectDir, probe: okProbe });
    expect(await readAgent("releaser")).toBeNull();
  });

  it("never emits a `golem/` virtual id in frontmatter (§114 caveat 5 still open)", async () => {
    await writeGolemSettings({
      inference: { personas: { coder: { model: "claude-sonnet-5" } } },
    });
    await golemInit({ projectDir, probe: okProbe });
    // Scoped to the FRONTMATTER: the body legitimately mentions
    // `.golem/personas/<id>.md`. What must never appear is a `golem/<target>`
    // selector as the model, which §114 caveat 5 leaves unconfirmed.
    const body = (await readAgent("coder")) ?? "";
    const frontmatter = body.split("---")[1] ?? "";
    expect(frontmatter).not.toContain("golem/");
    expect(frontmatter).toContain("model: claude-sonnet-5");
  });

  it("is deterministic — a second init reports no change", async () => {
    await writeGolemSettings({
      inference: { personas: { coder: { model: "claude-sonnet-5" } } },
    });
    await golemInit({ projectDir, probe: okProbe });
    const first = await readAgent("coder");
    await golemInit({ projectDir, probe: okProbe });
    expect(await readAgent("coder")).toBe(first);
  });

  it("carries the ejected prompt from .golem/personas/<id>.md", async () => {
    await writeGolemSettings({
      inference: { personas: { scribe: { model: "claude-haiku-4-5" } } },
    });
    await mkdir(path.join(projectDir, ".golem", "personas"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".golem", "personas", "scribe.md"),
      "MY OWN SCRIBE INSTRUCTIONS",
      "utf8",
    );
    await golemInit({ projectDir, probe: okProbe });
    expect(await readAgent("scribe")).toContain("MY OWN SCRIBE INSTRUCTIONS");
  });
});

describe("de-generation — config stops calling for a definition", () => {
  async function staffThenChange(next: Record<string, unknown>): Promise<void> {
    await writeGolemSettings({
      inference: {
        personas: { coder: { model: "claude-sonnet-5" }, scribe: { model: "claude-haiku-4-5" } },
      },
    });
    await golemInit({ projectDir, probe: okProbe });
    expect(await readAgent("scribe")).not.toBeNull();
    await writeGolemSettings(next);
    await golemInit({ projectDir, probe: okProbe });
  }

  it("removes a definition when the persona is UNSTAFFED", async () => {
    await staffThenChange({
      inference: { personas: { coder: { model: "claude-sonnet-5" }, scribe: {} } },
    });
    expect(await readAgent("scribe")).toBeNull();
    expect(await readAgent("coder")).not.toBeNull();
  });

  it("removes a definition when the persona is REMOVED entirely", async () => {
    await staffThenChange({
      inference: { personas: { coder: { model: "claude-sonnet-5" } } },
    });
    expect(await readAgent("scribe")).toBeNull();
  });

  it("removes a definition when the persona is restaffed to a WORKER target", async () => {
    // The case a pure install step would miss: the file is not overwritten, it
    // should cease to exist.
    await staffThenChange({
      proxy: REGISTRY,
      inference: { personas: { coder: { model: "claude-sonnet-5" }, scribe: { model: "cheap" } } },
    });
    expect(await readAgent("scribe")).toBeNull();
  });

  it("removes a definition when the persona becomes human-owned", async () => {
    await staffThenChange({
      inference: {
        personas: {
          coder: { model: "claude-sonnet-5" },
          scribe: { model: "claude-haiku-4-5", owner: "user" },
        },
      },
    });
    expect(await readAgent("scribe")).toBeNull();
  });
});

describe("the ledger decides deletion, never the prefix", () => {
  it("NEVER deletes a golem-*.md it has no record of writing", async () => {
    // `.claude/agents/` is a SHARED namespace. A user's own `golem-writer.md`
    // is not Golem's to remove, however confidently the roster says nobody is
    // called `writer`. This is the sharpest edge in R14.3.
    await mkdir(path.join(projectDir, ".claude", "agents"), { recursive: true });
    await writeFile(agentPath("writer"), "MINE, HAND-WRITTEN, NOT GOLEM'S\n", "utf8");
    await writeGolemSettings({
      inference: { personas: { coder: { model: "claude-sonnet-5" } } },
    });

    await golemInit({ projectDir, probe: okProbe });

    expect(await readAgent("writer")).toContain("MINE, HAND-WRITTEN");
  });

  it("KEEPS a definition the user has edited, and reports a conflict", async () => {
    await writeGolemSettings({
      inference: { personas: { scribe: { model: "claude-haiku-4-5" } } },
    });
    await golemInit({ projectDir, probe: okProbe });
    await writeFile(agentPath("scribe"), "I TUNED THIS MYSELF\n", "utf8");

    // Unstaff it: even now, an edited file is not Golem's to delete.
    await writeGolemSettings({ inference: { personas: { scribe: {} } } });
    const report = await golemInit({ projectDir, probe: okProbe });

    expect(await readAgent("scribe")).toContain("I TUNED THIS MYSELF");
    expect(
      report.actions.some((a) => a.kind === "conflict" && a.path.includes("golem-scribe")),
    ).toBe(true);
  });

  it("uninit removes what Golem wrote and leaves what it did not", async () => {
    await mkdir(path.join(projectDir, ".claude", "agents"), { recursive: true });
    await writeFile(agentPath("writer"), "MINE\n", "utf8");
    await writeGolemSettings({
      inference: { personas: { coder: { model: "claude-sonnet-5" } } },
    });
    await golemInit({ projectDir, probe: okProbe });
    expect(await readAgent("coder")).not.toBeNull();

    await golemUninit({ projectDir, probe: okProbe });

    expect(await readAgent("coder")).toBeNull();
    expect(await readAgent("writer")).toContain("MINE");
  });
});
