/**
 * R8.18 — `golem llamacpp`: the provider entry it writes, and the refusals it makes
 * before anything is downloaded.
 *
 * The refusals are the interesting half. A 20 GB download that should not have started
 * is the expensive failure mode, so "no model fits" and "that id does not exist" must be
 * answered from arithmetic and data, with no network and no consent prompt.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectModels,
  LLAMACPP_PROVIDER_ID,
  renderModels,
  renderSetupOutcome,
  runLlamacppSetup,
  writeProviderEntry,
} from "../../../src/cli/llamacpp.js";
import { loadConfig, writeSetting } from "../../../src/config/index.js";
import { createLlamacppDeps, type LlamacppDeps } from "../../../src/inference/index.js";

const GB = 1024 ** 3;

let dir: string;
let userDir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "golem-lcpp-proj-"));
  userDir = await mkdtemp(path.join(tmpdir(), "golem-lcpp-user-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(userDir, { recursive: true, force: true });
});

/** Deps that can do nothing: no network, no spawn, no probe. */
function inertDeps(overrides: Partial<LlamacppDeps> = {}): LlamacppDeps {
  return createLlamacppDeps({
    userDir,
    run: async () => ({ ok: false, stdout: "" }),
    install: async () => ({ ok: false, code: 1 }),
    fetchImpl: (async () => {
      throw new Error("no network in this test");
    }) as unknown as typeof fetch,
    onLine: () => {},
    ...overrides,
  });
}

describe("writeProviderEntry", () => {
  it("writes an entry the R8.15 resolver can use, with the live context window", async () => {
    await writeProviderEntry({
      projectDir: dir,
      userDir,
      scope: "project",
      modelId: "qwen3.6-35b-a3b-q4",
      port: 11435,
      contextWindow: 16384,
      roles: ["drafter", "judge"],
    });

    const { settings } = await loadConfig({ projectDir: dir, userDir });
    const entry = settings.inference.providers?.find((p) => p.id === LLAMACPP_PROVIDER_ID);
    expect(entry?.api).toBe("openai-completions");
    expect(entry?.base_url).toBe("http://127.0.0.1:11435/v1");
    expect(entry?.models[0]?.id).toBe("qwen3.6-35b-a3b-q4");
    expect(entry?.models[0]?.context_window).toBe(16384);
  });

  it("REPLACES its own entry and leaves other providers alone", async () => {
    await writeSetting(
      "project",
      "inference.providers",
      [
        { id: "lan-ollama", api: "ollama", base_url: "http://gpubox.lan:11434", models: [] },
        {
          id: LLAMACPP_PROVIDER_ID,
          api: "openai-completions",
          base_url: "http://127.0.0.1:9999/v1",
          models: [{ id: "an-older-model", roles: ["drafter"] }],
        },
      ],
      { projectDir: dir, userDir },
    );

    await writeProviderEntry({
      projectDir: dir,
      userDir,
      scope: "project",
      modelId: "qwen3-14b-q4",
      port: 11435,
      roles: ["drafter"],
    });

    const { settings } = await loadConfig({ projectDir: dir, userDir });
    const providers = settings.inference.providers ?? [];
    expect(providers.map((p) => p.id)).toEqual(["lan-ollama", LLAMACPP_PROVIDER_ID]);
    const mine = providers.find((p) => p.id === LLAMACPP_PROVIDER_ID);
    // Whole replacement, not a merge: no trace of the previous model's claims.
    expect(mine?.models).toHaveLength(1);
    expect(mine?.models[0]?.id).toBe("qwen3-14b-q4");
    expect(mine?.base_url).toBe("http://127.0.0.1:11435/v1");
  });

  it("omits the context window rather than inventing one", async () => {
    await writeProviderEntry({
      projectDir: dir,
      userDir,
      scope: "project",
      modelId: "qwen3-1.7b-q4",
      port: 11435,
      roles: ["classifier"],
    });
    const { settings } = await loadConfig({ projectDir: dir, userDir });
    const entry = settings.inference.providers?.find((p) => p.id === LLAMACPP_PROVIDER_ID);
    expect(entry?.models[0]?.context_window).toBeUndefined();
  });
});

describe("golem llamacpp setup — refusals before any download", () => {
  it("refuses an unknown model id and names how to list them", async () => {
    const outcome = await runLlamacppSetup({
      projectDir: dir,
      userDir,
      yes: true,
      modelId: "qwen9000",
      deps: inertDeps(),
    });
    expect(outcome.kind).toBe("refused");
    expect(outcome.problem).toContain("golem llamacpp models");
    expect(renderSetupOutcome(outcome)).toContain("qwen9000");
  });

  it("refuses on measured limits with the arithmetic, and before any network call", async () => {
    // A 128K window puts an ~8 GB KV cache on top of the weights, so on any ordinary
    // machine this exceeds either usable RAM or the temp volume's free space. Which of
    // the two refuses depends on the machine — what must hold everywhere is that it
    // refuses with numbers, and that the inert fetch (which throws) is never reached.
    let fetched = false;
    const outcome = await runLlamacppSetup({
      projectDir: dir,
      userDir,
      yes: true,
      contextTokens: 131072,
      deps: inertDeps({
        fetchImpl: (async () => {
          fetched = true;
          throw new Error("a refusal must happen before any download");
        }) as unknown as typeof fetch,
      }),
      modelsDir: path.join(dir, "models"),
      port: 11435,
    });

    expect(outcome.kind).toBe("refused");
    expect(outcome.problem ?? "").toContain("GB");
    expect(fetched).toBe(false);
  });

  it("refuses a named model that does not fit, quoting the arithmetic", async () => {
    const outcome = await runLlamacppSetup({
      projectDir: dir,
      userDir,
      yes: true,
      modelId: "qwen3.6-35b-a3b-q8", // 36 GB of weights
      contextTokens: 131072,
      deps: inertDeps(),
    });
    expect(outcome.kind).toBe("refused");
    expect(outcome.problem).toContain("GB");
  });
});

describe("golem llamacpp models", () => {
  it("ranks against THIS machine and never recommends an unproven entry", async () => {
    const report = await collectModels({ projectDir: dir, userDir, deps: inertDeps() });
    expect(report.rows.length).toBeGreaterThan(4);
    // `proven: false` entries are listed so the trade is visible…
    expect(report.rows.some((r) => !r.proven)).toBe(true);
    // …but never win the recommendation.
    if (report.recommended !== undefined) {
      expect(report.recommended.model.proven).toBe(true);
    }
  });

  it("marks entries that do not fit rather than hiding them", async () => {
    const report = await collectModels({ projectDir: dir, userDir, deps: inertDeps() });
    const rendered = renderModels(report, false);
    expect(rendered).toContain("golem llamacpp setup --model");
    // Whether a given entry fits depends on the test machine, so assert the shape:
    // every row is present with a verdict either way.
    for (const row of report.rows) expect(rendered).toContain(row.id);
  });

  it("emits JSON with the machine facts it judged against", async () => {
    const report = await collectModels({ projectDir: dir, userDir, deps: inertDeps() });
    const parsed = JSON.parse(renderModels(report, true)) as {
      facts: { freeRamBytes: number };
      usableRamBytes: number;
    };
    expect(parsed.facts.freeRamBytes).toBeGreaterThan(0);
    // Usable is a fraction of FREE, not of total — the whole point of the fit check.
    expect(parsed.usableRamBytes).toBeLessThan(parsed.facts.freeRamBytes);
  });
});

describe("recorded configuration", () => {
  it("reads the models dir, model and port back out of settings", async () => {
    await writeSetting("project", "inference.llamacpp_models_dir", path.join(dir, "weights"), {
      projectDir: dir,
      userDir,
    });
    await writeSetting("project", "inference.llamacpp_model", "qwen3-14b-q4", {
      projectDir: dir,
      userDir,
    });
    await writeSetting("project", "inference.llamacpp_port", 12345, { projectDir: dir, userDir });

    const report = await collectModels({ projectDir: dir, userDir, deps: inertDeps() });
    expect(report.modelsDir).toBe(path.join(dir, "weights"));
    expect(report.configuredModelId).toBe("qwen3-14b-q4");
    expect(renderModels(report, false)).toContain("CONFIGURED");

    // And the setting really landed in the project file, not just in memory.
    const raw = await readFile(path.join(dir, ".golem", "settings.json"), "utf8");
    expect(JSON.parse(raw)).toMatchObject({ inference: { llamacpp_port: 12345 } });
  });
});

describe("MachineFacts sanity", () => {
  it("judges against free RAM and a real volume, both measured", async () => {
    const report = await collectModels({ projectDir: dir, userDir, deps: inertDeps() });
    expect(report.facts.totalRamBytes).toBeGreaterThan(GB);
    expect(report.facts.freeDiskBytes).toBeGreaterThan(0);
    expect(report.contextTokens).toBeGreaterThan(0);
  });
});
