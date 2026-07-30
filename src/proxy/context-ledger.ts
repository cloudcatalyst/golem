/**
 * R8.4 — the context ledger: what the context window is actually made of.
 *
 * verification-notes §93 measured where this project's input cost really goes:
 * with a 98.4% cache hit rate, **~83% of it is re-reading an already-cached
 * context**, turn after turn. That reframes the useful question from "did the
 * cache hit?" to "*what* am I paying to re-read?" — and nothing could answer it,
 * because the only component that sees the whole request is the proxy.
 *
 * So: attribute every token in the outgoing request to a bucket, name the biggest
 * individual blocks, and attribute `tool_result` blocks to the **tool that
 * produced them** by resolving `tool_use_id` back through the assistant turns.
 * "61k tokens of Read results and 28k across 14 Greps" is actionable; "182k
 * tokens in context" is not.
 *
 * Consumed by `golem stats --context` and, through it, the
 * `/golem/context-hygiene` skill — which until now had to reason about context
 * bloat blind.
 *
 * **R8.S1 extension.** The first capture (§95) made the `tools` block the largest
 * single block in the request, and the roadmap promoted tool-schema shrinking on
 * that number. But an aggregate is a ceiling, not a lever: it does not say whether
 * the tokens are Golem's, another MCP server's, or the client's built-ins, nor
 * whether they sit in prose or in `input_schema`. `buildToolsBlock` decomposes it
 * per definition so the shrinker is aimed at what Golem actually owns.
 *
 * **No prompt content, ever.** Same standard as `cache-prefix.ts`: the ledger
 * holds token counts, roles, block types, and tool *names*. A tool name is a
 * schema identifier, not user data. Nothing here is a place to put text.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { estimateTokens } from "../compression/tokens.js";

/** Buckets a request's tokens are attributed to. Exhaustive by construction. */
export const CONTEXT_BUCKETS = [
  "tools",
  "system",
  "userText",
  "assistantText",
  "thinking",
  "toolResult",
  "image",
  "other",
] as const;

export type ContextBucket = (typeof CONTEXT_BUCKETS)[number];

const bucketTotalsSchema = z.object({
  tools: z.number(),
  system: z.number(),
  userText: z.number(),
  assistantText: z.number(),
  thinking: z.number(),
  toolResult: z.number(),
  image: z.number(),
  other: z.number(),
});

const largestBlockSchema = z.object({
  /** Index in `messages`, or -1 for the request-level `tools` / `system` blocks. */
  messageIndex: z.number(),
  bucket: z.enum(CONTEXT_BUCKETS),
  tokens: z.number(),
  /** Resolved tool name for a `tool_result`, when the matching `tool_use` was found. */
  tool: z.string().optional(),
});

const perToolSchema = z.object({
  tool: z.string(),
  results: z.number(),
  tokens: z.number(),
});

/**
 * Where a tool definition came from, so the `tools` block can be split into the
 * part Golem owns and the part it does not.
 *
 * §95 measured the block at 18,827 tokens and R8.S1 inherited it as a ceiling —
 * but a ceiling is not a lever. Golem's own 11 tools are ~3.8k of that; the rest
 * is Claude Code's built-ins and whatever other MCP servers the user connected,
 * and rewriting either of those from the proxy is a fidelity change, not a dial.
 * Naming the owner is therefore the first thing this decomposition has to do.
 */
export const TOOL_ORIGINS = ["golem", "mcp", "builtin"] as const;

export type ToolOrigin = (typeof TOOL_ORIGINS)[number];

const toolDefSchema = z.object({
  name: z.string(),
  origin: z.enum(TOOL_ORIGINS),
  /** ≈tokens for the whole serialized definition. */
  tokens: z.number(),
  descriptionTokens: z.number(),
  /** `input_schema` (or `inputSchema`) only. §89 found this is the bigger half. */
  schemaTokens: z.number(),
  /**
   * Everything else in the definition — `name`, `type`, and any key the client
   * forwarded beyond description+schema (`title`, `annotations`, `outputSchema`).
   * Kept as its own number because "does the wire carry the MCP metadata?" is a
   * question with a cheap answer and an expensive assumption.
   */
  otherTokens: z.number(),
  /** True when the definition carries `defer_loading` (native tool search, §89). */
  deferred: z.boolean(),
});

const toolsBlockSchema = z.object({
  count: z.number(),
  tokens: z.number(),
  descriptionTokens: z.number(),
  schemaTokens: z.number(),
  otherTokens: z.number(),
  /** How many definitions set `defer_loading` — those are excluded from the cached prefix. */
  deferred: z.number(),
  byOrigin: z.array(
    z.object({ origin: z.enum(TOOL_ORIGINS), count: z.number(), tokens: z.number() }),
  ),
  /** Every definition, largest first. Bounded by the client's own tool count. */
  tools: z.array(toolDefSchema),
});

/**
 * The ledger's content, without a timestamp.
 *
 * Split out because the pipeline is under a standing obligation not to read the
 * wall clock (see native-lossless.ts's determinism notes) — so it builds the core
 * and the CLI layer stamps `capturedAt`, matching the existing "nowIso is
 * injected" convention in `recordPipelineEvent`.
 */
export const contextLedgerCoreSchema = z.object({
  /** Estimated tokens for the whole serialized request. */
  totalTokens: z.number(),
  messages: z.number(),
  buckets: bucketTotalsSchema,
  /** Biggest individual blocks, largest first. */
  largest: z.array(largestBlockSchema),
  /** `tool_result` tokens grouped by the tool that produced them, largest first. */
  perTool: z.array(perToolSchema),
  /**
   * The `tools` block decomposed per definition. Optional so a ledger written by
   * an older build still parses (`readContextLedger` rejects on schema drift, and
   * losing the whole ledger over an added field would be a regression).
   */
  toolsBlock: toolsBlockSchema.optional(),
});

export const contextLedgerSchema = contextLedgerCoreSchema.extend({
  capturedAt: z.string(),
});

export type ContextLedgerCore = z.infer<typeof contextLedgerCoreSchema>;
export type ContextLedger = z.infer<typeof contextLedgerSchema>;
export type ContextLargestBlock = z.infer<typeof largestBlockSchema>;
export type ContextPerTool = z.infer<typeof perToolSchema>;
export type ContextToolDef = z.infer<typeof toolDefSchema>;
export type ContextToolsBlock = z.infer<typeof toolsBlockSchema>;

/** How many "biggest block" rows to keep. Enough to act on, small enough to read. */
const LARGEST_KEEP = 8;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function tokensOf(value: unknown): number {
  if (value === undefined) return 0;
  return estimateTokens(typeof value === "string" ? value : JSON.stringify(value));
}

/**
 * Map every `tool_use_id` in the conversation to the tool that produced it.
 *
 * `tool_result` blocks carry only the id, so without this pass the largest
 * consumer of context in an agentic session is an anonymous blob. Built from the
 * assistant turns in the same request, which is where the `tool_use` blocks live.
 */
function toolNamesById(messages: readonly unknown[]): Map<string, string> {
  const byId = new Map<string, string>();
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "tool_use") continue;
      if (typeof block.id === "string" && typeof block.name === "string") {
        byId.set(block.id, block.name);
      }
    }
  }
  return byId;
}

/**
 * Attribute one tool definition to its owner by name.
 *
 * Claude Code namespaces every MCP tool as `mcp__<server>__<tool>`, so the prefix
 * is the ownership signal and no configuration is needed to read it. Anything
 * without the prefix is a client built-in (`Read`, `Bash`, …) or a server tool
 * (`tool_search_tool_bm25_20251119`) — either way, not Golem's to rewrite.
 */
export function toolOrigin(name: string): ToolOrigin {
  if (name.startsWith("mcp__golem__")) return "golem";
  if (name.startsWith("mcp__")) return "mcp";
  return "builtin";
}

/**
 * Decompose the request's `tools` array into per-definition token counts.
 *
 * Splits each definition three ways — description / input schema / everything
 * else — because the three have different owners and different remedies. Returns
 * undefined when there is no usable `tools` array, so the ledger records absence
 * rather than a row of zeros.
 *
 * Accepts both `input_schema` (the Anthropic wire name) and `inputSchema` (the
 * MCP name), since the same builder is exercised against both in tests and a
 * translated upstream (R6.1) may present either.
 */
function buildToolsBlock(value: unknown): ContextToolsBlock | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;

  const tools: ContextToolDef[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) {
      // Not a definition we can decompose; still counted, still honest about it.
      tools.push({
        name: "(unrecognised)",
        origin: "builtin",
        tokens: tokensOf(raw),
        descriptionTokens: 0,
        schemaTokens: 0,
        otherTokens: tokensOf(raw),
        deferred: false,
      });
      continue;
    }
    const name = typeof raw.name === "string" ? raw.name : "(unnamed)";
    const tokens = tokensOf(raw);
    const descriptionTokens = tokensOf(raw.description);
    const schemaTokens = tokensOf(raw.input_schema ?? raw.inputSchema);
    tools.push({
      name,
      origin: toolOrigin(name),
      tokens,
      descriptionTokens,
      schemaTokens,
      // Clamped at 0: the parts are estimated independently of the whole, so
      // rounding must never produce a negative remainder.
      otherTokens: Math.max(0, tokens - descriptionTokens - schemaTokens),
      deferred: raw.defer_loading === true,
    });
  }

  tools.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));

  const byOrigin = TOOL_ORIGINS.map((origin) => {
    const owned = tools.filter((t) => t.origin === origin);
    return {
      origin,
      count: owned.length,
      tokens: owned.reduce((n, t) => n + t.tokens, 0),
    };
  }).filter((row) => row.count > 0);

  return {
    count: tools.length,
    // The block total, not the sum of definitions — JSON array framing is real.
    tokens: tokensOf(value),
    descriptionTokens: tools.reduce((n, t) => n + t.descriptionTokens, 0),
    schemaTokens: tools.reduce((n, t) => n + t.schemaTokens, 0),
    otherTokens: tools.reduce((n, t) => n + t.otherTokens, 0),
    deferred: tools.filter((t) => t.deferred).length,
    byOrigin,
    tools,
  };
}

/** Classify one content block into a bucket. */
function bucketForBlock(block: Record<string, unknown>, role: unknown): ContextBucket {
  switch (block.type) {
    case "text":
      return role === "assistant" ? "assistantText" : "userText";
    case "thinking":
    case "redacted_thinking":
      return "thinking";
    case "tool_result":
      return "toolResult";
    case "tool_use":
      // A tool_use block is the assistant's own output (name + arguments).
      return "assistantText";
    case "image":
      return "image";
    default:
      return "other";
  }
}

/**
 * Attribute an outgoing Messages request into buckets, biggest blocks, and
 * per-tool `tool_result` totals.
 *
 * Pure, and tolerant of anything: an unrecognised shape lands in `other` rather
 * than throwing, because this runs on the request path.
 */
export function buildContextLedger(body: Readonly<Record<string, unknown>>): ContextLedgerCore {
  const buckets: Record<ContextBucket, number> = {
    tools: 0,
    system: 0,
    userText: 0,
    assistantText: 0,
    thinking: 0,
    toolResult: 0,
    image: 0,
    other: 0,
  };
  const largest: ContextLargestBlock[] = [];
  const perToolTokens = new Map<string, { results: number; tokens: number }>();

  // Request-level blocks. `messageIndex: -1` marks "not in the messages array".
  buckets.tools = tokensOf(body.tools);
  if (buckets.tools > 0) {
    largest.push({ messageIndex: -1, bucket: "tools", tokens: buckets.tools });
  }
  buckets.system = tokensOf(body.system);
  if (buckets.system > 0) {
    largest.push({ messageIndex: -1, bucket: "system", tokens: buckets.system });
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const toolNames = toolNamesById(messages);

  for (const [index, message] of messages.entries()) {
    if (!isRecord(message)) {
      const tokens = tokensOf(message);
      buckets.other += tokens;
      largest.push({ messageIndex: index, bucket: "other", tokens });
      continue;
    }

    const role = message.role;

    // A string `content` is plain text for the message's role.
    if (typeof message.content === "string") {
      const tokens = tokensOf(message.content);
      const bucket: ContextBucket = role === "assistant" ? "assistantText" : "userText";
      buckets[bucket] += tokens;
      largest.push({ messageIndex: index, bucket, tokens });
      continue;
    }

    if (!Array.isArray(message.content)) {
      const tokens = tokensOf(message.content);
      buckets.other += tokens;
      continue;
    }

    for (const rawBlock of message.content) {
      if (!isRecord(rawBlock)) {
        buckets.other += tokensOf(rawBlock);
        continue;
      }
      const bucket = bucketForBlock(rawBlock, role);
      const tokens = tokensOf(rawBlock);
      buckets[bucket] += tokens;

      const tool =
        bucket === "toolResult" && typeof rawBlock.tool_use_id === "string"
          ? toolNames.get(rawBlock.tool_use_id)
          : undefined;

      if (tool !== undefined) {
        const acc = perToolTokens.get(tool) ?? { results: 0, tokens: 0 };
        perToolTokens.set(tool, { results: acc.results + 1, tokens: acc.tokens + tokens });
      }

      largest.push({
        messageIndex: index,
        bucket,
        tokens,
        ...(tool !== undefined && { tool }),
      });
    }
  }

  largest.sort((a, b) => b.tokens - a.tokens);

  const perTool: ContextPerTool[] = [...perToolTokens.entries()]
    .map(([tool, v]) => ({ tool, results: v.results, tokens: v.tokens }))
    .sort((a, b) => b.tokens - a.tokens);

  const toolsBlock = buildToolsBlock(body.tools);

  return {
    // The whole serialized body, so the buckets can be compared against a real
    // total rather than their own sum (which omits JSON framing and top-level keys).
    totalTokens: estimateTokens(JSON.stringify(body)),
    messages: messages.length,
    buckets,
    largest: largest.slice(0, LARGEST_KEEP),
    perTool,
    ...(toolsBlock !== undefined && { toolsBlock }),
  };
}

/** `.golem/state/context-ledger.json` for a project. */
export function contextLedgerPath(projectDir: string): string {
  return path.join(projectDir, ".golem", "state", "context-ledger.json");
}

/**
 * Persist the latest ledger (atomic temp+rename), latest-only.
 *
 * Deliberately NOT a telemetry event: one of these per request would be a large
 * durable write for a value only the most recent copy of which is useful, and the
 * per-request history is already covered by the savings/usage events. Fail-open —
 * the caller ignores errors, exactly like `writeLimitState`.
 *
 * Never creates `.golem/` where the proxy would not already have created it (the
 * proxy only runs inside an initialized project — see the statusline footprint
 * rule, debrief 2026-07-23).
 */
export async function writeContextLedger(
  projectDir: string,
  core: ContextLedgerCore,
  capturedAt: string,
): Promise<void> {
  const ledger: ContextLedger = { ...core, capturedAt };
  const file = contextLedgerPath(projectDir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

/** Read the latest persisted ledger, or null (missing/corrupt/schema drift). */
export async function readContextLedger(projectDir: string): Promise<ContextLedger | null> {
  let raw: string;
  try {
    raw = await readFile(contextLedgerPath(projectDir), "utf8");
  } catch {
    return null;
  }
  try {
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = contextLedgerSchema.safeParse(JSON.parse(stripped));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
