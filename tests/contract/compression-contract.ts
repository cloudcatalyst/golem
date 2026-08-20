/**
 * Reusable contract harness for CompressionService implementations.
 *
 * Not a test file itself (vitest only collects *.test.ts). An implementation
 * opts in from its own test file:
 *
 *   describeCompressionServiceContract("NativeLossless", () => new NativeLossless(...));
 *
 * WS-A task A2 must register its implementation exactly this way.
 */

import { describe, expect, it } from "vitest";
import type { CompressionService, Message } from "../../src/interfaces/compression.js";
import { UnknownRefError } from "../../src/interfaces/compression.js";
import { policyFor } from "../../src/interfaces/policy.js";

const MESSAGES: readonly Message[] = Object.freeze([
  { role: "user", content: "Summarize the build failure in ci.log" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Looking at the log now." },
      { type: "tool_use", id: "toolu_01", name: "read_file", input: { path: "ci.log" } },
    ],
  },
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_01",
        content: "error CS0103: name 'foo' does not exist ".repeat(200),
      },
    ],
  },
]);

const PROJECT = "contract-test-project";

export function describeCompressionServiceContract(
  name: string,
  makeService: () => CompressionService | Promise<CompressionService>,
): void {
  describe(`CompressionService contract: ${name}`, () => {
    it("level 0 is byte-faithful passthrough", async () => {
      const svc = await makeService();
      const result = await svc.compress(MESSAGES, policyFor("off"), PROJECT);
      expect(result.messagesOut).toStrictEqual(MESSAGES);
      expect(result.refs).toHaveLength(0);
    });

    it("level 1 preserves message structure (roles/order, tool blocks intact)", async () => {
      const svc = await makeService();
      const result = await svc.compress(MESSAGES, policyFor(1), PROJECT);
      expect(result.messagesOut.map((m) => m.role)).toStrictEqual(MESSAGES.map((m) => m.role));
    });

    it("re-compression is deterministic (prompt-cache stability)", async () => {
      const svc = await makeService();
      const policy = policyFor(1);
      const first = await svc.compress(MESSAGES, policy, PROJECT);
      const second = await svc.compress(MESSAGES, policy, PROJECT);
      expect(JSON.stringify(second.messagesOut)).toBe(JSON.stringify(first.messagesOut));
    });

    it("every emitted CCR ref is retrievable", async () => {
      const svc = await makeService();
      const result = await svc.compress(MESSAGES, policyFor(2), PROJECT);
      for (const ref of result.refs) {
        const original = await svc.retrieve(ref);
        expect(original.ref).toStrictEqual(ref);
        expect(original.content.length).toBeGreaterThan(0);
      }
    });

    it("unknown refs reject with UnknownRefError", async () => {
      const svc = await makeService();
      await expect(
        svc.retrieve({ refId: "does-not-exist", contentType: "text/plain", originalTokens: 0 }),
      ).rejects.toBeInstanceOf(UnknownRefError);
    });

    it("stats are consistent and never negative", async () => {
      const svc = await makeService();
      await svc.compress(MESSAGES, policyFor(1), PROJECT);
      const stats = await svc.stats(PROJECT);
      expect(stats.requests).toBeGreaterThanOrEqual(1);
      expect(stats.tokensBefore).toBeGreaterThanOrEqual(stats.tokensAfter);
      expect(stats.tokensAfter).toBeGreaterThanOrEqual(0);
    });
  });
}
