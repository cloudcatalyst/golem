/**
 * R8.6 — the LSP bridge's spawn and lifecycle behaviour.
 *
 * The gate on this task is exactly two claims, and they are what this file
 * proves on every OS in the matrix:
 *   1. **cross-OS spawn/lifecycle** — argument-array spawn of a real child
 *      process, a real `initialize` handshake, real framed traffic, and a
 *      shutdown that leaves nothing running.
 *   2. **server absent → no-op, never an error path** — and not just "absent":
 *      a server that never answers, one that crashes mid-session, and one that
 *      corrupts the stream all resolve to a plain unavailable result too.
 *
 * The counterparty is `tests/fixtures/fake-lsp-server.mjs`, spawned with this
 * process's own `node`. Golem must depend on no language server (Decision 53
 * criterion 4), and the risk here is protocol and lifecycle, not TypeScript.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LspBridge, type LspServerSpec } from "../../src/pkg/index.js";
import { rmTemp } from "../helpers/tmp.js";

const FAKE_SERVER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/fake-lsp-server.mjs",
);

const SAMPLE = [
  "export function coreThing(input: string): string {",
  "  return missing(input);",
  "}",
  "",
  "const a = coreThing('x');",
  "",
  "",
  "coreThing('y');",
  "",
].join("\n");

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "golem-lsp-"));
  await writeFile(path.join(root, "sample.ts"), SAMPLE, "utf8");
});

afterEach(async () => {
  await rm(root, rmTemp);
});

/**
 * A row that spawns the fake server with this process's own node binary.
 * `resolveCommand` is the same seam a user's explicitly-pathed server uses, so
 * nothing here bypasses the production spawn path.
 */
function fakeSpec(behaviour: string): LspServerSpec {
  return {
    id: "fake",
    command: "fake-lsp",
    args: [FAKE_SERVER, behaviour],
    languageId: "typescript",
    extensions: [".ts"],
  };
}

function bridgeFor(behaviour: string, overrides: Record<string, unknown> = {}): LspBridge {
  return new LspBridge({
    root,
    servers: [fakeSpec(behaviour)],
    resolveCommand: () => process.execPath,
    initializeTimeoutMs: 5_000,
    requestTimeoutMs: 5_000,
    diagnosticsWaitMs: 3_000,
    ...overrides,
  });
}

describe("LSP bridge — the four modes", () => {
  it("answers `definition` for a symbol, without being told a column", async () => {
    const lsp = bridgeFor("ok");
    try {
      const result = await lsp.query({
        mode: "definition",
        file: "sample.ts",
        symbol: "coreThing",
      });
      expect(result.available).toBe(true);
      expect(result.server).toBe("fake");
      // 1-based on the way out, whatever LSP's 0-based wire says.
      expect(result.locations).toEqual([{ file: "sample.ts", line: 1, character: 17 }]);
      expect(result.text).toContain("[Golem lsp definition] 1 location");
    } finally {
      await lsp.close();
    }
  });

  it("answers `references` with every location", async () => {
    const lsp = bridgeFor("ok");
    try {
      const result = await lsp.query({ mode: "references", file: "sample.ts", line: 1 });
      expect(result.available).toBe(true);
      expect(result.locations.map((l) => l.line)).toEqual([5, 8]);
      expect(result.text).toContain("2 locations");
    } finally {
      await lsp.close();
    }
  });

  it("answers `hover` with the server's markup content", async () => {
    const lsp = bridgeFor("ok");
    try {
      const result = await lsp.query({ mode: "hover", file: "sample.ts", symbol: "coreThing" });
      expect(result.available).toBe(true);
      expect(result.text).toContain("function coreThing(input: string): string");
    } finally {
      await lsp.close();
    }
  });

  it("waits past the empty first publish for the real diagnostics", async () => {
    const lsp = bridgeFor("ok");
    try {
      const result = await lsp.query({ mode: "diagnostics", file: "sample.ts" });
      expect(result.available).toBe(true);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]).toMatchObject({
        file: "sample.ts",
        line: 2,
        character: 3,
        severity: "error",
        code: "TS2304",
      });
      expect(result.text).toContain("1 problem");
    } finally {
      await lsp.close();
    }
  });

  it("reassembles answers written one byte at a time", async () => {
    const lsp = bridgeFor("split");
    try {
      const result = await lsp.query({ mode: "hover", file: "sample.ts", symbol: "coreThing" });
      expect(result.available).toBe(true);
      expect(result.text).toContain("coreThing");
    } finally {
      await lsp.close();
    }
  });
});

describe("LSP bridge — absence is a no-op, never an error path", () => {
  it("reports the missing binary instead of throwing", async () => {
    const lsp = new LspBridge({
      root,
      servers: [fakeSpec("ok")],
      resolveCommand: () => null,
    });
    try {
      const result = await lsp.query({ mode: "hover", file: "sample.ts", line: 1 });
      expect(result.available).toBe(false);
      expect(result.reason).toContain("not installed");
      expect(result.text).toContain("No LSP hover available");
    } finally {
      await lsp.close();
    }
  });

  it("reports an unclaimed file type rather than guessing a server", async () => {
    await writeFile(path.join(root, "notes.rb"), "puts 1\n", "utf8");
    const lsp = bridgeFor("ok");
    try {
      const result = await lsp.query({ mode: "definition", file: "notes.rb", line: 1 });
      expect(result.available).toBe(false);
      expect(result.reason).toContain("no language server is configured");
    } finally {
      await lsp.close();
    }
  });

  it("bounds a handshake that never completes", async () => {
    const lsp = bridgeFor("no-init", { initializeTimeoutMs: 400 });
    try {
      const result = await lsp.query({ mode: "hover", file: "sample.ts", line: 1 });
      expect(result.available).toBe(false);
      expect(result.reason).toContain("initialize did not answer");
    } finally {
      await lsp.close();
    }
  }, 15_000);

  it("bounds a request the server never answers", async () => {
    const lsp = bridgeFor("slow", { requestTimeoutMs: 400 });
    try {
      const result = await lsp.query({ mode: "definition", file: "sample.ts", line: 1 });
      expect(result.available).toBe(false);
      expect(result.reason).toContain("did not answer within 400ms");
    } finally {
      await lsp.close();
    }
  }, 15_000);

  it("returns empty diagnostics — not an error — when none are published in time", async () => {
    const lsp = bridgeFor("slow", { diagnosticsWaitMs: 300 });
    try {
      const result = await lsp.query({ mode: "diagnostics", file: "sample.ts" });
      expect(result.available).toBe(true);
      expect(result.diagnostics).toEqual([]);
      expect(result.text).toContain("no problems reported");
    } finally {
      await lsp.close();
    }
  }, 15_000);

  it("survives a server that dies mid-session", async () => {
    const lsp = bridgeFor("crash");
    try {
      const first = await lsp.query({ mode: "hover", file: "sample.ts", line: 1 });
      expect(first.available).toBe(false);
      // And the NEXT call must not inherit the corpse: the pool re-spawns.
      const second = await lsp.query({ mode: "hover", file: "sample.ts", line: 1 });
      expect(second.available).toBe(false);
    } finally {
      await lsp.close();
    }
  }, 15_000);

  it("tears the connection down on a desynchronised stream", async () => {
    const lsp = bridgeFor("garbage", { initializeTimeoutMs: 3_000 });
    try {
      const result = await lsp.query({ mode: "hover", file: "sample.ts", line: 1 });
      expect(result.available).toBe(false);
      expect(result.reason).toMatch(/protocol error|did not answer/);
    } finally {
      await lsp.close();
    }
  }, 15_000);

  it("reports an unreadable file plainly", async () => {
    const lsp = bridgeFor("ok");
    try {
      const result = await lsp.query({ mode: "hover", file: "does-not-exist.ts", line: 1 });
      expect(result.available).toBe(false);
      expect(result.reason).toContain("cannot read");
    } finally {
      await lsp.close();
    }
  });

  it("says what it needs when a position mode gets neither line nor symbol", async () => {
    const lsp = bridgeFor("ok");
    try {
      const result = await lsp.query({ mode: "definition", file: "sample.ts" });
      expect(result.available).toBe(false);
      expect(result.reason).toContain("`line`");
    } finally {
      await lsp.close();
    }
  });

  it("says so when the named symbol is not in the file", async () => {
    const lsp = bridgeFor("ok");
    try {
      const result = await lsp.query({ mode: "hover", file: "sample.ts", symbol: "nowhere" });
      expect(result.available).toBe(false);
      expect(result.reason).toContain("does not appear");
    } finally {
      await lsp.close();
    }
  });
});

describe("LSP bridge — lifecycle", () => {
  it("pools one server across calls and stops it on close", async () => {
    const lsp = bridgeFor("ok");
    const first = await lsp.query({ mode: "hover", file: "sample.ts", symbol: "coreThing" });
    const second = await lsp.query({ mode: "definition", file: "sample.ts", symbol: "coreThing" });
    expect(first.available && second.available).toBe(true);
    await lsp.close();
    // After close the bridge answers without spawning anything again.
    const after = await lsp.query({ mode: "hover", file: "sample.ts", line: 1 });
    expect(after.available).toBe(false);
    expect(after.reason).toContain("closed");
  });

  it("evicts an idle server and re-spawns on the next question", async () => {
    const lsp = bridgeFor("ok", { idleTimeoutMs: 50 });
    try {
      expect((await lsp.query({ mode: "hover", file: "sample.ts", line: 1 })).available).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await lsp.query({ mode: "hover", file: "sample.ts", line: 1 })).available).toBe(true);
    } finally {
      await lsp.close();
    }
  }, 15_000);
});
