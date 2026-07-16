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
  // Golem read-only MCP tools (short verb names, Decision 27).
  "mcp__golem__search",
  "mcp__golem__fetch",
  "mcp__golem__stats",
  "mcp__golem__expand",
  "mcp__golem__level",
  "mcp__golem__devices",
  "mcp__golem__wiki_read",
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

function bashCommand(input: unknown): string | null {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const c = (input as Record<string, unknown>).command;
    if (typeof c === "string") return c;
  }
  return null;
}

/** Classify a Bash command string. Escalate-only: outward/destructive win over safe. */
export function classifyBash(command: string): ActionClass {
  const cmd = command.trim();
  if (OUTWARD_BASH.some((re) => re.test(cmd))) return "outward";
  if (DESTRUCTIVE_BASH.some((re) => re.test(cmd))) return "destructive";
  if (SAFE_BASH.some((re) => re.test(cmd))) return "read";
  // A shell can do anything; an unrecognized command is gated, not assumed safe.
  return "unknown";
}

/** Classify a pending tool call into a risk class. Never throws. */
export function classifyAction(toolName: string, toolInput: unknown): ActionClass {
  if (OUTWARD_TOOLS.has(toolName)) return "outward";
  if (toolName === "Bash") {
    const cmd = bashCommand(toolInput);
    return cmd === null ? "unknown" : classifyBash(cmd);
  }
  if (READ_TOOLS.has(toolName)) return "read";
  if (WRITE_TOOLS.has(toolName)) return "write";
  return "unknown";
}
