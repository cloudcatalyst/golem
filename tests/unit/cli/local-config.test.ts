/**
 * `golem local` — the local/LAN model surface (src/cli/local-config.ts).
 *
 * The probe and hardware detection are injected throughout, so nothing here
 * needs an Ollama (or a GPU) to run.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectLocalModel,
  isRemoteEndpoint,
  renderLocalCoderWrite,
  renderLocalModel,
  renderLocalUrlWrite,
  setLocalBaseUrl,
  setLocalCoderEnabled,
} from "../../../src/cli/local-config.js";
import { loadConfig, writeSetting } from "../../../src/config/index.js";
import { rmTemp } from "../../helpers/tmp.js";

let dir: string;

/** Injected detection so the report is deterministic on any machine. */
const detect = async () => ({ tier: 2 as const, coderModel: "qwen2.5-coder:7b" });

/**
 * Injected `/api/tags` so nothing here touches a real Ollama (task
 * `local-models` added the pulled-state lookup; left uninjected it would make
 * these tests depend on what the CI box happens to have downloaded).
 */
const pulled = (names: readonly string[]) => () => Promise.resolve(names.map((name) => ({ name })));
const listModels = pulled(["qwen2.5-coder:7b"]);

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "golem-local-"));
});
afterEach(async () => {
  await rm(dir, rmTemp);
});

describe("isRemoteEndpoint", () => {
  it("treats loopback spellings as local", () => {
    expect(isRemoteEndpoint("http://localhost:11434")).toBe(false);
    expect(isRemoteEndpoint("http://127.0.0.1:11434")).toBe(false);
    expect(isRemoteEndpoint("http://[::1]:11434")).toBe(false);
    expect(isRemoteEndpoint("http://0.0.0.0:11434")).toBe(false);
  });

  it("treats any other host as LAN/remote", () => {
    expect(isRemoteEndpoint("http://gpubox.lan:11434")).toBe(true);
    expect(isRemoteEndpoint("http://192.168.1.20:11434")).toBe(true);
  });

  it("does not claim an unparseable value is remote", () => {
    expect(isRemoteEndpoint("not a url")).toBe(false);
  });
});

describe("collectLocalModel", () => {
  it("reports the defaults: coder enabled, localhost, with provenance", async () => {
    const report = await collectLocalModel({
      projectDir: dir,
      userDir: dir,
      probe: async () => true,
      detect,
      listModels,
    });
    expect(report.reachable).toBe(true);
    expect(report.base_url).toBe("http://localhost:11434");
    expect(report.remote).toBe(false);
    expect(report.reachable).toBe(true);
    expect(report.active).toBe(true);
    expect(report.tier_name).toBe("P_MID");
    expect(report.model).toBe("qwen2.5-coder:7b");
    expect(report.model_state).toBe("pulled");
  });

  // Task `local-models`: naming the model was never the same as having it. A
  // never-pulled drafter/judge is what made `coder --refine` report rounds: 0.
  describe("coder_model_state", () => {
    it("is not-pulled when the endpoint answers but lacks the model", async () => {
      const report = await collectLocalModel({
        projectDir: dir,
        userDir: dir,
        probe: async () => true,
        detect,
        listModels: pulled(["bge-m3:latest"]),
      });
      expect(report.model_state).toBe("not-pulled");
      const out = renderLocalModel(report);
      expect(out).toContain("qwen2.5-coder:7b — NOT pulled");
      expect(out).toContain("ollama pull qwen2.5-coder:7b");
    });

    it("is unknown — never not-pulled — when the endpoint cannot be listed", async () => {
      const report = await collectLocalModel({
        projectDir: dir,
        userDir: dir,
        probe: async () => false,
        detect,
        listModels: () => Promise.reject(new Error("ECONNREFUSED")),
      });
      expect(report.model_state).toBe("unknown");
      const out = renderLocalModel(report);
      expect(out).toContain("pulled state unknown");
      expect(out).not.toContain("NOT pulled");
    });

    it("matches an untagged catalog id against the endpoint's tagged name", async () => {
      const report = await collectLocalModel({
        projectDir: dir,
        userDir: dir,
        probe: async () => true,
        detect: async () => ({ tier: 2 as const, coderModel: "bge-m3" }),
        listModels: pulled(["bge-m3:latest"]),
      });
      expect(report.model_state).toBe("pulled");
    });
  });

  /**
   * `active` is the field the display surfaces key off, and it must require BOTH
   * conditions — the bug behind the VS Code status bar showing a local model that
   * was turned off.
   */
  it("is active when the endpoint answers, regardless of coder target config", async () => {
    const report = await collectLocalModel({
      projectDir: dir,
      userDir: dir,
      probe: async () => true,
      detect,
      listModels,
    });
    expect(report.reachable).toBe(true);
    expect(report.active).toBe(true);
  });

  it("is not active when nothing answers", async () => {
    const report = await collectLocalModel({
      projectDir: dir,
      userDir: dir,
      probe: async () => false,
      detect,
      listModels,
    });
    expect(report.reachable).toBe(false);
    expect(report.active).toBe(false);
  });

  it("flags a LAN endpoint and probes the configured URL, not a hardcoded one", async () => {
    await writeSetting("project", "inference.ollama_base_url", "http://gpubox.lan:11434", {
      projectDir: dir,
    });
    const probed: string[] = [];
    const report = await collectLocalModel({
      projectDir: dir,
      userDir: dir,
      probe: async (url) => {
        probed.push(url);
        return true;
      },
      detect,
      listModels,
    });
    expect(probed).toEqual(["http://gpubox.lan:11434"]);
    expect(report.remote).toBe(true);
  });

  it("survives a detection failure rather than throwing out of a status command", async () => {
    const report = await collectLocalModel({
      projectDir: dir,
      userDir: dir,
      probe: async () => false,
      detect: async () => {
        throw new Error("no probe runner here");
      },
      listModels,
    });
    // The injected detect throws, so the report simply carries no model.
    expect(report.reachable).toBe(false);
    // …and with no model name, its pulled state is unknown rather than invented.
    expect(report.model).toBe("");
    expect(report.model_state).toBe("unknown");
  }, 10_000);
});

describe("setLocalCoderEnabled", () => {
  it("writes the setting and it is readable back through the loader", async () => {
    await setLocalCoderEnabled(false, "project", { projectDir: dir });
    expect(
      ((await loadConfig({ projectDir: dir, userDir: dir })).settings as any)
        .inference__coder_enabled,
    ).toBe(undefined);
    await setLocalCoderEnabled(true, "project", { projectDir: dir });
    expect(
      ((await loadConfig({ projectDir: dir, userDir: dir })).settings as any)
        .inference__coder_enabled,
    ).toBe(undefined);
  });

  it("honours the requested scope", async () => {
    await setLocalCoderEnabled(false, "local", { projectDir: dir });
    const raw = JSON.parse(
      await readFile(path.join(dir, ".golem", "settings.local.json"), "utf8"),
    ) as { inference?: { coder_enabled?: boolean } };
    expect((raw as any).inference?.worker_targets?.coder).toBe("__disabled__");
  });
});

describe("setLocalBaseUrl", () => {
  it("saves a LAN URL and reports the probe verdict", async () => {
    const result = await setLocalBaseUrl("http://gpubox.lan:11434", "project", {
      projectDir: dir,
      probeFn: async () => true,
    });
    expect(result.reachable).toBe(true);
    expect(result.remote).toBe(true);
    expect(
      (await loadConfig({ projectDir: dir, userDir: dir })).settings.inference.ollama_base_url,
    ).toBe("http://gpubox.lan:11434");
  });

  /**
   * A config command that refuses to point at a machine you'll boot later is
   * worse than one that saves and tells you the truth.
   */
  it("saves anyway when the endpoint does not answer, reporting it", async () => {
    const result = await setLocalBaseUrl("http://gpubox.lan:11434", "project", {
      projectDir: dir,
      probeFn: async () => false,
    });
    expect(result.reachable).toBe(false);
    expect(
      (await loadConfig({ projectDir: dir, userDir: dir })).settings.inference.ollama_base_url,
    ).toBe("http://gpubox.lan:11434");
  });

  it("skips the probe when asked, reporting an unknown verdict", async () => {
    let probed = false;
    const result = await setLocalBaseUrl("http://gpubox.lan:11434", "project", {
      projectDir: dir,
      probe: false,
      probeFn: async () => {
        probed = true;
        return true;
      },
    });
    expect(probed).toBe(false);
    expect(result.reachable).toBeNull();
  });

  it("rejects a non-URL before writing anything", async () => {
    await expect(
      setLocalBaseUrl("not a url at all", "project", { projectDir: dir, probe: false }),
    ).rejects.toThrow(/not a URL/);
    // Unchanged.
    expect(
      (await loadConfig({ projectDir: dir, userDir: dir })).settings.inference.ollama_base_url,
    ).toBe("http://localhost:11434");
  });

  /**
   * `new URL("gpubox:11434")` parses (scheme `gpubox:`), so a bare host:port must
   * be diagnosed as a missing scheme rather than as an exotic protocol.
   */
  it("tells the user to add http:// when they pass a bare host:port", async () => {
    await expect(
      setLocalBaseUrl("gpubox:11434", "project", { projectDir: dir, probe: false }),
    ).rejects.toThrow(/missing a scheme — write it as http:\/\/gpubox:11434/);
  });

  it("rejects a non-http(s) scheme", async () => {
    await expect(
      setLocalBaseUrl("ftp://gpubox.lan", "project", { projectDir: dir, probe: false }),
    ).rejects.toThrow(/unsupported scheme/);
  });
});

describe("rendering", () => {
  it("reports the local model as active when the endpoint answers", async () => {
    const out = renderLocalModel(
      await collectLocalModel({
        projectDir: dir,
        userDir: dir,
        probe: async () => true,
        detect,
        listModels,
      }),
    );
    expect(out).toContain("ACTIVE");
    expect(out).toContain("reachable");
  });

  it("gives LAN-specific advice when a remote endpoint is unreachable", async () => {
    await writeSetting("project", "inference.ollama_base_url", "http://gpubox.lan:11434", {
      projectDir: dir,
    });
    const out = renderLocalModel(
      await collectLocalModel({
        projectDir: dir,
        userDir: dir,
        probe: async () => false,
        detect,
        listModels,
      }),
    );
    expect(out).toContain("OLLAMA_HOST=0.0.0.0");
  });

  it("points at `golem ollama status` when the LOCAL endpoint is unreachable", async () => {
    const out = renderLocalModel(
      await collectLocalModel({
        projectDir: dir,
        userDir: dir,
        probe: async () => false,
        detect,
        listModels,
      }),
    );
    expect(out).toContain("golem ollama status");
    expect(out).not.toContain("OLLAMA_HOST");
  });

  it("reports an active local model without remediation noise", async () => {
    const out = renderLocalModel(
      await collectLocalModel({
        projectDir: dir,
        userDir: dir,
        probe: async () => true,
        detect,
        listModels,
      }),
    );
    expect(out).toContain("ACTIVE");
    expect(out).not.toContain("golem coder enable");
  });

  it("tells the user to restart after a toggle or a URL change", async () => {
    const toggle = await setLocalCoderEnabled(true, "project", { projectDir: dir });
    expect(renderLocalCoderWrite(toggle, true)).toMatch(/Restart Claude Code/);
    const url = await setLocalBaseUrl("http://gpubox.lan:11434", "project", {
      projectDir: dir,
      probe: false,
    });
    expect(renderLocalUrlWrite(url)).toMatch(/golem proxy restart/);
    expect(renderLocalUrlWrite(url)).toContain("LAN offload");
  });
});
