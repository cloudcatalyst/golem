import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // Contract harness modules (tests/contract/*-contract.ts) are libraries,
    // not suites; they are pulled in by implementations' *.test.ts files.
  },
});
