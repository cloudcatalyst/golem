/**
 * Copy non-TS runtime assets into dist/ after `tsc` (which only emits .js/.d.ts).
 * Cross-platform (Node fs), so it works in the 3-OS CI matrix. Currently: the
 * Headroom sidecar worker (Python) that ships next to its compiled adapter.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const ASSETS = [["src/compression/headroom-worker.py", "dist/compression/headroom-worker.py"]];

for (const [from, to] of ASSETS) {
  const dest = join(root, to);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(join(root, from), dest);
  process.stdout.write(`copied ${from} -> ${to}\n`);
}
