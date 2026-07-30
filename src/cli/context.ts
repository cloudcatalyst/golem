/**
 * R8.4 — render the context ledger (`golem stats --context`).
 *
 * The point is aimed pruning. "182k tokens in context" tells a reader nothing;
 * "61k of it is one Read result and 28k is 14 Greps" tells them what to drop, and
 * is what the `/golem/context-hygiene` skill needs in order to stop guessing.
 */

import type { ContextBucket, ContextLedger } from "../proxy/index.js";

const BUCKET_LABELS: Readonly<Record<ContextBucket, string>> = {
  tools: "tool definitions",
  system: "system prompt",
  userText: "user text",
  assistantText: "assistant text + tool calls",
  thinking: "thinking blocks",
  toolResult: "tool results",
  image: "images",
  other: "unclassified",
};

function num(value: number): string {
  return value.toLocaleString("en-US");
}

function bar(share: number, width = 24): string {
  const filled = Math.max(0, Math.min(width, Math.round(share * width)));
  return `${"#".repeat(filled)}${".".repeat(width - filled)}`;
}

function describeBlock(block: ContextLedger["largest"][number]): string {
  const where = block.messageIndex < 0 ? "request-level" : `message ${num(block.messageIndex)}`;
  const what = block.tool !== undefined ? `${block.tool} result` : BUCKET_LABELS[block.bucket];
  return `${what} (${where})`;
}

/**
 * Human-readable ledger. `null` means the proxy has not written one yet — said
 * plainly rather than rendered as an empty table.
 */
export function renderContextLedger(ledger: ContextLedger | null): string {
  const out: string[] = ["Context ledger — what you are paying to re-read", ""];

  if (ledger === null) {
    out.push("No ledger recorded yet.");
    out.push("  The proxy writes one per request; run some traffic through it, then retry.");
    out.push("  (Level 0 is a full bypass and is never recorded.)");
    return `${out.join("\n")}\n`;
  }

  out.push(
    `Captured ${ledger.capturedAt} · ${num(ledger.messages)} message(s) · ` +
      `~${num(ledger.totalTokens)} tokens in the request`,
  );
  out.push("");

  const entries = (Object.entries(ledger.buckets) as [ContextBucket, number][])
    .filter(([, tokens]) => tokens > 0)
    .sort((a, b) => b[1] - a[1]);
  const bucketTotal = entries.reduce((sum, [, tokens]) => sum + tokens, 0);

  if (entries.length === 0) {
    out.push("Nothing attributable in this request.");
  } else {
    out.push("By bucket:");
    for (const [bucket, tokens] of entries) {
      const share = bucketTotal === 0 ? 0 : tokens / bucketTotal;
      out.push(
        `  ${BUCKET_LABELS[bucket].padEnd(28)} ${num(tokens).padStart(9)}  ` +
          `${bar(share)} ${(share * 100).toFixed(1)}%`,
      );
    }
  }

  if (ledger.perTool.length > 0) {
    out.push("");
    out.push("Tool results by tool (the usual bulk of an agentic context):");
    for (const row of ledger.perTool) {
      out.push(
        `  ${row.tool.padEnd(28)} ${num(row.tokens).padStart(9)}  across ${num(row.results)} result(s)`,
      );
    }
  }

  if (ledger.largest.length > 0) {
    out.push("");
    out.push("Biggest single blocks:");
    for (const block of ledger.largest) {
      out.push(`  ${num(block.tokens).padStart(9)}  ${describeBlock(block)}`);
    }
  }

  out.push("");
  out.push("Every token here is re-sent and re-read on EVERY subsequent turn of this");
  out.push("conversation (notes §93: ~83% of input cost). Dropping a big block pays repeatedly.");
  out.push("Counts are estimates; no prompt content is stored in the ledger.");
  return `${out.join("\n")}\n`;
}
