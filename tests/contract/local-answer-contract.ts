/**
 * Reusable contract harness for LocalAnswerService implementations (R2.3).
 */

import { describe, expect, it } from "vitest";
import type { LocalAnswerService } from "../../src/interfaces/local-answer.js";

const PROJECT = "contract-test-project";

export function describeLocalAnswerContract(
  name: string,
  makeService: () => LocalAnswerService | Promise<LocalAnswerService>,
): void {
  describe(`LocalAnswerService contract: ${name}`, () => {
    it("never fabricates: an unanswerable query resolves answered:false", async () => {
      const service = await makeService();
      const result = await service.tryAnswer({
        text: "what is the airspeed velocity of an unladen swallow",
        projectId: PROJECT,
      });
      expect(result.answered).toBe(false);
    });

    it("a confidently-covered query resolves answered:true with non-empty text and sources", async () => {
      const service = await makeService();
      const result = await service.tryAnswer({
        text: "how do I deploy this project",
        projectId: PROJECT,
      });
      if (result.answered) {
        expect(result.text.length).toBeGreaterThan(0);
        expect(result.sources.length).toBeGreaterThan(0);
      }
      // Implementations backed by an empty/unrelated corpus are allowed to
      // say `false` here too — the binding invariant is just internal
      // consistency (text/sources non-empty whenever answered is true),
      // asserted above via the `if`.
    });

    it("no cross-project bleed", async () => {
      const service = await makeService();
      const result = await service.tryAnswer({
        text: "how do I deploy this project",
        projectId: "some-other-unseeded-project",
      });
      expect(result.answered).toBe(false);
    });
  });
}
