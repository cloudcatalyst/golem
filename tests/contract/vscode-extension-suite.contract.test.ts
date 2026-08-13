/**
 * R10.11 — the VS Code extension's own test suite runs in the standard command.
 *
 * `vscode-extension/render.test.js` is a real, thorough suite that **nothing
 * executed**: `vitest.config.ts` includes only `tests/**\/*.test.ts`, so
 * `npm test` never saw it (it is `.js`, and outside `tests/`), and CI runs the
 * same vitest command. It was reachable only by `node --test
 * vscode-extension/render.test.js` — an incantation nobody has to know — and it
 * sat 4 tests red on `main` for four releases while the extension drifted behind
 * the CLI three separate times, every symptom user-visible.
 *
 * So this file is the actual fix: it makes `npm test` (and therefore CI) run that
 * suite, and a contributor who runs "the tests" cannot miss it.
 *
 * ## Why a spawn rather than converting the file to vitest
 *
 * `render.js` and `render.test.js` are plain CommonJS on purpose — the extension
 * ships to the Marketplace with no build step and no devDependencies, so
 * importing `vitest` into the shipped tree would be the wrong direction. Spawning
 * `node --test` keeps the extension self-contained AND keeps
 * `node --test vscode-extension/render.test.js` working for anyone debugging it
 * directly.
 *
 * It DISCOVERS the suites rather than naming one, so a second `*.test.js` added
 * beside `render.test.js` is covered the day it lands rather than the day someone
 * remembers to list it. Discovery is a `readdir` and not `node --test
 * vscode-extension/`: handed a directory, Node resolves it through that
 * directory's `package.json` `main` and tries to run `extension.js` as a test —
 * which fails on `require("vscode")`, since that module only exists inside the
 * editor.
 */

import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionDir = path.join(repoRoot, "vscode-extension");

/** Every `*.test.js` beside the extension source, so a new one needs no edit here. */
function extensionSuites(): string[] {
  return readdirSync(extensionDir)
    .filter((f) => f.endsWith(".test.js"))
    .map((f) => path.join(extensionDir, f));
}

describe("vscode-extension test suite", () => {
  /**
   * The premise: there IS something to run. A suite that silently stops existing
   * would otherwise make this file pass by vacuity — the same failure mode as the
   * suite that nothing ran.
   */
  it("has at least one test file to run", () => {
    expect(extensionSuites().map((f) => path.basename(f))).toContain("render.test.js");
  });

  it("passes under `node --test`", async () => {
    // 60s: it is pure-logic CommonJS with no I/O, so it finishes in well under a
    // second — but a cold Node start on a loaded Windows box with a virus scanner
    // in the path is not something to race (R10.2).
    const suites = extensionSuites();
    let stdout = "";
    let stderr = "";
    let failed: unknown = null;
    try {
      // TAP, not the default reporter: the default switches format depending on
      // whether stdout is a TTY, so the counts asserted below would be there
      // interactively and absent under CI. TAP is stable either way.
      const result = await run(process.execPath, ["--test", "--test-reporter=tap", ...suites], {
        cwd: repoRoot,
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      failed = error;
      const e = error as { stdout?: string; stderr?: string };
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? "";
    }

    // Surface the child's own report on failure. Without this the only signal is
    // a non-zero exit code, which tells a contributor nothing about WHICH
    // extension assertion broke — and an unreadable failure is how a suite ends
    // up ignored in the first place.
    expect(failed, `node --test ${suites.join(" ")} failed:\n${stdout}\n${stderr}`).toBeNull();
    expect(stdout).toMatch(/^# fail 0$/m);
    // `# pass 0` is a green run that asserted nothing — treat it as a failure.
    expect(stdout).not.toMatch(/^# pass 0$/m);
  });
});
