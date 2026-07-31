/**
 * R8.7 — the diff the frontier model reads INSTEAD of writing the edit.
 *
 * The whole token argument rests on this asymmetry: an edit written by the paid
 * model is thousands of *output* tokens (never cached, ~5×), while the same edit
 * *reviewed* is a few hundred *input* tokens. That only holds if the review
 * artefact is small, so this renders changed hunks with a little context — never
 * the whole file — and says out loud how many lines it dropped.
 *
 * A plain LCS over lines, bounded: `edit` mode refuses files above a few hundred
 * lines anyway, so the O(n·m) table is small and predictable. No dependency for
 * this — a diff library in the default install would fail CLAUDE.md's
 * no-heavyweight-deps rule for a hundred lines of arithmetic.
 */

export interface DiffStat {
  readonly added: number;
  readonly removed: number;
  /** Unified-diff text with `context` lines around each hunk. */
  readonly text: string;
  /** True when hunks were dropped to stay inside `maxLines`. */
  readonly truncated: boolean;
}

interface Op {
  readonly kind: "same" | "add" | "remove";
  readonly line: string;
}

/** Longest-common-subsequence line ops. Bounded by the caller's size cap. */
export function diffLines(before: readonly string[], after: readonly string[]): Op[] {
  const n = before.length;
  const m = after.length;
  // table[i][j] = LCS length of before[i..] and after[j..]
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = table[i];
    const next = table[i + 1];
    if (row === undefined || next === undefined) continue;
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] =
        before[i] === after[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ kind: "same", line: before[i] ?? "" });
      i += 1;
      j += 1;
      continue;
    }
    const down = table[i + 1]?.[j] ?? 0;
    const right = table[i]?.[j + 1] ?? 0;
    if (down >= right) {
      ops.push({ kind: "remove", line: before[i] ?? "" });
      i += 1;
    } else {
      ops.push({ kind: "add", line: after[j] ?? "" });
      j += 1;
    }
  }
  for (; i < n; i += 1) ops.push({ kind: "remove", line: before[i] ?? "" });
  for (; j < m; j += 1) ops.push({ kind: "add", line: after[j] ?? "" });
  return ops;
}

export interface DiffOptions {
  readonly context?: number;
  /** Hard cap on rendered lines — a review artefact must stay cheap to read. */
  readonly maxLines?: number;
}

/**
 * Render a compact unified diff of one file, plus the +/- counts.
 *
 * The counts are computed over the WHOLE diff, not the rendered excerpt, so a
 * truncated render still reports the true size of the change — a confirmation
 * that under-reports what it changed is the dishonest observability this
 * project exists to avoid.
 */
export function renderDiff(
  path: string,
  before: string,
  after: string,
  options: DiffOptions = {},
): DiffStat {
  const context = options.context ?? 2;
  const maxLines = options.maxLines ?? 120;
  const ops = diffLines(
    before.replace(/\r\n/gu, "\n").split("\n"),
    after.replace(/\r\n/gu, "\n").split("\n"),
  );
  const added = ops.filter((o) => o.kind === "add").length;
  const removed = ops.filter((o) => o.kind === "remove").length;

  // Keep only lines within `context` of a change.
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.kind === "same") return;
    for (
      let k = Math.max(0, index - context);
      k <= Math.min(ops.length - 1, index + context);
      k++
    ) {
      keep[k] = true;
    }
  });

  const body: string[] = [];
  let truncated = false;
  let gap = false;
  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index];
    if (op === undefined) continue;
    if (!keep[index]) {
      gap = true;
      continue;
    }
    if (body.length >= maxLines) {
      truncated = true;
      break;
    }
    if (gap && body.length > 0) body.push("@@");
    gap = false;
    body.push(`${op.kind === "add" ? "+" : op.kind === "remove" ? "-" : " "}${op.line}`);
  }

  const header = `--- ${path}\n+++ ${path}`;
  const footer = truncated ? "\n… diff truncated; +/- counts above are for the whole change" : "";
  return { added, removed, text: `${header}\n${body.join("\n")}${footer}\n`, truncated };
}
