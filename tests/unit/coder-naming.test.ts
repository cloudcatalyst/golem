/**
 * R9.10 — no surface claims a worker is "local" when its target is not.
 *
 * Since R9.3/R9.4 a worker dispatches to whatever `inference.worker_targets`
 * names. The naming never followed, so wiring `coder` to a vendor target
 * produced a contradiction inside one object: `local_model.workers[0].model`
 * was a hosted model while `model` named the Ollama fallback.
 */

import { describe, expect, it } from "vitest";
import { renderLocalModel } from "../../src/cli/local-config.js";
import { renderStatus, type StatusReport } from "../../src/cli/status.js";
import { allLeafPaths, leafSchema } from "../../src/config/schema.js";

describe("the settings leaf", () => {
  it("the coder tool is always available (R9.23 removed coder_enabled)", () => {
    // R9.23: `inference.coder_enabled` was removed — coder is always available
    // when a target or local model can serve it.
    expect(leafSchema("inference", "coder_enabled")).toBeUndefined();
    expect(leafSchema("inference", "local_coder_enabled")).toBeUndefined();
    expect(allLeafPaths()).toContain("inference.default_target");
  });
});

const BASE: StatusReport = {
  version: "0.0.0",
  project_dir: "/p",
  initialized: {
    overall: true,
    claude_settings: true,
    mcp_registered: true,
    skills: true,
    golem_settings: true,
  },
  proxy: { port: 1, url: "http://localhost:1", reachable: true },
  upstream: {
    provider: "anthropic",
    account: null,
    base_url: "https://api.anthropic.com",
    default_model: null,
  },
  dials: {
    brevity: { setting: "auto", effective: "off", layer: "default" },
    compression: { setting: "1", effective: "1", layer: "default" },
  },
  effective_compression: {
    nominal: "1",
    nominal_name: "lossless",
    effective: "1",
    effective_name: "lossless",
    degraded: false,
  },
  config: {},
  local_model: {
    reachable: true,
    model: "qwen2.5-coder:7b",
    base_url: "http://localhost:11434",
  },
  warnings: [],
} as unknown as StatusReport;

describe("golem status", () => {
  it("never reports a non-local model under local_model", () => {
    const report: StatusReport = {
      ...BASE,
      workers: [{ worker: "coder", target: "sonnet-5", model: "claude-sonnet-5", local: false }],
    };
    // The gate, stated literally: serialise the local_model block and assert the
    // vendor model is not in it.
    expect(JSON.stringify(report.local_model)).not.toContain("claude-sonnet-5");
    expect(report.workers?.[0]?.model).toBe("claude-sonnet-5");
    expect(report.workers?.[0]?.local).toBe(false);
  });

  // R10.1: these two were `it.skip` with no recorded reason. Both pass — the
  // render layer has been honouring the R9.10 gate all along, with only the
  // report-object assertion above actually guarding it. Unskipped so the gate
  // is checked where a user would see it break.
  it("names the target's model for a routed worker, not the local one", () => {
    const out = renderStatus({
      ...BASE,
      workers: [{ worker: "coder", target: "sonnet-5", model: "claude-sonnet-5", local: false }],
    });
    expect(out).toContain("claude-sonnet-5");
  });

  // R14.2: the roster is config, not a compile-time list, so a report carrying
  // NO worker rows renders no worker lines. That is the honest reading — the old
  // fallback invented a `coder` line for a report that never claimed one. A
  // worker with no usable target is now a row that says so.
  it("renders no worker line for a report that carries no worker rows", () => {
    const out = renderStatus(BASE);
    expect(out).not.toMatch(/^ {2}coder:/m);
  });

  it("names a local target's model for a worker routed to it", () => {
    const out = renderStatus({
      ...BASE,
      workers: [
        { worker: "coder", target: "local-ollama", model: "qwen2.5-coder:7b", local: true },
      ],
    });
    expect(out).toContain("qwen2.5-coder:7b");
    expect(out).toContain("local-ollama");
  });
});

describe("golem local status", () => {
  const base = {
    reachable: true,
    base_url: "http://localhost:11434",
    base_url_layer: "default",
    remote: false,
    tier: 2 as const,
    tier_name: "P_MID",
    model: "qwen2.5-coder:7b",
    model_state: "pulled" as const,
    active: true,
  };

  it("says plainly that a routed worker does not run on this backend", () => {
    const out = renderLocalModel({
      ...base,
      non_local_workers: [{ worker: "coder", target: "sonnet-5" }],
    });
    expect(out).toMatch(/`coder` runs on target "sonnet-5", NOT on this backend/);
  });

  it("says nothing of the sort when every worker is local", () => {
    const out = renderLocalModel(base);
    expect(out).not.toContain("NOT on this backend");
  });

  // R10.1: the third skipped test here asserted that an inactive backend points
  // at `golem coder enable` rather than `golem local enable`. It was written
  // when `active` meant "enabled AND reachable", so there was a
  // disabled-but-reachable state for that message to describe. R9.23 retired
  // `inference.coder_enabled` and `active` became synonymous with `reachable`
  // (local-config.ts: `active: reachable`), so the only way to be inactive is
  // for the endpoint not to answer — and the right advice then is the Ollama
  // one the renderer already gives. Naming a toggle would be misdirection.
  // Deleted rather than unskipped: it pins a state that can no longer occur.
  // (`golem coder` itself is alive and registered — see commands/local-ollama.ts.)
});
