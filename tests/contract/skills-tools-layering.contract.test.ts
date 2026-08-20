/**
 * R9.11 — skills orchestrate, tools execute. A skill never reimplements a tool.
 *
 * The rule is recorded in `docs/golem-spec.md` §2.1 (integration surfaces, where the
 * proxy/MCP split is already spelled out — the layering rule is the same argument one
 * level down, so it belongs beside it rather than in a Decision of its own). This file is
 * the part that keeps it true: for every installed `SKILL.md`, a `golem <verb>`
 * shell invocation whose verb names a capability an MCP tool already provides is a
 * violation — unless the skill declares a marked exception saying why.
 *
 * ## Why it matters enough to test
 *
 * Four properties of an MCP tool that a skill-plus-shell-script cannot reproduce:
 *
 * 1. **Portability.** §R6.1 extends the pipeline past Claude Code. MCP tools work
 *    in any MCP client; `SKILL.md` is one client's file format. Shelling out to
 *    `golem search` from a skill binds a core surface to Claude Code.
 * 2. **Hook enforcement keys on tool NAMES.** Snooze (Decision 45) denies every
 *    tool call outside `PARK_EXEMPT_TOOLS`; the local-coder PreToolUse gate
 *    distinguishes `coder` from a hand-written Write/Edit; the CCR PostToolUse hook
 *    emits refs `expand` consumes. A Bash-invoked script is a `Bash` call — every
 *    one of those gates would have to parse command lines instead.
 * 3. **Round-trip and typing.** Skill path = read SKILL.md → Bash spawn → node cold
 *    start → re-load the vector index → parse stdout prose. Tool path = one stdio
 *    call into a warm server already holding the index, Zod-validated in and
 *    structured out. `search`/`fetch`/`expand` are called reflexively many times a
 *    session; this is the whole latency budget.
 * 4. **Permissioning.** `wiki_upsert` as a tool carries its own allow/deny. As a
 *    script it collapses into blanket `Bash` permission, which is strictly worse.
 *
 * The converse also holds, and is why the check is one-directional: a capability
 * that is rare, procedural, and needs prose about *when* belongs in a skill — one
 * that CALLS the tool.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { P0_SKILLS } from "../../src/cli/skills.js";
import { createGolemMcpServer, createStandaloneDeps } from "../../src/mcp/index.js";

/**
 * CLI verbs that are the twin of an MCP tool under a different name.
 *
 * R11.1 emptied this table. Its one entry mapped the `slider` skill's
 * `golem slider 0` to its tool twin `level` — and ADR-0004 retired both, so the
 * only CLI verb that had a differently-named tool no longer exists. The table
 * stays because the mechanism is the point: the next such pair must be declared
 * here rather than slipping past a literal name-match.
 */
const CLI_VERB_TOOL_TWINS: Readonly<Record<string, string>> = {};

/**
 * Verbs that share a prefix with a tool but are a DIFFERENT capability, so they
 * are not violations however they are spelled.
 *
 * `golem wiki check|distill|promote` lint, summarise and publish; the `wiki_read`
 * and `wiki_upsert` tools read and write one page. Same noun, different verbs.
 */
const NOT_TOOL_TWINS: readonly string[] = ["wiki"];

/** `golem <verb>` occurrences in a skill body, deduplicated. */
function golemInvocations(body: string): string[] {
  return [...new Set([...body.matchAll(/\bgolem\s+([a-z][a-z0-9_-]*)/g)].map((m) => m[1] ?? ""))];
}

/**
 * Verbs a skill has explicitly excused, from
 * `<!-- golem:layering-exception <verb> — <reason> -->`.
 *
 * The reason is REQUIRED: an exception without one is how a rule gets defeated by
 * the first person who finds it inconvenient. The marker is an HTML comment so it
 * is invisible to the model reading the skill but plain in a diff.
 */
function declaredExceptions(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(
    /<!--\s*golem:layering-exception\s+([a-z][a-z0-9_-]*)\s*([\s\S]*?)-->/g,
  )) {
    const verb = m[1] ?? "";
    const reason = (m[2] ?? "")
      .replace(/\s+/g, " ")
      .replace(/^[—\-:\s]+/, "")
      .trim();
    out.set(verb, reason);
  }
  return out;
}

describe("skills-vs-tools layering (R9.11)", () => {
  let toolNames: Set<string>;

  beforeAll(async () => {
    // The LIVE registry, not a hand-kept list — a hand-kept list is the thing that
    // rots (see R10.11). Standalone deps register every tool that needs no
    // injected service; the ones that do are added below from their known names.
    const server = createGolemMcpServer(createStandaloneDeps());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "layering-check", version: "0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const { tools } = await client.listTools();
    await client.close();
    toolNames = new Set(tools.map((t) => t.name));
    // Service-gated tools are absent from a standalone server but are still tools,
    // and a skill shelling out to their CLI twin is still a violation.
    for (const gated of [
      "search",
      "fetch",
      "ingest",
      "coder",
      "code",
      "wiki_read",
      "wiki_upsert",
    ]) {
      toolNames.add(gated);
    }
  });

  /** The premise: an empty registry or empty skill set would pass by vacuity. */
  it("has both surfaces to compare", () => {
    expect(toolNames.size).toBeGreaterThan(8);
    expect(Object.keys(P0_SKILLS).length).toBeGreaterThan(8);
    // The twin map must name real tools, or it silently stops mapping anything.
    for (const tool of Object.values(CLI_VERB_TOOL_TWINS)) {
      expect(toolNames, `CLI_VERB_TOOL_TWINS maps to "${tool}", which is not a tool`).toContain(
        tool,
      );
    }
  });

  it("no skill shells out to a capability an MCP tool already provides", () => {
    const violations: string[] = [];
    for (const [name, body] of Object.entries(P0_SKILLS)) {
      const excused = declaredExceptions(body);
      for (const verb of golemInvocations(body)) {
        if (NOT_TOOL_TWINS.includes(verb)) continue;
        const tool = CLI_VERB_TOOL_TWINS[verb] ?? (toolNames.has(verb) ? verb : null);
        if (tool === null) continue; // no tool covers this verb — a skill may call it
        if (excused.has(verb)) continue;
        violations.push(
          `/golem/${name}: shells out to \`golem ${verb}\`, but the \`${tool}\` MCP tool ` +
            "already provides it. Call the tool, or declare " +
            `\`<!-- golem:layering-exception ${verb} — <why> -->\` in the skill.`,
        );
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("every declared exception gives a reason, and excuses something real", () => {
    for (const [name, body] of Object.entries(P0_SKILLS)) {
      for (const [verb, reason] of declaredExceptions(body)) {
        expect(
          reason.length,
          `/golem/${name}: exception for \`${verb}\` has no reason`,
        ).toBeGreaterThan(20);
        // A stale exception is worse than none: it reads as a live carve-out for a
        // rule that no longer applies. If the skill stopped invoking the verb, the
        // marker has to go.
        expect(
          golemInvocations(body),
          `/golem/${name}: excuses \`golem ${verb}\` but never invokes it — drop the marker`,
        ).toContain(verb);
      }
    }
  });

  /**
   * The other half of the rule. Skills are allowed — encouraged — to name tools,
   * and a skill set that named none would mean the orchestration layer had drifted
   * into doing the work itself.
   */
  it("skills do orchestrate tools rather than reimplementing them", () => {
    const bodies = Object.values(P0_SKILLS).join("\n");
    for (const tool of ["level", "stats", "expand", "search", "coder"]) {
      expect(bodies, `no skill mentions the \`${tool}\` tool`).toContain(`\`${tool}\``);
    }
  });
});
