/**
 * WS-W W2: registers FileWikiStore against the frozen WikiStore contract.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { FileWikiStore } from "../../src/wiki/index.js";
import { describeWikiStoreContract } from "./wiki-contract.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describeWikiStoreContract("FileWikiStore", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "golem-wiki-contract-"));
  dirs.push(dir);
  return new FileWikiStore({ wikiDir: dir, now: () => "2026-07-10" });
});
