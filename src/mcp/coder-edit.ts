/**
 * R8.7 — `coder`'s **edit** mode: the local model writes the code, Golem
 * validates it, and the frontier model reads a diff instead of emitting one.
 *
 * The measured basis for this shipping at all (`golem bench edit`, §110):
 * qwen2.5-coder:7b clears the pre-registered bar on the **whole-file** format
 * and fails it badly on `search-replace` and `udiff` — it will not reliably
 * copy existing lines byte for byte, which is exactly what those two formats
 * require. So this mode asks for the whole file, and every guard here exists
 * because "the whole file" is the format with the most room to do damage:
 *
 *  - **A size cap.** The case set validated ~10–40-line TypeScript files. A
 *    500-line file invites "// ...rest of the file unchanged", so files above
 *    the cap are refused with a reason rather than edited on a hope.
 *  - **A definition-loss guard.** `validateEdits`' `symbolCheck` refuses a
 *    rewrite that stops defining something the original defined — the failure a
 *    parse check cannot see, and the one the small fixtures could not exhibit.
 *  - **No unvalidated write, ever.** Applying requires the tree-sitter syntax
 *    check to have actually run. On a file type Golem cannot parse (Markdown,
 *    JSON, a language with no grammar installed) the edit is *proposed* and
 *    never written, because an unvalidated whole-file overwrite is precisely the
 *    code-corruption path R8.7's hard constraints forbid.
 *  - **Propose-by-default.** `apply` defaults to false: the default outcome of
 *    calling this tool is a diff to read, not a changed file. Writing is a
 *    second, explicit act (ADR-0002's autonomy rule — `mcp__golem__coder` is
 *    classified as a `write` tool, so the gate sees it like any other write).
 *
 * Nothing here is automatic: `coder` is an explicit call, the slider never
 * reaches it (Decision 31), and a failed validation NEVER falls back to writing
 * the model's raw text.
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { estimateTokens } from "../compression/tokens.js";
import type { InferenceService } from "../interfaces/index.js";
import { extractFileFacts, hasParseError } from "../knowledge/index.js";
import type { EditStatus } from "../tools/index.js";
import {
  editFormatInstructions,
  parseEditReply,
  renderDiff,
  validateEdits,
} from "../tools/index.js";

/**
 * Files above this are refused. Chosen as a guard, NOT as a measured bound: the
 * gate's fixtures were ~10–40 lines, so anything larger is unmeasured territory
 * and the honest move is to decline rather than to extrapolate.
 */
export const MAX_EDIT_LINES = 200;

const ROLE_LINE =
  "You are a code editor. You are given one file and one instruction. Change " +
  "ONLY what the instruction asks for; leave every other line exactly as it is.";

export interface CoderEditDeps {
  readonly inference: InferenceService;
  /** Project root — the edit may not leave it. */
  readonly projectDir: string;
}

export interface CoderEditRequest {
  readonly instruction: string;
  /** Path to edit, absolute or relative to the project root. */
  readonly file: string;
  /** Write the file. Default false: propose a diff and change nothing. */
  readonly apply?: boolean;
  /** Extra context to hand the local model (rarely needed — it gets the file). */
  readonly context?: string;
}

export interface CoderEditResult {
  readonly status: "applied" | "proposed" | "rejected";
  /** Project-relative path, for a message that does not leak the whole tree. */
  readonly path: string;
  readonly model: string | null;
  readonly validation: EditStatus | "refused";
  /** Why it was refused / what caveat rides on a proposal. Null when clean. */
  readonly reason: string | null;
  readonly diff: string | null;
  readonly added: number;
  readonly removed: number;
  /** False when tree-sitter could not check the result — blocks `apply`. */
  readonly parseChecked: boolean;
  /** Local output tokens spent (free in money, not in latency). */
  readonly replyTokens: number;
}

function refused(rel: string, reason: string): CoderEditResult {
  return {
    status: "rejected",
    path: rel,
    model: null,
    validation: "refused",
    reason,
    diff: null,
    added: 0,
    removed: 0,
    parseChecked: false,
    replyTokens: 0,
  };
}

/** Definition names for a file, or null when tree-sitter cannot tell us. */
async function listSymbols(ext: string, content: string): Promise<readonly string[] | null> {
  const facts = await extractFileFacts(ext, content);
  return facts === null ? null : facts.defs.map((d) => d.name);
}

/**
 * Draft an edit locally, validate it, and (only if asked AND validated) write it.
 *
 * Never throws for an editing failure — an unreachable model or an unparseable
 * reply is a `rejected` result with the reason in it, because a thrown error
 * inside a tool call tells the caller nothing about which guard fired.
 */
export async function coderEdit(
  deps: CoderEditDeps,
  request: CoderEditRequest,
): Promise<CoderEditResult> {
  const absolute = path.resolve(deps.projectDir, request.file);
  const relative = path.relative(deps.projectDir, absolute).split(path.sep).join("/");
  const shown = relative === "" ? request.file : relative;

  // Path containment first: an edit outside the project is out of scope for a
  // local drafting tool, whatever the instruction says.
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return refused(shown, "that path is outside this project — refusing to edit it");
  }

  let before: string;
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return refused(shown, "not a regular file");
    before = await readFile(absolute, "utf8");
  } catch (err) {
    return refused(
      shown,
      `cannot read the file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const lineCount = before.split("\n").length;
  if (lineCount > MAX_EDIT_LINES) {
    return refused(
      shown,
      `${lineCount} lines is above the ${MAX_EDIT_LINES}-line cap for local edits — the gate ` +
        "measured this on much smaller files, so bigger ones are declined rather than guessed at. " +
        "Edit it yourself, or narrow the file.",
    );
  }

  const ext = path.extname(absolute).toLowerCase();
  const user = [
    shown,
    "```",
    before.replace(/\n$/u, ""),
    "```",
    ...(request.context === undefined || request.context === ""
      ? []
      : ["", `Context:\n${request.context}`]),
    "",
    `Task: ${request.instruction}`,
  ].join("\n");

  let reply: string;
  let model: string;
  try {
    const result = await deps.inference.chat(
      "drafter",
      [
        { role: "system", content: `${ROLE_LINE}\n\n${editFormatInstructions("whole")}` },
        { role: "user", content: user },
      ],
      { temperature: 0 },
    );
    reply = result.text;
    model = result.model;
  } catch (err) {
    return refused(
      shown,
      `the local model could not be reached: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const replyTokens = estimateTokens(reply);
  const parsed = parseEditReply("whole", reply);
  if (parsed.edits.length === 0) {
    return {
      ...refused(shown, `the local model's reply was unusable: ${parsed.problems[0] ?? "no edit"}`),
      model,
      replyTokens,
    };
  }

  const validated = await validateEdits({
    before,
    // The path the model echoed is ignored: this mode edits the file that was
    // asked for, never one the model names. A model-chosen write target is a
    // corruption path that no amount of content validation would catch.
    edits: parsed.edits.map((edit) => ({ ...edit, path: shown })),
    ext,
    parseCheck: hasParseError,
    symbolCheck: listSymbols,
  });

  if (validated.status !== "valid" || validated.after === null) {
    const diff = validated.after === null ? null : renderDiff(shown, before, validated.after).text;
    return {
      status: "rejected",
      path: shown,
      model,
      validation: validated.status,
      reason: validated.reason ?? "the edit did not validate",
      diff,
      added: 0,
      removed: 0,
      parseChecked: validated.parseChecked,
      replyTokens,
    };
  }

  const stats = renderDiff(shown, before, validated.after);
  const base = {
    path: shown,
    model,
    validation: validated.status,
    diff: stats.text,
    added: stats.added,
    removed: stats.removed,
    parseChecked: validated.parseChecked,
    replyTokens,
  } as const;

  if (request.apply !== true) {
    return {
      ...base,
      status: "proposed",
      reason: validated.parseChecked
        ? null
        : "the syntax check was unavailable for this file type, so `apply` would be refused",
    };
  }
  if (!validated.parseChecked) {
    return {
      ...base,
      status: "rejected",
      validation: validated.status,
      reason:
        "refusing to WRITE an edit Golem could not syntax-check (no tree-sitter grammar for " +
        `${ext === "" ? "this file" : ext}) — the diff above is a proposal only`,
    };
  }

  try {
    await writeFile(absolute, validated.after, "utf8");
  } catch (err) {
    return {
      ...base,
      status: "rejected",
      reason: `validated, but the write failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ...base, status: "applied", reason: null };
}
