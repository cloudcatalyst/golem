/**
 * R10.11 — the VS Code extension's `status --json` reads are a real contract.
 *
 * `vscode-extension/render.js` consumes `golem status --json` as an untyped blob.
 * Nothing connected the field names it reads to the ones `collectStatus` emits, so
 * a CLI rename was invisible until a human noticed a wrong label in the status
 * bar. That happened three times in four releases, and each drift shipped:
 *
 * - `local_model.coder_model` — a name the CLI never had (it is `local_model.model`),
 *   so the status bar showed a bare "local" instead of the model id.
 * - `local_model.coder_enabled` — deleted by R9.23; the extension still gated on it.
 * - `accounts` — renamed to `gateways` by R9.23; the picker went empty.
 *
 * This test closes that hole at the source: `render.js` declares every path it
 * reads (`STATUS_FIELDS_READ`), and each is resolved against a report from the
 * REAL `collectStatus`. A rename now fails here, in the CLI's own suite, rather
 * than in a user's status bar.
 *
 * It deliberately asserts the negative cases too. A `legacy` path that started
 * being emitted, or an `unemitted` gap that got closed, both mean the declaration
 * is now lying — and a stale contract is worse than none.
 */

import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { golemInit } from "../../src/cli/init.js";
import { collectStatus, type StatusReport } from "../../src/cli/status.js";
import { useTempDirs } from "../helpers/tmp.js";

/** `render.js` is CommonJS, shipped without a build step — require it as-is. */
const require_ = createRequire(import.meta.url);
const render = require_("../../vscode-extension/render.js") as {
  STATUS_FIELDS_READ: readonly StatusFieldDecl[];
};

interface StatusFieldDecl {
  readonly path: readonly string[];
  /** Always emitted. */
  readonly required?: true;
  /** Emitted only in the named state. */
  readonly stateful?: string;
  /** Read for an older CLI only; the current one must NOT emit it. */
  readonly legacy?: string;
  /** Read here but emitted by nothing; names the task that owns the gap. */
  readonly unemitted?: string;
}

const newTempDir = useTempDirs("golem-vscode-fields");
const VERSION = "0.1.0-test";

/** init requires a Claude Code marker + no headroom wrap; inject a passing probe. */
const passingProbe = {
  claudeCodeInstalled: () => Promise.resolve(true),
  headroomWrapActive: () => Promise.resolve(false),
};

/** Resolve a declared key path, or `undefined` if any hop is missing. */
function resolvePath(root: unknown, path: readonly string[]): unknown {
  let cursor: unknown = root;
  for (const key of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

const label = (path: readonly string[]) => path.join(".");

describe("vscode-extension status --json field contract", () => {
  let report: StatusReport;

  beforeAll(async () => {
    const root = await newTempDir();
    const projectDir = join(root, "project");
    const userDir = join(root, "user");
    await mkdir(projectDir, { recursive: true });
    await mkdir(userDir, { recursive: true });
    await golemInit({ projectDir, probe: passingProbe });

    report = await collectStatus({
      projectDir,
      version: VERSION,
      userDir,
      probeTimeoutMs: 200,
      // A reachable local runtime, so `local_model.model` is populated without
      // needing an Ollama on the test machine. This is the injection point
      // collectStatus already exposes for exactly this.
      localProbe: () => Promise.resolve({ reachable: true, coderModel: "qwen2.5-coder:7b" }),
      // No VS Code on a CI box, and this test is not about the staleness check.
      vscodeExtensionsDir: null,
    });
    // 60s: this does a real `golemInit` (~20 file writes) plus a full
    // `collectStatus`. It takes ~1s alone, but vitest's `hookTimeout` is 10s and is
    // NOT covered by the 20s `testTimeout` in vitest.config.ts — under full parallel
    // load on Windows that is the R10.2 contention class, and it timed out here.
  }, 60_000);

  /**
   * The premise. If the declaration were empty every other assertion below would
   * pass by vacuity — the same way the suite this task fixed was "green" by never
   * being run.
   */
  it("declares the fields it reads", () => {
    expect(render.STATUS_FIELDS_READ.length).toBeGreaterThan(15);
    for (const decl of render.STATUS_FIELDS_READ) {
      expect(
        decl.path.length,
        `${label(decl.path)}: path must be a non-empty key array`,
      ).toBeGreaterThan(0);
      // Exactly one classification, or the assertions below disagree about it.
      const kinds = [decl.required, decl.stateful, decl.legacy, decl.unemitted].filter(
        (k) => k !== undefined,
      );
      expect(kinds, `${label(decl.path)}: needs exactly one classification`).toHaveLength(1);
    }
  });

  it("emits every field the extension requires", () => {
    for (const decl of render.STATUS_FIELDS_READ) {
      if (decl.required !== true) continue;
      expect(
        resolvePath(report, decl.path),
        `status --json is missing \`${label(decl.path)}\`, which vscode-extension/render.js reads. ` +
          "Either the CLI renamed/removed it (update render.js AND this declaration) or the " +
          "extension is reading a name that never existed.",
      ).not.toBeUndefined();
    }
  });

  it("emits the state-dependent fields once their state holds", () => {
    // The injected probe answered, so the local model's id must be there — this is
    // the exact field whose rotted name (`coder_model`) showed a bare "local".
    expect(resolvePath(report, ["local_model", "model"])).toBe("qwen2.5-coder:7b");
    expect(resolvePath(report, ["local_model", "reachable"])).toBe(true);

    // Every `stateful` path must at least be DECLARED against a real block, so a
    // renamed parent is caught even when the leaf is legitimately absent.
    for (const decl of render.STATUS_FIELDS_READ) {
      if (decl.stateful === undefined || decl.path.length < 2) continue;
      const parent = decl.path.slice(0, -1);
      const resolved = resolvePath(report, parent);
      if (resolved === undefined) continue; // the whole block is state-dependent too
      expect(typeof resolved, `${label(parent)} should be an object when present`).toBe("object");
    }
  });

  it("does not emit the legacy fields the extension only reads for an older CLI", () => {
    for (const decl of render.STATUS_FIELDS_READ) {
      if (decl.legacy === undefined) continue;
      expect(
        resolvePath(report, decl.path),
        `\`${label(decl.path)}\` is declared legacy in render.js (${decl.legacy}) but the CLI IS ` +
          "emitting it. Reclassify it — a back-compat branch quietly becoming the live path is " +
          "how the coder_model drift went unnoticed for four releases.",
      ).toBeUndefined();
    }
  });

  it("names the gaps: fields the extension reads that nothing emits", () => {
    for (const decl of render.STATUS_FIELDS_READ) {
      if (decl.unemitted === undefined) continue;
      expect(
        resolvePath(report, decl.path),
        `\`${label(decl.path)}\` is now emitted. The gap tracked by ${decl.unemitted} is closed — ` +
          "reclassify it in render.js's STATUS_FIELDS_READ (required or stateful) and drop the note.",
      ).toBeUndefined();
    }
  });
});
