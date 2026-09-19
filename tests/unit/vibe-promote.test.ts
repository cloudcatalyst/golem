/**
 * The two ends of the quiz: what may be asked, and what happens when it is
 * answered.
 *
 * `signals.ts` is mostly a set of refusals, and those are what is pinned here —
 * a capture layer that fires on small files produces a queue nobody reads, and
 * the failure is silent because a noisy candidate looks exactly like a real one.
 *
 * `promote.ts` has one property that is easy to lose and expensive to notice: a
 * confirmed preference must reach the brief WITHOUT pushing the measured habits
 * out of it, since the brief is capped and truncates from the bottom.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyConfirmed,
  BRIEF_MAX_BYTES,
  BRIEF_PREFERENCE_LIMIT,
  type Candidate,
  CONFIRMED_BEGIN,
  CONFIRMED_END,
  confirmCandidate,
  diffObservations,
  emptyObservation,
  loadCandidates,
  MEASURED_BEGIN,
  observeSource,
  openVibeStore,
  rankConfirmed,
  recordSignal,
  spliceBlock,
  type VibeStore,
} from "../../src/vibe/index.js";
import { useTempDirs } from "../helpers/tmp.js";

const newTempDir = useTempDirs("golem-vp");

const observe = (text: string) => observeSource(text, emptyObservation());

describe("diffObservations", () => {
  it("reports a genuine change of quote style", () => {
    const before = observe('const a = "x"; const b = "y";');
    const after = observe("const a = 'x'; const b = 'y';");

    expect(diffObservations(before, after)).toEqual([
      { kind: "quotes", from: "double", to: "single" },
    ]);
  });

  it("refuses to read a quote preference out of a single string", () => {
    // Two quote characters is one string. A file that small cannot support the
    // claim, and a candidate raised from it is noise the human has to decline.
    const before = observe('const a = "x";');
    const after = observe("const a = 'x';");

    expect(diffObservations(before, after)).toEqual([]);
  });

  it("refuses to read a semicolon preference from too few candidate lines", () => {
    const before = observe(["const a = 1;", "const b = 2;"].join("\n"));
    const after = observe(["const a = 1", "const b = 2"].join("\n"));

    expect(diffObservations(before, after)).toEqual([]);
  });

  it("reads a semicolon preference once there is enough to read", () => {
    const withThem = ["const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;"].join("\n");
    const without = ["const a = 1", "const b = 2", "const c = 3", "const d = 4"].join("\n");

    expect(diffObservations(observe(withThem), observe(without))).toContainEqual({
      kind: "semicolons",
      from: "yes",
      to: "no",
    });
  });

  it("says nothing when the preference did not move", () => {
    const before = observe('const a = "x"; const b = "y";');
    const after = observe('const alpha = "x"; const beta = "y";');

    expect(diffObservations(before, after)).toEqual([]);
  });

  it("notices a switch from spaces to tabs", () => {
    const spaces = ["function f() {", "  const a = 1;", "  const b = 2;", "  return a;", "}"].join(
      "\n",
    );
    const tabs = ["function f() {", "\tconst a = 1;", "\tconst b = 2;", "\treturn a;", "}"].join(
      "\n",
    );

    expect(diffObservations(observe(spaces), observe(tabs))).toContainEqual({
      kind: "indent-kind",
      from: "spaces",
      to: "tabs",
    });
  });
});

describe("spliceBlock", () => {
  it("replaces an existing block in place", () => {
    const text = `head\n${CONFIRMED_BEGIN}\nold\n${CONFIRMED_END}\ntail`;

    const out = spliceBlock(text, CONFIRMED_BEGIN, CONFIRMED_END, "new");

    expect(out).toContain("new");
    expect(out).not.toContain("old");
    expect(out).toContain("head");
    expect(out).toContain("tail");
  });

  it("inserts BEFORE the anchor on a first write, so the cap cannot eat it", () => {
    // The brief truncates from the bottom. Appending confirmed preferences to
    // the end would make the most valuable part the first thing dropped.
    const text = `# Personal vibe\n\n${MEASURED_BEGIN}\nmeasured\n`;

    const out = spliceBlock(text, CONFIRMED_BEGIN, CONFIRMED_END, "body", MEASURED_BEGIN);

    expect(out.indexOf(CONFIRMED_BEGIN)).toBeLessThan(out.indexOf(MEASURED_BEGIN));
  });

  it("appends when the anchor is not there either", () => {
    const out = spliceBlock("# Personal vibe\n", CONFIRMED_BEGIN, CONFIRMED_END, "body", "absent");

    expect(out).toContain(CONFIRMED_BEGIN);
    expect(out).toContain("body");
  });
});

describe("applyConfirmed", () => {
  let base: string;
  let projectDir: string;
  let userDir: string;
  let store: VibeStore;

  beforeEach(async () => {
    base = await newTempDir();
    projectDir = path.join(base, "project");
    userDir = path.join(base, "home", ".golem");
    await mkdir(path.join(projectDir, ".golem"), { recursive: true });
    await writeFile(path.join(projectDir, ".golem", "settings.json"), "{}\n", "utf8");
    const opened = openVibeStore({ cwd: projectDir, userDir, rootDir: base });
    if (opened === null) throw new Error("fixture is not a Golem project");
    store = opened;
  });

  /** Record and confirm one signal, returning its key. */
  async function confirmed(kind: "quotes" | "semicolons", from: string, to: string, n = 1) {
    let key = "";
    for (let i = 0; i < n; i += 1) {
      const row = await recordSignal(
        store,
        { kind, from, to },
        path.join(projectDir, `f${i}.ts`),
        "2026-09-13T10:00:00.000Z",
      );
      if (row !== null) key = row.key;
    }
    await confirmCandidate(store, key, "2026-09-13T10:01:00.000Z", "because I like it");
    return key;
  }

  it("writes the preference into both the guideline page and the brief", async () => {
    await confirmed("quotes", "double", "single");

    const result = await applyConfirmed(store, "2026-09-13");

    expect(result.confirmed).toBe(1);
    expect(result.inBrief).toBe(1);
    const page = await store.readGuideline("preferences");
    expect(page).toContain("prefers single quotes");
    expect(page).toContain("because I like it");
    const brief = await store.brief();
    expect(brief).toContain("Confirmed preferences");
    expect(brief).toContain("prefers single quotes");
  });

  it("keeps the brief under its cap however many preferences are confirmed", async () => {
    for (let i = 0; i < BRIEF_PREFERENCE_LIMIT + 4; i += 1) {
      await recordSignal(
        store,
        { kind: "line-width", from: String(80 + i), to: String(120 + i) },
        path.join(projectDir, `f${i}.ts`),
        "2026-09-13T10:00:00.000Z",
      );
    }
    for (const c of await loadCandidates(store)) {
      await confirmCandidate(store, c.key, "2026-09-13T10:01:00.000Z");
    }

    const result = await applyConfirmed(store, "2026-09-13");

    const total = BRIEF_PREFERENCE_LIMIT + 4;
    expect(result.confirmed).toBe(total);
    expect(result.inBrief).toBe(BRIEF_PREFERENCE_LIMIT);
    expect(result.briefBytes).toBeLessThanOrEqual(BRIEF_MAX_BYTES);
    // The overflow is not dropped, only moved off the always-loaded path.
    expect(await store.readGuideline("preferences")).toContain(`${total} preference(s)`);
    expect(await store.brief()).toContain(`${total - BRIEF_PREFERENCE_LIMIT} more in`);
  });

  it("is idempotent — running it twice changes nothing", async () => {
    await confirmed("quotes", "double", "single");

    await applyConfirmed(store, "2026-09-13");
    const first = await store.brief();
    await applyConfirmed(store, "2026-09-13");

    expect(await store.brief()).toBe(first);
  });

  it("says so plainly when nothing has been confirmed", async () => {
    const result = await applyConfirmed(store, "2026-09-13");

    expect(result.confirmed).toBe(0);
    expect(await store.readGuideline("preferences")).toContain("None confirmed yet");
  });
});

describe("rankConfirmed", () => {
  it("puts breadth of evidence first — more files beats more sightings", () => {
    const rows: Candidate[] = [
      {
        key: "a",
        kind: "quotes",
        from: "double",
        to: "single",
        seen: 9,
        files: ["one.ts"],
        firstSeen: "x",
        lastSeen: "x",
        state: "confirmed",
      },
      {
        key: "b",
        kind: "semicolons",
        from: "yes",
        to: "no",
        seen: 3,
        files: ["one.ts", "two.ts", "three.ts"],
        firstSeen: "x",
        lastSeen: "x",
        state: "confirmed",
      },
    ];

    expect(rankConfirmed(rows).map((c) => c.key)).toEqual(["b", "a"]);
  });

  it("ignores anything not confirmed", () => {
    const rows: Candidate[] = [
      {
        key: "open",
        kind: "quotes",
        from: "double",
        to: "single",
        seen: 5,
        files: ["a.ts"],
        firstSeen: "x",
        lastSeen: "x",
        state: "open",
      },
    ];

    expect(rankConfirmed(rows)).toEqual([]);
  });
});
