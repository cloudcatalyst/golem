import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Contract harness modules (tests/contract/*-contract.ts) are libraries,
    // not suites; they are pulled in by implementations' *.test.ts files.
  },
});
