/**
 * The control surface: one list of controls across settings, guidance rules, and
 * runtime state, and writes that route back to the real implementations.
 *
 * Runs against a temp project so nothing touches the developer's own config. The
 * proxy is never started here — `runtime:proxy` is only read, and the account
 * control is only read (switching it consults the OS credential store).
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { golemMcpEntry } from "../../src/cli/init.js";
import { defaultProjectPort } from "../../src/cli/proxy-daemon.js";
import {
  applyControl,
  type Control,
  type ControlSurface,
  collectControlSurface,
  collectHeader,
} from "../../src/config/control-surface.js";
import { rmTemp } from "../helpers/tmp.js";

let base: string;
let userDir: string;
let projectDir: string;

/** Keeps the header cheap and deterministic: no Ollama probe, no real network. */
const localProbe = async () => ({ reachable: false });
const OPTS = () => ({
  projectDir,
  userDir,
  version: "9.9.9-test",
  env: {},
  probeTimeoutMs: 50,
  localProbe,
});

const projectFile = () => path.join(projectDir, ".golem", "settings.json");
const rulePath = (name: string, personal = false) =>
  path.join(projectDir, ".claude", "rules", `golem-${name}${personal ? ".local" : ""}.md`);

function find(surface: ControlSurface, id: string): Control {
  for (const group of surface.groups) {
    for (const control of group.controls) {
      if (control.id === id) return control;
    }
  }
  throw new Error(`no control ${id} in ${surface.groups.map((g) => g.id).join(", ")}`);
}

function ids(surface: ControlSurface): string[] {
  return surface.groups.flatMap((g) => g.controls.map((c) => c.id));
}

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "golem-controls-test-"));
  userDir = path.join(base, "user-golem");
  projectDir = path.join(base, "project");
  // Write init markers so setSliderLevel sees an initialized project and
  // skips golemInit (which throws on a CI runner without Claude Code).
  await mkdir(path.join(projectDir, ".golem"), { recursive: true });
  const port = defaultProjectPort(projectDir);
  await writeFile(projectFile(), JSON.stringify({ proxy: { port } }), "utf8");
  await mkdir(path.join(projectDir, ".claude"), { recursive: true });
  await writeFile(
    path.join(projectDir, ".claude", "settings.json"),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://localhost:${port}` } }),
    "utf8",
  );
  await writeFile(
    path.join(projectDir, ".mcp.json"),
    JSON.stringify({ mcpServers: { golem: golemMcpEntry() } }),
    "utf8",
  );
  const SKILL_NAMES = [
    "slider",
    "stats",
    "expand",
    "bypass",
    "research",
    "wiki-ingest",
    "develop",
    "plan",
    "verify",
    "ship",
    "promote",
    "upstream",
    "debrief",
    "park",
    "triage",
    "cache-health",
    "context-hygiene",
    "fresh-eyes",
    "checkpoint",
  ];
  for (const s of SKILL_NAMES) {
    const dir = path.join(projectDir, ".claude", "skills", "golem", s);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), `# golem ${s}\n`, "utf8");
  }
});

afterEach(async () => {
  await rm(base, rmTemp);
});

describe("collectControlSurface", () => {
  it("groups settings, guidance, and runtime onto their tabs", async () => {
    const surface = await collectControlSurface(OPTS());
    const tabs = new Set(surface.groups.map((g) => g.tab));
    expect(tabs).toEqual(new Set(["settings", "guidance", "runtime"]));
    expect(ids(surface)).toContain("setting:knowledge.enabled");
    expect(ids(surface)).toContain("guidance:coder-first");
    expect(ids(surface)).toEqual(expect.arrayContaining(["runtime:slider", "runtime:proxy"]));
  });

  /**
   * R8.32 — the VS Code toggle read `proxy.running`, so it showed a healthy
   * daemon while Claude Code bypassed it entirely. A pid file naming this (very
   * much alive) process is enough to reach the running branch without starting
   * anything; the temp project has no wiring, which is the defect state.
   */
  it("reports a running proxy that Claude Code is not wired to", async () => {
    await writeFile(
      path.join(projectDir, ".golem", "proxy.pid"),
      JSON.stringify({
        pid: process.pid,
        port: defaultProjectPort(projectDir),
        ts: "2026-08-06T00:00:00.000Z",
      }),
      "utf8",
    );
    // The defect state: drop the wiring beforeEach installed, leaving a healthy
    // daemon with nothing pointed at it.
    await writeFile(path.join(projectDir, ".claude", "settings.json"), JSON.stringify({}), "utf8");
    const proxy = find(await collectControlSurface(OPTS()), "runtime:proxy");
    expect(proxy.summary).toContain("NOT in the request path");
    expect(proxy.detail).toContain("golem proxy wire");
  });

  it("omits the header by default, so the panel's first paint stays cheap", async () => {
    const surface = await collectControlSurface(OPTS());
    expect(surface.header).toBeNull();
    // Load warnings are still reported without it.
    expect(surface.warnings).toEqual([]);
  });

  it("reports the header on request, from the same source as `golem status`", async () => {
    const surface = await collectControlSurface({ ...OPTS(), withHeader: true });
    expect(surface.header).not.toBeNull();
    expect(surface.header?.version).toBe("9.9.9-test");
    expect(surface.header?.project_dir).toBe(path.resolve(projectDir));
    expect(surface.header?.slider.level).toBe(1);
  });

  it("collectHeader builds the same report on its own", async () => {
    const header = await collectHeader(OPTS());
    expect(header.version).toBe("9.9.9-test");
    expect(header.project_dir).toBe(path.resolve(projectDir));
  });

  it("omits leaves a runtime control owns, so nothing is editable twice", async () => {
    const surface = await collectControlSurface(OPTS());
    // slider.level is edited as runtime:slider; active_account as runtime:account.
    expect(ids(surface)).not.toContain("setting:slider.level");
    expect(ids(surface)).not.toContain("setting:proxy.active_account");
    expect(ids(surface)).toContain("runtime:slider");
    expect(ids(surface)).toContain("runtime:account");
  });

  it("carries provenance, widget kind, and writable scopes onto each control", async () => {
    await writeFile(projectFile(), JSON.stringify({ knowledge: { rerank_enabled: true } }), "utf8");
    const control = find(await collectControlSurface(OPTS()), "setting:knowledge.rerank_enabled");
    expect(control.kind).toBe("toggle");
    expect(control.value).toBe(true);
    expect(control.layer).toBe("project");
    expect(control.source).toBe(projectFile());
    expect(control.writableScopes).toEqual(["project", "local", "user"]);
    expect(control.locked).toBeUndefined();
  });

  it("locks a control the environment supplies, and explains why", async () => {
    const surface = await collectControlSurface({
      ...OPTS(),
      env: { GOLEM_KNOWLEDGE_ENABLED: "false" },
    });
    const control = find(surface, "setting:knowledge.enabled");
    expect(control.value).toBe(false);
    expect(control.layer).toBe("env");
    expect(control.locked).toContain("GOLEM_KNOWLEDGE_ENABLED");
    // Nothing to write to: a file write would be overridden and look like a no-op.
    expect(control.writableScopes).toEqual([]);
  });

  it("locks a structured value instead of offering to edit it", async () => {
    // R9.23: renamed from proxy.gateways → proxy.gateways
    const control = find(await collectControlSurface(OPTS()), "setting:proxy.gateways");
    expect(control.kind).toBe("opaque");
    expect(control.locked).toBeDefined();
    expect(control.writableScopes).toEqual([]);
  });

  it("marks advanced controls so a UI can hide them", async () => {
    const surface = await collectControlSurface(OPTS());
    expect(find(surface, "setting:proxy.connect_timeout_ms").advanced).toBe(true);
    expect(find(surface, "setting:knowledge.enabled").advanced).toBe(false);
  });

  it("passes the slider's danger warning through, with its levels", async () => {
    const slider = find(await collectControlSurface(OPTS()), "runtime:slider");
    expect(slider.options?.map((o) => o.value)).toEqual(["0", "1", "2", "3"]);
    expect(slider.danger).toContain("redaction");
    // The slider is a personal dial (Decision 43) — always local scope.
    expect(slider.writableScopes).toEqual(["local"]);
  });

  it("reads a guidance rule's presence per scope, not the coder-first setting", async () => {
    await mkdir(path.dirname(rulePath("coder-first")), { recursive: true });
    await writeFile(rulePath("coder-first"), "# rule\n", "utf8");
    // `guidanceEnabled` would report false here because the coder setting is off;
    // the panel must still show the rule as on, since it IS on disk.
    await writeFile(
      projectFile(),
      JSON.stringify({ inference: { local_reachable: false } }),
      "utf8",
    );
    const control = find(await collectControlSurface(OPTS()), "guidance:coder-first");
    expect(control.value).toBe(true);
    expect(control.layer).toBe("project");
  });

  it("distinguishes a personal guidance rule from a committed one", async () => {
    await mkdir(path.dirname(rulePath("durable-tasks", true)), { recursive: true });
    await writeFile(rulePath("durable-tasks", true), "# rule\n", "utf8");
    const control = find(await collectControlSurface(OPTS()), "guidance:durable-tasks");
    expect(control.value).toBe(true);
    expect(control.layer).toBe("user");
  });

  it("drops empty groups rather than rendering a bare heading", async () => {
    const surface = await collectControlSurface(OPTS());
    for (const group of surface.groups) {
      expect(group.controls.length, group.id).toBeGreaterThan(0);
    }
  });
});

describe("applyControl", () => {
  it("writes a setting to the requested scope and reports the effective value", async () => {
    const result = await applyControl("setting:knowledge.rerank_enabled", true, "project", OPTS());
    expect(result.value).toBe(true);
    expect(result.file).toBe(projectFile());
    const onDisk = JSON.parse(await readFile(projectFile(), "utf8")) as {
      knowledge?: { rerank_enabled?: boolean };
    };
    expect(onDisk.knowledge?.rerank_enabled).toBe(true);
  });

  it("accepts the same value spellings as `golem config set`", async () => {
    await applyControl("setting:knowledge.rerank_enabled", "on", "project", OPTS());
    const control = find(await collectControlSurface(OPTS()), "setting:knowledge.rerank_enabled");
    expect(control.value).toBe(true);
  });

  it("treats null as unset, reverting to the lower layer", async () => {
    await applyControl("setting:knowledge.wiki_dir", "docs/elsewhere", "project", OPTS());
    const result = await applyControl("setting:knowledge.wiki_dir", null, "project", OPTS());
    // Back to the built-in default, not left as the removed value.
    expect(result.value).toBe("docs/wiki");
    const control = find(await collectControlSurface(OPTS()), "setting:knowledge.wiki_dir");
    expect(control.layer).toBe("default");
  });

  it("says so when a higher layer overrides the write", async () => {
    await writeFile(
      path.join(projectDir, ".golem", "settings.local.json"),
      JSON.stringify({ knowledge: { rerank_enabled: true } }),
      "utf8",
    );
    const result = await applyControl("setting:knowledge.rerank_enabled", false, "project", OPTS());
    expect(result.overridden).toContain("local");
  });

  it("surfaces the restart a change needs", async () => {
    const result = await applyControl("setting:proxy.port", "4999", "project", OPTS());
    expect(result.restartHint).toContain("golem proxy restart");
  });

  it("refuses to write a control the environment controls", async () => {
    await expect(
      applyControl("setting:knowledge.enabled", false, "project", {
        ...OPTS(),
        env: { GOLEM_KNOWLEDGE_ENABLED: "true" },
      }),
    ).rejects.toThrow(/GOLEM_KNOWLEDGE_ENABLED/);
  });

  it("rejects a schema-invalid value instead of writing it", async () => {
    await expect(
      applyControl("setting:proxy.port", "not-a-port", "project", OPTS()),
    ).rejects.toThrow(/number/i);
    // The file is untouched — a rejected write must not half-apply.
    const onDisk = JSON.parse(await readFile(projectFile(), "utf8")) as Record<string, unknown>;
    expect(typeof onDisk.proxy).toBe("object");
  });

  it("rejects unknown ids and unknown families", async () => {
    await expect(applyControl("setting:nope.nope", true, "project", OPTS())).rejects.toThrow(
      /unknown setting/,
    );
    await expect(applyControl("bogus:thing", true, "project", OPTS())).rejects.toThrow(
      /unknown control/,
    );
    await expect(applyControl("guidance:nope", true, "project", OPTS())).rejects.toThrow(
      /unknown guidance feature/,
    );
  });

  it("writes and removes a guidance rule file", async () => {
    const on = await applyControl("guidance:durable-tasks", true, "project", OPTS());
    expect(on.value).toBe(true);
    expect(await readFile(rulePath("durable-tasks"), "utf8")).toContain("Managed by Golem");

    const off = await applyControl("guidance:durable-tasks", false, "project", OPTS());
    expect(off.value).toBe(false);
    await expect(readFile(rulePath("durable-tasks"), "utf8")).rejects.toThrow();
  });

  it("removes both scopes when disabling, so a committed rule can't keep it on", async () => {
    await applyControl("guidance:durable-tasks", true, "project", OPTS());
    await applyControl("guidance:durable-tasks", true, "user", OPTS());
    await applyControl("guidance:durable-tasks", false, "project", OPTS());
    await expect(readFile(rulePath("durable-tasks"), "utf8")).rejects.toThrow();
    await expect(readFile(rulePath("durable-tasks", true), "utf8")).rejects.toThrow();
  });

  it("writes the slider to local scope whatever scope is asked for", async () => {
    const result = await applyControl("runtime:slider", "2", "user", OPTS());
    expect(result.value).toBe("2");
    expect(result.file).toBe(path.join(projectDir, ".golem", "settings.local.json"));
  });

  it("rejects an out-of-range slider level", async () => {
    await expect(applyControl("runtime:slider", "7", "local", OPTS())).rejects.toThrow(/0–3/);
  });
});
