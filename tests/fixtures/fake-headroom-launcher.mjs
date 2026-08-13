/**
 * Stand-in for `uv run` in the Headroom teardown tests (R10.3).
 *
 * The real launch chain is not one process: `uv run … python worker.py` puts a
 * launcher — and on Windows a second, trampoline Python — between Golem and the
 * process that actually serves. That is why the leak was as bad as it was: the
 * pid Node holds is an ancestor, killing it does not kill the worker, and on
 * Windows the ancestor had already exited, so there was nothing left to kill.
 *
 * This fixture reproduces exactly that shape: it spawns the real worker as a
 * GRANDCHILD with inherited stdio (so the grandchild holds a duplicate of the
 * same stdin pipe, as it does under uv) and then just waits. A teardown that
 * only reaches the direct child leaves the worker of this chain running.
 *
 * Usage: node fake-headroom-launcher.mjs <workerPath> [...workerArgs]
 */
import { spawn } from "node:child_process";

const [workerPath, ...args] = process.argv.slice(2);

const child = spawn(process.execPath, [workerPath, ...args], {
  stdio: "inherit",
});

child.on("exit", (code) => process.exit(code ?? 0));

// Stay alive while the worker runs; ignore stdin entirely (the launcher is NOT
// the one watching for EOF — the worker is, which is the point of the test).
setInterval(() => {}, 60_000);
