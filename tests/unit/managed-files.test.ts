/**
 * R9.5 — managed-file provenance.
 *
 * The two bugs, in mirror image: a re-init silently destroyed a hand-edited
 * skill, and an improved guidance rule never reached an already-initialized
 * project. Both come from asking "does this differ from what Golem ships?" when
 * the real question is "did the USER change it, or did Golem's text move on?"
 *
 * `skill-provenance-on-clone` adds the half that was missing: the record has to
 * reach the machines the FILES reach. It lives in committed
 * `.golem/managed-files.json` now, with the old gitignored
 * `.golem/state/managed-files.json` still read so nothing regresses.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  classifyManaged,
  forgetManaged,
  hashManaged,
  isUnmodifiedManaged,
  managedKey,
  managedRecordPath,
  managedStatePath,
  rememberManaged,
  removeManagedState,
} from "../../src/cli/managed-files.js";
import { useTempDirs } from "../helpers/tmp.js";

let dir: string;
const FILE = (): string => path.join(dir, ".claude", "skills", "golem-ship", "SKILL.md");

async function put(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

/** Write a record file directly, the way a clone receives one (or once had one). */
async function putRecord(file: string, record: Record<string, string>): Promise<void> {
  await put(file, `${JSON.stringify(record, null, 2)}\n`);
}

const readRecord = async (file: string): Promise<Record<string, string>> =>
  JSON.parse(await readFile(file, "utf8")) as Record<string, string>;

const exists = (file: string): Promise<boolean> =>
  readFile(file, "utf8").then(
    () => true,
    () => false,
  );

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
    await put(managedRecordPath(dir), "{not json");
    expect(await classifyManaged(dir, FILE(), "v2", "v1")).toBe("owned");
  });
});

describe("the provenance record", () => {
  it("keys by project-relative POSIX path so it is portable", async () => {
    expect(managedKey(dir, FILE())).toBe(".claude/skills/golem-ship/SKILL.md");
  });

  it("is written where git can carry it, not under gitignored .golem/state/", async () => {
    await rememberManaged(dir, FILE(), "v1");
    expect(managedRecordPath(dir)).toBe(path.join(dir, ".golem", "managed-files.json"));
    expect(await exists(managedRecordPath(dir))).toBe(true);
    expect(await exists(managedStatePath(dir))).toBe(false);
  });

  it("stores a hash of the content, never the content itself", async () => {
    await rememberManaged(dir, FILE(), "secret-ish text");
    const raw = await readFile(managedRecordPath(dir), "utf8");
    expect(raw).toContain(hashManaged("secret-ish text"));
    expect(raw).not.toContain("secret-ish text");
  });

  it("sorts its keys, so two machines recording the same facts write the same file", async () => {
    const rules = path.join(dir, ".claude", "rules", "golem-ccr-refs.md");
    await rememberManaged(dir, FILE(), "a");
    await rememberManaged(dir, rules, "b");
    expect(Object.keys(await readRecord(managedRecordPath(dir)))).toEqual([
      ".claude/rules/golem-ccr-refs.md",
      ".claude/skills/golem-ship/SKILL.md",
    ]);
  });

  it("leaves the committed file alone when nothing changed", async () => {
    await rememberManaged(dir, FILE(), "v1");
    const before = await readFile(managedRecordPath(dir), "utf8");
    await rememberManaged(dir, FILE(), "v1");
    expect(await readFile(managedRecordPath(dir), "utf8")).toBe(before);
  });

  it("forgets one file without disturbing the others", async () => {
    const other = path.join(dir, ".claude", "rules", "golem-ccr-refs.md");
    await rememberManaged(dir, FILE(), "a");
    await rememberManaged(dir, other, "b");
    await forgetManaged(dir, FILE());
    const record = await readRecord(managedRecordPath(dir));
    expect(record[managedKey(dir, FILE())]).toBeUndefined();
    expect(record[managedKey(dir, other)]).toBe(hashManaged("b"));
  });

  it("removes both records, and tolerates removing them twice", async () => {
    await rememberManaged(dir, FILE(), "a");
    await putRecord(managedStatePath(dir), { [managedKey(dir, FILE())]: hashManaged("a") });
    await removeManagedState(dir);
    await removeManagedState(dir);
    expect(await exists(managedRecordPath(dir))).toBe(false);
    expect(await exists(managedStatePath(dir))).toBe(false);
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

describe("the pre-clone-fix machine-local record", () => {
  it("still counts as proof Golem wrote the file", async () => {
    // An already-initialized project: its hashes are under .golem/state/ only.
    await putRecord(managedStatePath(dir), { [managedKey(dir, FILE())]: hashManaged("v1") });
    expect(await classifyManaged(dir, FILE(), "v2", "v1")).toBe("stale");
    expect(await isUnmodifiedManaged(dir, FILE(), "v1")).toBe(true);
  });

  it("is folded into the portable record the next time Golem writes anything", async () => {
    const other = path.join(dir, ".claude", "rules", "golem-ccr-refs.md");
    await putRecord(managedStatePath(dir), { [managedKey(dir, other)]: hashManaged("b") });
    await rememberManaged(dir, FILE(), "a");
    const record = await readRecord(managedRecordPath(dir));
    expect(record[managedKey(dir, other)]).toBe(hashManaged("b"));
    expect(record[managedKey(dir, FILE())]).toBe(hashManaged("a"));
  });

  it("is cleared by forgetManaged too — a stale hash there would resurrect the claim", async () => {
    await putRecord(managedStatePath(dir), { [managedKey(dir, FILE())]: hashManaged("v1") });
    await forgetManaged(dir, FILE());
    expect(await isUnmodifiedManaged(dir, FILE(), "v1")).toBe(false);
    expect(await classifyManaged(dir, FILE(), "v2", "v1")).toBe("owned");
  });
});

describe("a clone (skill-provenance-on-clone)", () => {
  it("refreshes a committed file whose hash arrived with it", async () => {
    // Exactly what a teammate checks out: the file and a committed record,
    // and NO .golem/state/ anywhere.
    await put(FILE(), "an older Golem's shipped text");
    await putRecord(managedRecordPath(dir), {
      [managedKey(dir, FILE())]: hashManaged("an older Golem's shipped text"),
    });
    expect(await exists(managedStatePath(dir))).toBe(false);

    expect(await classifyManaged(dir, FILE(), "the new text", "an older Golem's shipped text")).toBe(
      "stale",
    );
  });

  it("still reports a genuinely hand-edited file as owned", async () => {
    await putRecord(managedRecordPath(dir), {
      [managedKey(dir, FILE())]: hashManaged("an older Golem's shipped text"),
    });
    expect(
      await classifyManaged(dir, FILE(), "the new text", "an older Golem's text + my notes"),
    ).toBe("owned");
  });
});
