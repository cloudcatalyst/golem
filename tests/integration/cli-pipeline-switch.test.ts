/**
 * R11.3 — `golem on` / `golem off` must PERSIST, and must say what they did.
 *
 * The bug these pin: the switch used to be one POST to the running proxy's
 * admin endpoint, so it survived nothing and no surface could see it. Every
 * status surface reads `proxy.bypass_all` from settings, so a machine forwarding
 * raw — redaction included in what was skipped — rendered as a healthy pipeline
 * and `REDACTION_OFF_WARNING` never fired.
 *
 * Nothing in the suite covered these two commands at all, which is why it
 * survived R11.1's sweep. These tests exercise the switch through the same
 * function the commands call, with a stub listener standing in for the proxy.
 */

import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderPipelineSwitch, setPipelineState } from "../../src/cli/pipeline-switch.js";
import { loadConfig } from "../../src/config/index.js";
import { useTempDirs } from "../helpers/tmp.js";

const newTempDir = useTempDirs("golem-pipeline-switch");

let projectDir: string;
let listener: Server | undefined;
/** Admin paths the stub proxy was asked for, in order. */
let hits: string[];

beforeEach(async () => {
  projectDir = await newTempDir();
  hits = [];
});

afterEach(async () => {
  if (listener !== undefined) {
    await new Promise<void>((resolve) => listener?.close(() => resolve()));
    listener = undefined;
  }
});

/** A stand-in for the running proxy: records the admin path and answers 200. */
async function stubProxy(): Promise<number> {
  listener = createServer((req, res) => {
    hits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  return new Promise<number>((resolve) => {
    listener?.listen(0, "127.0.0.1", () => {
      const addr = listener?.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
    });
  });
}

const localSettings = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path.join(projectDir, ".golem", "settings.local.json"), "utf8"));

/** A port nothing is listening on, for the "not running" path. */
const DEAD_PORT = 45_999;

describe("golem off (R11.3)", () => {
  it("persists proxy.bypass_all = true, so the state survives a restart", async () => {
    const port = await stubProxy();

    const result = await setPipelineState(projectDir, port, false);

    const written = await localSettings();
    expect((written.proxy as Record<string, unknown>).bypass_all).toBe(true);
    // And the loader agrees, which is what every status surface reads.
    const { settings } = await loadConfig({ projectDir });
    expect(settings.proxy.bypass_all).toBe(true);
    expect(result.enabled).toBe(false);
  });

  it("also applies live, so no restart is needed", async () => {
    const port = await stubProxy();

    const result = await setPipelineState(projectDir, port, false);

    expect(hits).toEqual(["/__golem/pipeline/false"]);
    expect(result.appliedLive).toBe(true);
  });

  it("says redaction is off, and how to undo it", async () => {
    const port = await stubProxy();
    const out = renderPipelineSwitch(await setPipelineState(projectDir, port, false), port);

    expect(out).toContain("REDACTION IS OFF");
    expect(out).toContain("persists across restarts");
    expect(out).toContain("golem on");
    // The compression/redaction confusion R11.1 was about: point at the dial.
    expect(out).toContain("golem compression off");
  });
});

describe("golem on (R11.3)", () => {
  it("persists proxy.bypass_all = false and applies live", async () => {
    const port = await stubProxy();
    await setPipelineState(projectDir, port, false);
    hits.length = 0;

    const result = await setPipelineState(projectDir, port, true);

    const { settings } = await loadConfig({ projectDir });
    expect(settings.proxy.bypass_all).toBe(false);
    expect(hits).toEqual(["/__golem/pipeline/true"]);
    expect(renderPipelineSwitch(result, port)).toContain("survives a restart");
  });

  it("round-trips: off then on leaves the pipeline running, not merely un-bypassed", async () => {
    const port = await stubProxy();
    await setPipelineState(projectDir, port, false);
    await setPipelineState(projectDir, port, true);

    const { settings } = await loadConfig({ projectDir });
    expect(settings.proxy.bypass_all).toBe(false);
    // The dials are untouched by the master switch — it is not a dial (ADR-0004).
    // `compression.level` is the string union `off|1|2|3` (R11.1).
    expect(settings.compression.level).toBe("1");
  });
});

describe("the switch with no proxy listening", () => {
  it("still records the setting, and says when it takes effect", async () => {
    const result = await setPipelineState(projectDir, DEAD_PORT, false);

    const { settings } = await loadConfig({ projectDir });
    expect(settings.proxy.bypass_all).toBe(true);
    expect(result.appliedLive).toBe(false);
    const out = renderPipelineSwitch(result, DEAD_PORT);
    expect(out).toContain("the proxy is not running, so it applies when it starts");
    // Still loud: the state is armed even though nothing is serving yet.
    expect(out).toContain("REDACTION IS OFF");
  });
});
