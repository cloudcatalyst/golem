/**
 * Decision 53 — the Python side of the Headroom config passthrough.
 *
 * The TS suite deliberately fakes the worker in Node so CI needs no Python, which
 * leaves `_build_config` — the actual passthrough logic — untested. This runs the
 * real worker script against a stub `headroom` (see the `.py` fixture) and checks
 * the behaviour that matters: an option Golem has never heard of is forwarded, an
 * option the install rejects is reported rather than dropped or fatal.
 *
 * Skipped when no `python` is on PATH — detected with Golem's own `commandOnPath`,
 * which is `PATHEXT`-aware, so this dogfoods the registry's detector too.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { commandOnPath } from "../../src/ext/detect.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SELFTEST = path.join(REPO_ROOT, "tests", "fixtures", "headroom-worker-selftest.py");
const WORKER = path.join(REPO_ROOT, "src", "compression", "headroom-worker.py");

const PYTHON = commandOnPath("python") ?? commandOnPath("python3");

interface SelfTestResult {
  readonly supported: readonly string[];
  readonly applied: readonly string[];
  readonly ignored: readonly string[];
  readonly kompress_model: string | null;
  readonly preset_protect_recent: number;
  readonly override_protect_recent: number;
  readonly aggressive_protect_recent: number;
  readonly aggressive_compress_user_messages: boolean;
  readonly unknown_mode_protect_recent: number;
  readonly bad_value_protect_recent: number;
  readonly bad_value_reported: boolean;
  readonly bad_value_applied: readonly string[];
  readonly non_dict_protect_recent: number;
  readonly non_dict_ignored: readonly string[];
}

describe.runIf(PYTHON !== null)("headroom-worker.py config passthrough (Decision 53)", () => {
  let result: SelfTestResult;

  // One subprocess for the whole file: the script is pure and prints everything.
  it("runs the worker's config builder against a stub headroom", async () => {
    // Argument array, never a shell string (CLAUDE.md cross-platform rule).
    const { stdout } = await execFileAsync(PYTHON as string, [SELFTEST, WORKER], {
      cwd: REPO_ROOT,
      timeout: 30_000,
    });
    result = JSON.parse(stdout.trim()) as SelfTestResult;
    expect(result.supported).toEqual([
      "compress_user_messages",
      "kompress_model",
      "protect_recent",
    ]);
  });

  it("introspects the installed CompressConfig rather than a hardcoded list", () => {
    // `kompress_model` appears nowhere in Golem's own code as a known option — it
    // is discoverable only because the worker reads the real signature.
    expect(result.supported).toContain("kompress_model");
  });

  it("forwards an option Golem has never heard of", () => {
    expect(result.applied).toContain("kompress_model");
    expect(result.kompress_model).toBe("m");
  });

  it("reports an unsupported key instead of forwarding or silently dropping it", () => {
    expect(result.ignored).toEqual(["not_a_real_option"]);
  });

  it("layers overrides over the mode preset, per key", () => {
    expect(result.preset_protect_recent).toBe(4); // preset survives untouched keys
    expect(result.override_protect_recent).toBe(1); // and yields to an override
  });

  it("keeps the mode presets themselves working", () => {
    expect(result.aggressive_protect_recent).toBe(1);
    expect(result.aggressive_compress_user_messages).toBe(true);
  });

  it("falls back to the safe preset for an unknown mode", () => {
    expect(result.unknown_mode_protect_recent).toBe(4);
  });

  it("degrades a supported name with an unusable value to the preset, and says so", () => {
    expect(result.bad_value_protect_recent).toBe(4);
    expect(result.bad_value_reported).toBe(true);
    expect(result.bad_value_applied).toEqual(["protect_recent"]);
  });

  it("tolerates a non-object config from the untrusted HTTP surface", () => {
    expect(result.non_dict_protect_recent).toBe(4);
    expect(result.non_dict_ignored).toEqual([]);
  });
});
