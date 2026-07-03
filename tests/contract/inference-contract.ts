/**
 * Reusable contract harness for InferenceService implementations (WS-D D2/D3).
 *
 * Implementations may back the harness with a fake OpenAI-compatible server —
 * the contract is about interface behavior, not model quality.
 */

import { describe, expect, it } from "vitest";
import type { InferenceService } from "../../src/interfaces/inference.js";
import { ALL_ROLES } from "../../src/interfaces/inference.js";

export function describeInferenceServiceContract(
  name: string,
  makeService: () => InferenceService | Promise<InferenceService>,
): void {
  describe(`InferenceService contract: ${name}`, () => {
    it("capabilities() returns a hardware tier", async () => {
      const svc = await makeService();
      expect([0, 1, 2, 3]).toContain(svc.capabilities());
    });

    it("chat() serves every role", async () => {
      const svc = await makeService();
      for (const role of ALL_ROLES) {
        const result = await svc.chat(role, [{ role: "user", content: "ping" }]);
        expect(result.role).toBe(role);
        expect(typeof result.text).toBe("string");
      }
    });

    it("embed() returns one fixed-dimension vector per input", async () => {
      const svc = await makeService();
      const texts = ["alpha", "beta", "gamma"];
      const vectors = await svc.embed(texts, "text");
      expect(vectors).toHaveLength(texts.length);
      const dims = new Set(vectors.map((v) => v.length));
      expect(dims.size).toBe(1);
      expect(dims.has(0)).toBe(false);
    });
  });
}
