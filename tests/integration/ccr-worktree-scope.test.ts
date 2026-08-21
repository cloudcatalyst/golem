/**
 * ccr-ref-scope (docs/plan/tasks/ccr-ref-scope.md): a ref stored by the
 * PostToolUse hook while running inside a git LINKED WORKTREE must be
 * retrievable by `expand`'s code path from the worktree's MAIN checkout.
 *
 * This is the seam that broke: the hook resolves its CCR root from `cwd`
 * (`src/hooks/post-tool-use.ts`), and `expand` is served by whichever
 * `NativeLosslessCompression` the MCP server/proxy was built with
 * (`NativeLosslessCompression.forProjectDir`, `src/compression/native-lossless.ts`).
 * A subagent's hook runs with `cwd` inside `.claude/worktrees/agent-<id>/`
 * while the main session's `expand` is rooted at the main checkout — same
 * refId, two different `.golem/ccr` directories, so the ref that was "stored
 * losslessly" per the digest marker reads back as unknown.
 *
 * Reproduced 2026-08-22 against an agent report of exactly this happening on
 * three WebFetch refs, minutes after they were issued (not an eviction —
 * neither CcrStore nor LocalDirBlobStore implements one; see
 * verification-notes.md and docs/wiki/concepts/CCR Ref Scope.md).
 */

import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CCR_MARKER_RE, NativeLosslessCompression } from "../../src/compression/index.js";
import { runPostToolUseHook, type HookIo } from "../../src/hooks/index.js";
import { useTempDirs } from "../helpers/tmp.js";

const newTempDir = useTempDirs("golem-ccr-worktree-");

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", [...args], { cwd, stdio: "pipe" });
}

/** A HookIo backed by a fixed input string and capture buffers. */
function fakeIo(input: string): HookIo & { out: string[] } {
  const out: string[] = [];
  return {
    stdin: (async function* () {
      yield input;
    })(),
    stdout: { write: (t: string) => out.push(t) },
    stderr: { write: () => {} },
    out,
  };
}

interface UpdatedOutputEnvelope {
  hookSpecificOutput: { hookEventName: string; updatedToolOutput: unknown };
}

/**
 * Set up a real main checkout + a real linked worktree (`git worktree add`),
 * so the resolution under test sees the exact on-disk shape git itself
 * produces — a `.git` FILE in the worktree pointing at
 * `<main>/.git/worktrees/<name>`, whose `commondir` file points back at the
 * shared `.git` — rather than a hand-rolled approximation of it.
 */
async function makeMainAndWorktree(): Promise<{ mainRoot: string; worktreeRoot: string }> {
  const mainRoot = await newTempDir();
  git(mainRoot, ["init", "-q", "-b", "main"]);
  git(mainRoot, ["config", "user.email", "golem-test@example.com"]);
  git(mainRoot, ["config", "user.name", "Golem Test"]);
  await writeFile(path.join(mainRoot, "README.md"), "root\n");
  git(mainRoot, ["add", "-A"]);
  git(mainRoot, ["commit", "-q", "-m", "init"]);

  const worktreeParent = await newTempDir();
  const worktreeRoot = path.join(worktreeParent, "agent-worktree");
  git(mainRoot, ["worktree", "add", "-q", "-b", "agent-branch", worktreeRoot]);

  return { mainRoot, worktreeRoot };
}

describe("CCR ref scope across a git worktree", () => {
  it(
    "a ref the hook stores while running inside a linked worktree is retrievable " +
      "from the main checkout's compression service (expand's code path)",
    async () => {
      const { mainRoot, worktreeRoot } = await makeMainAndWorktree();

      // The hook runs with cwd = the worktree, exactly as it does for a
      // Task-tool subagent under `isolation: "worktree"`.
      const big = "LINE-of-tool-output\n".repeat(2_000); // ~40k chars, over threshold
      const io = fakeIo(
        JSON.stringify({
          session_id: "s1",
          cwd: worktreeRoot,
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: "echo hi" },
          tool_response: big,
        }),
      );
      const code = await runPostToolUseHook(io, { projectDir: worktreeRoot });
      expect(code).toBe(0);
      expect(io.out).toHaveLength(1);
      const env = JSON.parse(io.out[0] as string) as UpdatedOutputEnvelope;
      const digest = env.hookSpecificOutput.updatedToolOutput as string;
      const match = CCR_MARKER_RE.exec(digest);
      expect(match).not.toBeNull();
      const refId = (match as RegExpExecArray)[1] as string;

      // This is `expand`'s code path for the MAIN session: a
      // NativeLosslessCompression rooted at the MAIN checkout, never the
      // worktree the hook actually ran in.
      const mainService = NativeLosslessCompression.forProjectDir(mainRoot);
      const original = await mainService.retrieve({
        refId,
        contentType: "text/plain",
        originalTokens: 0,
      });
      expect(original.content).toBe(big);
    },
  );
});
