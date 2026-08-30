/**
 * R13.12 — `golem init` generates `.claude/agents/golem-coder.md`.
 *
 * This is the whole delivery mechanism for a harness-run coder. Golem cannot
 * spawn a subagent (an MCP server exposes tools to its client and cannot invoke
 * the client's own tools), so the definition IS the feature — if init does not
 * write it, nothing else in R13.12 has any effect.
 *
 * Kept out of `cli-init.test.ts` deliberately: that file already raises its own
 * timeout for 36 `golemInit()` calls, and these cases each need a settings write
 * before init rather than a bare fresh project.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { golemInit, golemUninit, type InitProbe } from "../../src/cli/init.js";
import { useTempDirs } from "../helpers/tmp.js";

vi.setConfig({ testTimeout: 90_000 });

const newTempDir = useTempDirs("golem-init-agent");

const okProbe: InitProbe = {
  claudeCodeInstalled: () => Promise.resolve(true),
  headroomWrapActive: () => Promise.resolve(false),
};

let projectDir: string;
const AGENT_REL = path.join(".claude", "agents", "golem-coder.md");

beforeEach(async () => {
  projectDir = await newTempDir();
});

/** Write `.golem/settings.json` before init, the way a user's config arrives. */
async function writeGolemSettings(settings: Record<string, unknown>): Promise<void> {
  await mkdir(path.join(projectDir, ".golem"), { recursive: true });
  await writeFile(
    path.join(projectDir, ".golem", "settings.json"),
    JSON.stringify(settings, null, 2),
    "utf8",
  );
}

async function readAgent(): Promise<string | null> {
  try {
    return await readFile(path.join(projectDir, AGENT_REL), "utf8");
  } catch {
    return null;
  }
}

describe("golem init — the golem-coder subagent", () => {
  it("writes no agent when the coder persona is unstaffed", async () => {
    // R13.11's settled default: the work stays in the calling session, so there
    // is nothing to delegate to and no file to write.
    await golemInit({ projectDir, probe: okProbe });
    expect(await readAgent()).toBeNull();
  });

  it("writes the agent when the coder persona names a MODEL", async () => {
    await writeGolemSettings({ inference: { personas: { coder: { model: "claude-sonnet-5" } } } });
    const report = await golemInit({ projectDir, probe: okProbe });

    const content = await readAgent();
    expect(content).not.toBeNull();
    // The documented subagent frontmatter shape (verification-notes §114): a
    // plain model id, NOT `golem/<target>` — caveat 5 (the slash, Claude
    // Code-side) is still open, and a plain id sidesteps it entirely.
    expect(content).toContain("name: golem-coder");
    expect(content).toContain("model: claude-sonnet-5");
    // R14.3: scoped to the FRONTMATTER. The body legitimately mentions
    // `.golem/personas/<id>.md` now that a persona's prompt can be ejected
    // there; what must never appear is a `golem/<target>` selector as the model.
    expect((content ?? "").split("---")[1] ?? "").not.toContain("golem/");
    // The default prompt is the body, so the subagent and the `coder` MCP tool
    // are framed by the same text.
    expect(content).toContain("first draft for another engineer to review");
    expect(
      report.actions.some((a) =>
        a.path.replace(/\\/gu, "/").endsWith(AGENT_REL.replace(/\\/gu, "/")),
      ),
    ).toBe(true);
  });

  it("writes NO agent when the coder persona names a registry TARGET", async () => {
    // A target is dispatched to by Golem itself — there is no subagent involved,
    // so a definition would be a lie about where the work goes.
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
      },
      inference: { personas: { coder: { model: "openrouter:qwen/qwen3.7-flash" } } },
    });
    await golemInit({ projectDir, probe: okProbe });
    expect(await readAgent()).toBeNull();
  });

  it("carries a configured coder_prompt into the body", async () => {
    await writeGolemSettings({
      inference: {
        personas: { coder: { model: "sonnet" } },
        coder_prompt: "Be terse. Return only a unified diff.",
      },
    });
    await golemInit({ projectDir, probe: okProbe });

    const content = await readAgent();
    expect(content).toContain("Be terse. Return only a unified diff.");
    // The default must be gone, not merely appended to — one prompt, not two.
    expect(content).not.toContain("first draft for another engineer to review");
  });

  it("is idempotent — a second init reports `skip`, not a rewrite", async () => {
    await writeGolemSettings({ inference: { personas: { coder: { model: "sonnet" } } } });
    await golemInit({ projectDir, probe: okProbe });
    const first = await readAgent();

    const report = await golemInit({ projectDir, probe: okProbe });
    expect(await readAgent()).toBe(first);
    const action = report.actions.find((a) =>
      a.path.replace(/\\/gu, "/").endsWith("golem-coder.md"),
    );
    expect(action?.kind).toBe("skip");
  });

  it("REFRESHES the model when the persona's model changes and the file is untouched", async () => {
    await writeGolemSettings({ inference: { personas: { coder: { model: "sonnet" } } } });
    await golemInit({ projectDir, probe: okProbe });
    expect(await readAgent()).toContain("model: sonnet");

    await writeGolemSettings({ inference: { personas: { coder: { model: "claude-opus-5" } } } });
    await golemInit({ projectDir, probe: okProbe });
    expect(await readAgent()).toContain("model: claude-opus-5");
  });

  it("REMOVES a stale agent when the persona stops naming a model", async () => {
    // The case a pure install step would miss: the file would survive naming a
    // model the config no longer selects, and nothing in it would say so.
    await writeGolemSettings({ inference: { personas: { coder: { model: "sonnet" } } } });
    await golemInit({ projectDir, probe: okProbe });
    expect(await readAgent()).not.toBeNull();

    await writeGolemSettings({ inference: {} });
    const report = await golemInit({ projectDir, probe: okProbe });
    expect(await readAgent()).toBeNull();
    expect(
      report.actions.some(
        (a) => a.kind === "remove" && a.path.replace(/\\/gu, "/").endsWith("golem-coder.md"),
      ),
    ).toBe(true);
  });

  it("KEEPS a user-edited agent and reports a conflict (R9.5 provenance)", async () => {
    // This file is a prompt someone is expected to tune, and `golem init` runs on
    // every version bump — silently overwriting an edit would be the worst
    // possible behaviour for it.
    await writeGolemSettings({ inference: { personas: { coder: { model: "sonnet" } } } });
    await golemInit({ projectDir, probe: okProbe });

    const edited = `${await readAgent()}\n\nMy own house rule: never touch generated files.\n`;
    await writeFile(path.join(projectDir, AGENT_REL), edited, "utf8");

    await writeGolemSettings({ inference: { personas: { coder: { model: "claude-opus-5" } } } });
    const report = await golemInit({ projectDir, probe: okProbe });

    expect(await readAgent()).toBe(edited); // untouched
    const action = report.actions.find((a) =>
      a.path.replace(/\\/gu, "/").endsWith("golem-coder.md"),
    );
    expect(action?.kind).toBe("conflict");
  });

  it("does NOT delete a user-edited agent when the coder persona is unstaffed either", async () => {
    await writeGolemSettings({ inference: { personas: { coder: { model: "sonnet" } } } });
    await golemInit({ projectDir, probe: okProbe });
    const edited = `${await readAgent()}\n\nEdited.\n`;
    await writeFile(path.join(projectDir, AGENT_REL), edited, "utf8");

    await writeGolemSettings({ inference: {} });
    const report = await golemInit({ projectDir, probe: okProbe });
    expect(await readAgent()).toBe(edited);
    const action = report.actions.find((a) =>
      a.path.replace(/\\/gu, "/").endsWith("golem-coder.md"),
    );
    expect(action?.kind).toBe("conflict");
  });

  it("reports a conflict rather than aborting init on a malformed persona model", async () => {
    // The cure must not be worse than the disease: init exists to repair project
    // wiring, so one bad optional setting cannot stop the proxy being wired.
    await writeGolemSettings({
      inference: { personas: { coder: { model: "openrouter:nope/typo" } } },
    });
    const report = await golemInit({ projectDir, probe: okProbe });

    expect(await readAgent()).toBeNull();
    const action = report.actions.find((a) =>
      a.path.replace(/\\/gu, "/").endsWith("golem-coder.md"),
    );
    expect(action?.kind).toBe("conflict");
    expect(action?.detail).toMatch(/names neither a configured target nor a usable model id/);
    // Init still did its real job.
    expect(report.actions.some((a) => a.path.includes(".mcp.json"))).toBe(true);
  });

  it("uninit removes it", async () => {
    await writeGolemSettings({ inference: { personas: { coder: { model: "sonnet" } } } });
    await golemInit({ projectDir, probe: okProbe });
    expect(await readAgent()).not.toBeNull();

    await golemUninit({ projectDir, probe: okProbe });
    expect(await readAgent()).toBeNull();
  });
});
