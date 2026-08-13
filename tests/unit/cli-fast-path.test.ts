/**
 * The commander-free fast path for the commands Claude Code invokes constantly.
 *
 * Two things are guarded here, because both failure modes are silent:
 *
 * 1. **Routing is exact.** `fastPathFor` must return null for anything it doesn't
 *    handle identically — `--help`, unknown events, unexpected flags — so
 *    commander stays authoritative for output and error messages.
 * 2. **The boundary holds.** The fast path is only safe for handlers that take no
 *    CLI-injected dependencies. If `program.ts` ever starts injecting a
 *    `PostToolUseOptions` field, the fast path would quietly drop it, so that call
 *    site is asserted here.
 *
 * Behavioural equivalence itself was verified by running both paths over the same
 * payloads (including a forced CCR-ref swap) and diffing stdout + exit codes; see
 * verification-notes §86.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FAST_HOOK_EVENTS, fastPathFor } from "../../src/cli/fast-path.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = (rel: string) => readFile(path.join(repoRoot, rel), "utf8");
const argv = (...args: string[]) => ["node", "/x/dist/cli/main.js", ...args];

describe("fastPathFor", () => {
  it("claims the hook events it implements", () => {
    for (const event of FAST_HOOK_EVENTS) {
      expect(fastPathFor(argv("hook", event)), event).toBe("hook");
    }
  });

  it("claims statusline, with or without --color", () => {
    expect(fastPathFor(argv("statusline"))).toBe("statusline");
  });

  // R10.10: the VS Code extension polls `status --json` on a timer, and routing
  // it through commander cost ~1.6s of module graph per poll for a JSON dump
  // that never touches the command registry.
  it("routes the machine-readable `status --json` shapes the extension sends", () => {
    expect(fastPathFor(argv("status", "--json"))).toBe("status");
    expect(fastPathFor(argv("status", "--json", "--dir", "C:/p"))).toBe("status");
    expect(fastPathFor(argv("status", "--dir", "C:/p", "--json"))).toBe("status");
  });

  it("leaves the HUMAN `golem status` to commander — its renderer is commander's business", () => {
    expect(fastPathFor(argv("status"))).toBeNull();
    expect(fastPathFor(argv("status", "--dir", "C:/p"))).toBeNull();
  });

  it("refuses a status shape it does not handle identically", () => {
    // An unknown flag must reach commander so ITS error message is the one the
    // user sees — a fast path that silently ignores a flag is worse than one
    // that never runs.
    expect(fastPathFor(argv("status", "--json", "--verbose"))).toBeNull();
    expect(fastPathFor(argv("status", "--json", "--help"))).toBeNull();
    // `--dir` takes a value; a dangling flag is commander's to complain about.
    expect(fastPathFor(argv("status", "--json", "--dir"))).toBeNull();
    expect(fastPathFor(argv("status", "--json", "--dir", "--json"))).toBeNull();
  });

  it("does NOT fast-path `stats --json`, even though it is the slower call", () => {
    // Deliberate: stats' plain path branches on telemetry aggregation and a
    // hasRequests fallback, and duplicating that is exactly the drift the
    // "behaviourally identical" rule exists to prevent. A null `stats` blanks a
    // savings figure; a null `status` is what renders the bar OFFLINE.
    expect(fastPathFor(argv("stats", "--json"))).toBeNull();
    expect(fastPathFor(argv("stats", "--json", "--window", "24h"))).toBeNull();
    expect(fastPathFor(argv("statusline", "--color"))).toBe("statusline");
  });

  it("claims post-tool-use with its one flag", () => {
    expect(fastPathFor(argv("hook", "post-tool-use", "--max-inline-chars", "800"))).toBe("hook");
  });

  it("declines hook events whose handlers need CLI-injected dependencies", () => {
    // web-fetch-* need buildKnowledge / fetchRaw / revalidate; session-start drives
    // the proxy daemon. They must reach commander, where that wiring exists.
    for (const event of ["web-fetch-pre", "web-fetch-post", "session-start"]) {
      expect(fastPathFor(argv("hook", event)), event).toBeNull();
    }
  });

  it("declines anything it does not handle exactly", () => {
    for (const args of [
      [], // bare golem — the panel/help decision, made before this
      ["hook"], // no event → commander prints its help
      ["hook", "nope"],
      ["hook", "pre-tool-use", "--surprise"],
      ["hook", "post-tool-use", "--max-inline-chars"], // missing value
      ["hook", "post-tool-use", "--max-inline-chars", "8", "--extra"],
      ["statusline", "--json"],
      ["status"],
      ["config", "list"],
    ]) {
      expect(fastPathFor(argv(...args)), JSON.stringify(args)).toBeNull();
    }
  });

  it("always defers --help and -h to commander", () => {
    expect(fastPathFor(argv("hook", "pre-tool-use", "--help"))).toBeNull();
    expect(fastPathFor(argv("statusline", "--help"))).toBeNull();
    expect(fastPathFor(argv("statusline", "-h"))).toBeNull();
  });
});

describe("the fast path's safety boundary", () => {
  it("only claims events that src/hooks/command.ts actually registers", async () => {
    const code = await source("src/hooks/command.ts");
    const registered = [...code.matchAll(/\.command\("([^"]+)"\)/g)].map((m) => m[1]);
    for (const event of FAST_HOOK_EVENTS) {
      expect(registered, event).toContain(event);
    }
  });

  it("is not undercut by a PostToolUseOptions injection in the hook command", async () => {
    // The fast path calls runPostToolUseHook with `{}` (plus --max-inline-chars),
    // which is only equivalent because buildHookCommand receives no
    // PostToolUseOptions field. If one is added, handle it in fast-path.ts too.
    // The buildHookCommand call lives in src/cli/commands/prompt-guidance.ts
    // (registered by program.ts).
    const code = await source("src/cli/commands/prompt-guidance.ts");
    const call = /buildHookCommand\(\{([\s\S]*?)\n\s*\}\)/.exec(code);
    expect(call, "buildHookCommand({...}) call not found in prompt-guidance.ts").not.toBeNull();
    const body = call?.[1] ?? "";
    for (const field of ["redact:", "maxInlineChars:", "projectDir:"]) {
      expect(
        body,
        `the hook command now injects ${field} — fast-path.ts must pass it too`,
      ).not.toContain(field);
    }
  });

  it("keeps its own module free of static imports", async () => {
    // Dispatching to one event must not load another's dependencies.
    const code = await source("src/cli/fast-path.ts");
    const statics = [...code.matchAll(/(^|\n)[ \t]*import[\s\S]*?from\s+["']([^"']+)["']/g)]
      .map((m) => m[2])
      .filter((s): s is string => s !== undefined);
    expect(statics).toEqual([]);
  });
});
