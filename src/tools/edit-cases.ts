/**
 * R8.7 — hand-labelled **edit** cases for `golem bench edit`.
 *
 * Written by hand, deliberately and unavoidably: the whole gate rests on
 * comparing a local model's edit against *a human's* edit of the same file, so
 * the ground truth is the one part of this harness a model cannot supply. Each
 * case carries three things the scorer needs, and they are not the same thing:
 *
 *  - **`instruction`** — the ~50-token sentence a frontier model would write
 *    instead of writing the edit itself. That length IS the claim R8.7 makes
 *    about output tokens, so the instructions are kept to the length a real
 *    caller would use, not padded until the local model can't fail.
 *  - **`expected`** — the hand-written edit. Ground truth for the *cost*
 *    baseline (what the frontier model would have had to emit) and for the
 *    strict `exact` score.
 *  - **`assertions`** — what "semantically correct" means for this case, as
 *    substring/absence checks. Weaker than equality and deliberately so: there
 *    is usually more than one right way to add a guard clause, and scoring only
 *    byte-equality would report a correct edit as wrong. Both numbers are
 *    reported; neither is allowed to stand in for the other.
 *
 * The fixtures are self-contained strings, not files in this repo. Editing real
 * repo files in a benchmark is a destructive path (and rots the moment the file
 * changes); a fixture makes the case stable and the harness read-only. They are
 * written in this project's own idiom so the measurement is not flattered by
 * unrealistically small or generic code.
 *
 * Honest limits, stated because the harness exists to prevent self-deception:
 *  - ~12 cases resolve deltas of ~8 percentage points at best. `--repeats`
 *    averages sampling noise; it cannot make the case set bigger.
 *  - The assertions are hand-written by the same person who wrote the expected
 *    edit, so they encode that person's idea of the task. They catch a wrong
 *    edit; they cannot certify a right one.
 *  - Fixtures are single files under ~40 lines. Nothing here measures a
 *    300-line multi-file edit, which is the case the memo's arithmetic is most
 *    excited about — that gap is a stated non-result, not a silent one.
 */

export interface EditAssertion {
  /** Literal text (not a regex) that must appear in the edited file. */
  readonly contains?: string;
  /** Literal text that must NOT appear — usually the line being replaced. */
  readonly absent?: string;
}

export interface EditCase {
  readonly id: string;
  /** Fixture path, extension included — drives the tree-sitter parse check. */
  readonly path: string;
  readonly before: string;
  /** The short instruction a frontier model would send instead of an edit. */
  readonly instruction: string;
  /** The hand-written edit: ground truth for cost and for the strict score. */
  readonly expected: string;
  /** What "semantically correct" means here. ALL must hold. */
  readonly assertions: readonly EditAssertion[];
}

const GUARD_BEFORE = `export interface Hit {
  readonly chunkId: string;
  readonly score: number;
}

export function bestHit(hits: readonly Hit[]): Hit {
  const sorted = [...hits].sort((a, b) => b.score - a.score);
  return sorted[0] as Hit;
}
`;

const GUARD_AFTER = `export interface Hit {
  readonly chunkId: string;
  readonly score: number;
}

export function bestHit(hits: readonly Hit[]): Hit | null {
  if (hits.length === 0) return null;
  const sorted = [...hits].sort((a, b) => b.score - a.score);
  return sorted[0] as Hit;
}
`;

const SWITCH_BEFORE = `export type Level = 0 | 1 | 2 | 3;

export function levelName(level: Level): string {
  switch (level) {
    case 0:
      return "passthrough";
    case 1:
      return "safe";
    case 2:
      return "balanced";
    default:
      return "unknown";
  }
}
`;

const SWITCH_AFTER = `export type Level = 0 | 1 | 2 | 3;

export function levelName(level: Level): string {
  switch (level) {
    case 0:
      return "passthrough";
    case 1:
      return "safe";
    case 2:
      return "balanced";
    case 3:
      return "aggressive";
    default:
      return "unknown";
  }
}
`;

const DEFAULT_ARG_BEFORE = `export interface SearchOptions {
  readonly query: string;
  readonly k: number;
}

export function normalizeOptions(opts: SearchOptions): SearchOptions {
  return { query: opts.query.trim(), k: opts.k };
}
`;

const DEFAULT_ARG_AFTER = `export interface SearchOptions {
  readonly query: string;
  readonly k?: number;
}

export function normalizeOptions(opts: SearchOptions): SearchOptions {
  return { query: opts.query.trim(), k: opts.k ?? 8 };
}
`;

const OFF_BY_ONE_BEFORE = `export function lastNLines(text: string, n: number): string {
  const lines = text.split("\\n");
  if (lines.length <= n) return text;
  return lines.slice(lines.length - n - 1).join("\\n");
}
`;

const OFF_BY_ONE_AFTER = `export function lastNLines(text: string, n: number): string {
  const lines = text.split("\\n");
  if (lines.length <= n) return text;
  return lines.slice(lines.length - n).join("\\n");
}
`;

const FIELD_BEFORE = `export interface TelemetryEvent {
  readonly tool: string;
  readonly durationMs: number;
}

export function summarize(event: TelemetryEvent): string {
  return \`\${event.tool} took \${event.durationMs}ms\`;
}
`;

const FIELD_AFTER = `export interface TelemetryEvent {
  readonly tool: string;
  readonly durationMs: number;
  readonly ok: boolean;
}

export function summarize(event: TelemetryEvent): string {
  return \`\${event.tool} took \${event.durationMs}ms\`;
}
`;

const TRY_BEFORE = `import { readFile } from "node:fs/promises";

export async function readSettings(path: string): Promise<string | null> {
  const text = await readFile(path, "utf8");
  return text;
}
`;

const TRY_AFTER = `import { readFile } from "node:fs/promises";

export async function readSettings(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, "utf8");
    return text;
  } catch {
    return null;
  }
}
`;

const CONST_BEFORE = `export function isOversized(bytes: number): boolean {
  return bytes > 20000;
}

export function describe(bytes: number): string {
  return bytes > 20000 ? "oversized" : "inline";
}
`;

const CONST_AFTER = `const OVERSIZED_BYTES = 20000;

export function isOversized(bytes: number): boolean {
  return bytes > OVERSIZED_BYTES;
}

export function describe(bytes: number): string {
  return bytes > OVERSIZED_BYTES ? "oversized" : "inline";
}
`;

const RENAME_BEFORE = `export function tokenCost(chars: number): number {
  const t = Math.ceil(chars / 4);
  return t;
}
`;

const RENAME_AFTER = `export function tokenCost(chars: number): number {
  const tokens = Math.ceil(chars / 4);
  return tokens;
}
`;

const ASYNC_BEFORE = `export interface Store {
  read(key: string): Promise<string | null>;
}

export function hasKey(store: Store, key: string): boolean {
  return store.read(key) !== null;
}
`;

const ASYNC_AFTER = `export interface Store {
  read(key: string): Promise<string | null>;
}

export async function hasKey(store: Store, key: string): Promise<boolean> {
  return (await store.read(key)) !== null;
}
`;

const IMPORT_BEFORE = `export function configPath(dir: string, name: string): string {
  return \`\${dir}/\${name}\`;
}
`;

const IMPORT_AFTER = `import path from "node:path";

export function configPath(dir: string, name: string): string {
  return path.join(dir, name);
}
`;

const DEDUPE_BEFORE = `export function uniqueSources(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    out.push(p);
  }
  return out;
}
`;

const DEDUPE_AFTER = `export function uniqueSources(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (out.includes(p)) continue;
    out.push(p);
  }
  return out;
}
`;

const CLAMP_BEFORE = `export function clampBudget(requested: number, max: number): number {
  return Math.min(requested, max);
}
`;

const CLAMP_AFTER = `export function clampBudget(requested: number, max: number): number {
  return Math.max(0, Math.min(requested, max));
}
`;

export const EDIT_CASES: readonly EditCase[] = [
  {
    id: "guard-empty-array",
    path: "fixtures/best-hit.ts",
    before: GUARD_BEFORE,
    instruction:
      "bestHit crashes on an empty array. Return null for an empty input and widen the return type to Hit | null.",
    expected: GUARD_AFTER,
    assertions: [{ contains: "Hit | null" }, { contains: "return null" }],
  },
  {
    id: "switch-missing-case",
    path: "fixtures/level-name.ts",
    before: SWITCH_BEFORE,
    instruction: 'Level 3 falls through to "unknown". Add a case 3 that returns "aggressive".',
    expected: SWITCH_AFTER,
    assertions: [{ contains: "case 3:" }, { contains: '"aggressive"' }],
  },
  {
    id: "optional-with-default",
    path: "fixtures/search-options.ts",
    before: DEFAULT_ARG_BEFORE,
    instruction: "Make k optional on SearchOptions and default it to 8 in normalizeOptions.",
    expected: DEFAULT_ARG_AFTER,
    assertions: [{ contains: "k?: number" }, { contains: "?? 8" }],
  },
  {
    id: "off-by-one",
    path: "fixtures/last-n-lines.ts",
    before: OFF_BY_ONE_BEFORE,
    instruction: "lastNLines returns one line too many. Fix the off-by-one in the slice.",
    expected: OFF_BY_ONE_AFTER,
    assertions: [
      { contains: "lines.length - n)" },
      { absent: "lines.length - n - 1" },
      { absent: "n + 1" },
    ],
  },
  {
    id: "add-interface-field",
    path: "fixtures/telemetry-event.ts",
    before: FIELD_BEFORE,
    instruction: "Add a required readonly boolean field named ok to TelemetryEvent.",
    expected: FIELD_AFTER,
    assertions: [{ contains: "readonly ok: boolean" }],
  },
  {
    id: "wrap-in-try",
    path: "fixtures/read-settings.ts",
    before: TRY_BEFORE,
    instruction:
      "readSettings throws when the file is missing. Wrap the read in try/catch and return null on failure.",
    expected: TRY_AFTER,
    assertions: [{ contains: "try {" }, { contains: "catch" }, { contains: "return null" }],
  },
  {
    id: "extract-constant",
    path: "fixtures/oversized.ts",
    before: CONST_BEFORE,
    instruction:
      "The literal 20000 appears twice. Extract it into one module-level const and use it in both places.",
    expected: CONST_AFTER,
    assertions: [{ contains: "= 20000" }, { absent: "> 20000" }],
  },
  {
    id: "rename-local",
    path: "fixtures/token-cost.ts",
    before: RENAME_BEFORE,
    instruction: "Rename the local variable t to tokens.",
    expected: RENAME_AFTER,
    assertions: [
      { contains: "const tokens" },
      { contains: "return tokens" },
      { absent: "const t " },
    ],
  },
  {
    id: "await-a-promise",
    path: "fixtures/has-key.ts",
    before: ASYNC_BEFORE,
    instruction:
      "hasKey compares a Promise to null, so it is always true. Make it async, await the read, and return Promise<boolean>.",
    expected: ASYNC_AFTER,
    assertions: [{ contains: "async function hasKey" }, { contains: "await store.read(key)" }],
  },
  {
    id: "add-import-and-use",
    path: "fixtures/config-path.ts",
    before: IMPORT_BEFORE,
    instruction:
      "Use node:path's join instead of string interpolation, so this works on Windows. Add the import.",
    expected: IMPORT_AFTER,
    assertions: [{ contains: 'from "node:path"' }, { contains: "path.join(dir, name)" }],
  },
  {
    id: "dedupe-loop",
    path: "fixtures/unique-sources.ts",
    before: DEDUPE_BEFORE,
    instruction: "uniqueSources does not actually dedupe. Skip a path that is already in out.",
    expected: DEDUPE_AFTER,
    assertions: [{ contains: "out.includes(p)" }],
  },
  {
    id: "clamp-lower-bound",
    path: "fixtures/clamp-budget.ts",
    before: CLAMP_BEFORE,
    instruction: "clampBudget can return a negative number. Clamp the lower bound at 0 as well.",
    expected: CLAMP_AFTER,
    assertions: [{ contains: "Math.max(0," }],
  },
];
