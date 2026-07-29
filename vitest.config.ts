import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Contract harness modules (tests/contract/*-contract.ts) are libraries,
    // not suites; they are pulled in by implementations' *.test.ts files.

    // 20s, not vitest's 5s default. This suite is genuinely I/O-heavy: the
    // integration and e2e tests run real `golemInit`/`golemUninit` (~20 file writes
    // each), spawn proxy daemons, and wait on ports. On Windows, with files running
    // in parallel and a virus scanner in the path, several legitimately exceed 5s —
    // which showed up as tests timing out intermittently, on a different one each
    // run (verification-notes §86c). The work is real, so the budget was wrong.
    //
    // A hung test still fails, just 20s later; that is a good trade in a suite whose
    // whole run is ~30s. Anything that needs longer sets its own timeout locally.
    testTimeout: 20_000,
  },
});
