/**
 * Task `hook-precedence` (verification-notes §91, §96) — PROVE, against a real
 * Claude Code, that a `deny` from one PreToolUse hook still blocks the tool call
 * when a second hook on the same call returns `updatedInput` to rewrite it.
 *
 * ## Why this exists as a live test and not a unit test
 * The behaviour is Claude Code's, not Golem's. Golem's PreToolUse hook is
 * registered with **no matcher** (`src/cli/init.ts`), so it fires on every Bash
 * call; anyone who also installs a wrapper that rewrites Bash input (RTK does)
 * exercises this interaction. §96 already found one real consequence of the same
 * coexistence — a rewrite made Golem's start-anchored allow-list miss `rtk vitest`
 * — and that one was fail-closed. This is the other half: the case where Golem
 * needs its **deny** to win. A mock cannot answer it; only the real client can.
 *
 * ## What the docs say now (checked 2026-07-31, code.claude.com/docs/en/hooks)
 * The reference has since gained the sentence §91 could not find:
 * *"When multiple PreToolUse hooks return different decisions, precedence is
 * deny > defer > ask > allow."* — plus, on `permissionDecision`, *"Deny and ask
 * rules are still evaluated regardless of what the hook returns"*.
 *
 * That covers conflicting *decisions*. It does **not** state what happens when the
 * other hook returns no decision at all and only `updatedInput` — which is exactly
 * the RTK shape. §91's standing instruction was "assert it; do not trust it", so
 * this asserts it.
 *
 * ## Opt-in: this spends a model turn
 * Skipped unless `GOLEM_LIVE_CLAUDE=1`. It shells out to the real `claude -p`, so
 * it needs a logged-in CLI and consumes quota. Run it deliberately:
 *
 *     GOLEM_LIVE_CLAUDE=1 npx vitest run tests/e2e/hook-precedence.live.test.ts
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const LIVE = process.env.GOLEM_LIVE_CLAUDE === "1";

/** POSIX-style path, safe to embed in a JS string literal on Windows too. */
const posix = (p: string): string => p.split(path.sep).join("/");

interface Fixture {
  readonly dir: string;
  /** Both hooks append a line here, so we can see which of them actually fired. */
  readonly log: string;
  /** Written ONLY if the rewritten command executes — i.e. if the deny lost. */
  readonly marker: string;
}

/**
 * A temp project wired with two competing PreToolUse hooks on the same Bash call:
 *
 * - `rewrite.mjs` — no `permissionDecision` at all, just `updatedInput` that
 *   replaces the command with one that touches {@link Fixture.marker}. This is
 *   RTK's shape: transform the input, express no opinion on permission.
 * - `deny.mjs` — `permissionDecision: "deny"`. This is Golem's shape (snooze
 *   enforcement, coder-first, the autonomy gate).
 *
 * Both are `matcher: "Bash"`, both in project settings, so they run in parallel on
 * one call and disagree. The marker file is the ground truth: if it exists, the
 * rewritten command ran and the deny was NOT honoured.
 */
async function setup(): Promise<Fixture> {
  const dir = await mkdtemp(path.join(tmpdir(), "golem-hookprec-"));
  const log = path.join(dir, "hooks.log");
  const marker = path.join(dir, "REWRITTEN-COMMAND-RAN.txt");
  const hooksDir = path.join(dir, "hooks");
  await writeFile(path.join(dir, "note.txt"), "hello\n", "utf8");

  const { mkdir } = await import("node:fs/promises");
  await mkdir(hooksDir, { recursive: true });

  const readStdin = `
let raw = "";
process.stdin.setEncoding("utf8");
for await (const c of process.stdin) raw += c;
const payload = JSON.parse(raw || "{}");
const fs = require("node:fs");
`;

  // Rewrites the Bash command and says nothing about permission.
  await writeFile(
    path.join(hooksDir, "rewrite.mjs"),
    `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
${readStdin}
fs.appendFileSync("${posix(log)}", "rewrite fired: " + JSON.stringify(payload.tool_input) + "\\n");
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    updatedInput: {
      ...payload.tool_input,
      command: "node -e \\"require('fs').writeFileSync('${posix(marker)}','the rewritten command ran')\\"",
    },
  },
}));
`,
    "utf8",
  );

  // Denies the same call.
  await writeFile(
    path.join(hooksDir, "deny.mjs"),
    `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
${readStdin}
fs.appendFileSync("${posix(log)}", "deny fired\\n");
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "GOLEM-STYLE-DENY: this Bash call is blocked by policy.",
  },
}));
`,
    "utf8",
  );

  const hookEntry = (script: string) => ({
    type: "command" as const,
    command: `node "${posix(path.join(hooksDir, script))}"`,
  });
  await mkdir(path.join(dir, ".claude"), { recursive: true });
  await writeFile(
    path.join(dir, ".claude", "settings.json"),
    `${JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [hookEntry("rewrite.mjs"), hookEntry("deny.mjs")] },
          ],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { dir, log, marker };
}

/** Run `claude -p` in `dir` and return its combined output. */
function runClaude(dir: string, prompt: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("claude", ["-p", prompt], {
      cwd: dir,
      shell: process.platform === "win32", // `claude` is a .cmd shim on Windows
      env: { ...process.env },
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      out += c;
    });
    child.stderr.on("data", (c: string) => {
      out += c;
    });
    child.on("close", (code) => resolve({ code, out }));
    child.on("error", (err) => resolve({ code: null, out: `${out}\nspawn error: ${err.message}` }));
  });
}

describe.skipIf(!LIVE)("PreToolUse precedence: a rewriting hook vs a denying hook (live)", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await setup();
  });
  afterEach(async () => {
    await rm(fx.dir, { recursive: true, force: true });
  });

  it("honours the deny — the rewritten command never runs", async () => {
    const { out } = await runClaude(
      fx.dir,
      "Run exactly this shell command with the Bash tool, once: `cat note.txt`. " +
        "If it is blocked, say BLOCKED and stop — do not retry and do not use any other tool.",
    );

    const log = existsSync(fx.log) ? await readFile(fx.log, "utf8") : "";

    // Guard against a vacuous pass: if Claude never attempted Bash, neither hook
    // ran and the assertion below would prove nothing.
    expect(log, `no PreToolUse hook fired — Claude never attempted Bash.\n${out}`).toContain(
      "deny fired",
    );
    // Both hooks must have been consulted; they run in parallel on the same call.
    expect(log).toContain("rewrite fired");

    // THE ASSERTION. deny wins: the rewritten command was never executed.
    expect(
      existsSync(fx.marker),
      `the rewritten command RAN despite a deny from another hook — ` +
        `Golem's deny paths (snooze enforcement, coder-first, the autonomy gate) ` +
        `cannot be relied on alongside a rewriting hook.\n${out}`,
    ).toBe(false);
  }, 180_000);
});
