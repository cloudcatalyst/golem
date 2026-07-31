/**
 * R5.4 — action classifier (conservative allow-list).
 *
 * Governing rule (ADR-0002): anything NOT positively recognized as read/write
 * is `unknown`, and `unknown` is never auto-allowed. Bash is `unknown` unless it
 * matches the positive safe-read allow-list; destructive/outward patterns only
 * ever ESCALATE the class, never downgrade it.
 */

/** Risk class of a pending tool call, least→most gated. */
export type ActionClass = "read" | "write" | "destructive" | "outward" | "unknown";

/** Tools that only read (no mutation, no outward side effect). */
const READ_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "NotebookRead",
  "WebSearch",
  "WebFetch",
  "TodoWrite",
  // Golem read-only MCP tools (short verb names, Decision 27). `level` is NOT
  // here — it WRITES the persistent slider (see classifyAction's special case).
  "mcp__golem__search",
  "mcp__golem__fetch",
  "mcp__golem__stats",
  "mcp__golem__expand",
  "mcp__golem__devices",
  "mcp__golem__wiki_read",
  // snooze just WAITS (no read/write/outward side effect) — harmless to auto-allow.
  "mcp__golem__snooze",
]);

/** Tools that write locally (files / local drafts) but nothing outward. */
const WRITE_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "mcp__golem__coder",
  "mcp__golem__ingest",
]);

/** Tools that reach OUTSIDE the machine / are hard to reverse. Always gated. */
const OUTWARD_TOOLS = new Set(["mcp__golem__wiki_upsert"]);

/** Bash commands safe to treat as read-only (exact leading-token / phrase match). */
const SAFE_BASH = [
  /^ls(\s|$)/,
  /^cat\s/,
  /^pwd(\s|$)/,
  /^echo\s/,
  /^head\s/,
  /^tail\s/,
  /^wc\s/,
  /^which\s/,
  /^git\s+(status|diff|log|show|branch|remote\s+-v)(\s|$)/,
  /^npm\s+(test|run\s+(test|lint|typecheck|format:check))(\s|$)/,
  /^(npx\s+)?(tsc|vitest|biome)(\s|$)/,
  /^node\s+--version/,
];

/** Bash patterns that make a command DESTRUCTIVE (local data loss). */
const DESTRUCTIVE_BASH = [
  /\brm\s+-[a-z]*[rf]/i,
  // R8.9: the change ledger's write half. `restore`/`undo` overwrite and delete
  // worktree files; `drop`/`prune` destroy snapshots. The CLI asks too, but this
  // is the gate the task's brief requires: destructive is in ADR-0002's
  // never-auto set, so no autonomy level can approve it for the agent.
  /\bgolem\s+(checkpoint|cp)\s+(restore|undo|drop|prune)\b/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+checkout\s+--\s/i,
  /\bdd\s+if=/i,
  /\bmkfs\b/i,
  /\btruncate\b/i,
  /\bdrop\s+table\b/i,
  /\bdel\s+\/[a-z]/i,
  /\brmdir\s+\/s/i,
  /\b>\s*\/dev\/sd/i,
];

/** Bash patterns that make a command OUTWARD (leaves the machine / publishes). */
const OUTWARD_BASH = [
  /\bgit\s+push\b/i,
  /\bgh\s+(pr|release|repo)\b/i,
  /\bnpm\s+publish\b/i,
  /\b(curl|wget)\b.*(-X\s*(POST|PUT|DELETE|PATCH)|--data|-d\s)/i,
  /\bssh\b/i,
  /\bscp\b/i,
  /\brsync\b.*::/i,
  /\bdeploy\b/i,
  /\bkubectl\s+(apply|delete)\b/i,
  /\bdocker\s+push\b/i,
  /\bterraform\s+apply\b/i,
];

/**
 * Shell metacharacters that void a safe-read classification: redirection can
 * truncate/overwrite files (`echo x > ~/.bashrc` leads with a "safe" token),
 * and separators/substitution can smuggle an arbitrary second command past a
 * safe-looking prefix (`ls -la; anything`). The destructive/outward pattern
 * lists only catch their specific shapes, so a command that composes at all is
 * `unknown` (gated), never `read`. `<` (input redirection) stays allowed.
 */
const SHELL_COMPOSITION_RE = /[;&|>`]|\$\(/;

function bashCommand(input: unknown): string | null {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const c = (input as Record<string, unknown>).command;
    if (typeof c === "string") return c;
  }
  return null;
}

/**
 * Output-compacting wrappers that rewrite a Bash command in front of Golem
 * (R8.12, spec Decision 53 tier-3a peers — currently RTK, whose PreToolUse hook
 * turns `git status` into `rtk git status`).
 *
 * Why this list exists: the danger patterns above are `\b`-anchored, so they
 * already see straight through a wrapper (`rtk git push` matches
 * `\bgit\s+push\b`) — but {@link SAFE_BASH} is `^`-anchored, so a wrapped *safe*
 * command stopped matching and fell through to `unknown`. The gate is
 * fail-closed, so nothing became less safe; it became **more annoying**, silently
 * turning previously auto-approved commands into prompts the moment a user
 * installed RTK. Only the safe-list check consults this, never the
 * destructive/outward checks, so unwrapping can never downgrade a classification.
 */
const OUTPUT_WRAPPERS = ["rtk"];

/**
 * Strip one known wrapper token from the front of `cmd`, or return it unchanged.
 *
 * Deliberately shallow and deliberately not applied to RTK's own
 * command-taking subcommands (`rtk proxy <cmd>`, `rtk err <cmd>`,
 * `rtk test <cmd>`, `rtk summary <cmd>`): those run an arbitrary inner command,
 * so unwrapping them to a bare subcommand name would be meaningless. They keep
 * falling through to `unknown` and stay gated.
 */
function stripOutputWrapper(cmd: string): string {
  for (const wrapper of OUTPUT_WRAPPERS) {
    const prefix = `${wrapper} `;
    if (cmd.toLowerCase().startsWith(prefix)) {
      return cmd.slice(prefix.length).trimStart();
    }
  }
  return cmd;
}

/** Classify a Bash command string. Escalate-only: outward/destructive win over safe. */
export function classifyBash(command: string): ActionClass {
  const cmd = command.trim();
  // Danger first, on the ORIGINAL string. These patterns are word-boundary
  // anchored, so a wrapper prefix cannot hide `git push` or `rm -rf` from them.
  if (OUTWARD_BASH.some((re) => re.test(cmd))) return "outward";
  if (DESTRUCTIVE_BASH.some((re) => re.test(cmd))) return "destructive";
  // Composition (redirection, chaining, pipes, substitution) can hide a write
  // or a second command behind a safe leading token — never classify it read.
  if (SHELL_COMPOSITION_RE.test(cmd)) return "unknown";
  if (SAFE_BASH.some((re) => re.test(cmd))) return "read";
  // R8.12: retry the safe-list against the unwrapped command, so an installed
  // output compactor does not turn auto-approved reads into prompts. Safe-list
  // only — the danger checks already ran on the original.
  const unwrapped = stripOutputWrapper(cmd);
  if (unwrapped !== cmd && SAFE_BASH.some((re) => re.test(unwrapped))) return "read";
  // A shell can do anything; an unrecognized command is gated, not assumed safe.
  return "unknown";
}

/**
 * Classify the `level` MCP tool by the level it requests. Setting the slider
 * is a persistent local settings WRITE for levels ≥ 1 — but level 0
 * ("passthrough") disables redaction entirely, so every later request would
 * leave the machine with secrets/PII unredacted. That consequence is the
 * `outward` class's territory (leaves the machine / hard to reverse), so a
 * level-0 request is always gated to the human at every autonomy level
 * (ADR-0002's never-auto set). An unparseable input fails closed as `unknown`.
 */
function classifyLevelTool(input: unknown): ActionClass {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const level = (input as Record<string, unknown>).level;
    if (typeof level === "number") {
      return level <= 0 ? "outward" : "write";
    }
  }
  return "unknown";
}

/** Classify a pending tool call into a risk class. Never throws. */
export function classifyAction(toolName: string, toolInput: unknown): ActionClass {
  if (OUTWARD_TOOLS.has(toolName)) return "outward";
  if (toolName === "Bash") {
    const cmd = bashCommand(toolInput);
    return cmd === null ? "unknown" : classifyBash(cmd);
  }
  if (toolName === "mcp__golem__level") return classifyLevelTool(toolInput);
  if (READ_TOOLS.has(toolName)) return "read";
  if (WRITE_TOOLS.has(toolName)) return "write";
  return "unknown";
}
