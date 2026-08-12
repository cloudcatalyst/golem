/**
 * R9.5 — managed-file provenance.
 *
 * The two bugs, in mirror image: a re-init silently destroyed a hand-edited
 * skill, and an improved guidance rule never reached an already-initialized
 * project. Both come from asking "does this differ from what Golem ships?" when
 * the real question is "did the USER change it, or did Golem's text move on?"
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  classifyManaged,
  forgetManaged,
  hashManaged,
  managedKey,
  managedStatePath,
  rememberManaged,
  removeManagedState,
} from "../../src/cli/managed-files.js";
import { useTempDirs } from "../helpers/tmp.js";

let dir: string;
const FILE = (): string => path.join(dir, ".claude", "skills", "golem", "ship", "SKILL.md");

async function put(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

const newTempDir = useTempDirs("golem-managed-");

beforeEach(async () => {
  dir = await newTempDir();
});

describe("classifyManaged", () => {
  it("is absent when there is no file", async () => {
    expect(await classifyManaged(dir, FILE(), "shipped", null)).toBe("absent");
  });

  it("is current when the file matches what Golem ships", async () => {
    expect(await classifyManaged(dir, FILE(), "shipped", "shipped")).toBe("current");
  });

  it("is stale when the file still matches what Golem last wrote", async () => {
    await put(FILE(), "v1");
    await rememberManaged(dir, FILE(), "v1");
    // Golem now ships v2; the user never touched their copy.
    expect(await classifyManaged(dir, FILE(), "v2", "v1")).toBe("stale");
  });

  it("is owned once the user edits it", async () => {
    await put(FILE(), "v1");
    await rememberManaged(dir, FILE(), "v1");
    expect(await classifyManaged(dir, FILE(), "v2", "v1 plus my notes")).toBe("owned");
  });

  it("is owned when Golem has no record of writing it (pre-R9.5 project)", async () => {
    // The conservative direction on purpose: Golem cannot prove it wrote this,
    // so it must not discard it. Refreshing here would be the old data-loss bug
    // wearing a new mechanism.
    expect(await classifyManaged(dir, FILE(), "v2", "v1")).toBe("owned");
  });

  it("degrades to owned — never to overwrite — on a corrupt record", async () => {
    await mkdir(path.dirname(managedStatePath(dir)), { recursive: true });
    await writeFile(managedStatePath(dir), "{not json", "utf8");
    expect(await classifyManaged(dir, FILE(), "v2", "v1")).toBe("owned");
  });
});

describe("the provenance record", () => {
  it("keys by project-relative POSIX path so it is portable", async () => {
    expect(managedKey(dir, FILE())).toBe(".claude/skills/golem/ship/SKILL.md");
  });

  it("stores a hash of the content, never the content itself", async () => {
    await rememberManaged(dir, FILE(), "secret-ish text");
    const raw = await readFile(managedStatePath(dir), "utf8");
    expect(raw).toContain(hashManaged("secret-ish text"));
    expect(raw).not.toContain("secret-ish text");
  });

  it("forgets one file without disturbing the others", async () => {
    const other = path.join(dir, ".claude", "rules", "golem-ccr-refs.md");
    await rememberManaged(dir, FILE(), "a");
    await rememberManaged(dir, other, "b");
    await forgetManaged(dir, FILE());
    const record = JSON.parse(await readFile(managedStatePath(dir), "utf8")) as Record<
      string,
      string
    >;
    expect(record[managedKey(dir, FILE())]).toBeUndefined();
    expect(record[managedKey(dir, other)]).toBe(hashManaged("b"));
  });

  it("removes the whole record, and tolerates removing it twice", async () => {
    await rememberManaged(dir, FILE(), "a");
    await removeManagedState(dir);
    await removeManagedState(dir);
    await expect(readFile(managedStatePath(dir), "utf8")).rejects.toThrow();
  });

  it("re-recording after a refresh makes the next drift stale again", async () => {
    await rememberManaged(dir, FILE(), "v1");
    expect(await classifyManaged(dir, FILE(), "v2", "v1")).toBe("stale");
    // Golem refreshes to v2 and records it.
    await rememberManaged(dir, FILE(), "v2");
    expect(await classifyManaged(dir, FILE(), "v3", "v2")).toBe("stale");
    expect(await classifyManaged(dir, FILE(), "v3", "v2 edited")).toBe("owned");
  });
});
