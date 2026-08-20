/**
 * Workstream B — the census reads the live MCP server, so it cannot drift from
 * what is actually sent on the wire (the §88 hand census already had).
 */

import { describe, expect, it } from "vitest";
import { golemToolCensus } from "../../../src/tools/index.js";

// The 7 Decision 27/35 tools plus devices + snooze, the two wiki tools, and
// R8.5's `code` — which is ONE tool with a `mode` parameter, never one tool per
// capability, because a definition bills on every request (§88/§100).
const EXPECTED_TOOLS = [
  "code",
  "coder",
  "devices",
  "expand",
  "fetch",
  "ingest",
  "search",
  "snooze",
  "stats",
  "wiki_read",
  "wiki_upsert",
] as const;

describe("golemToolCensus", () => {
  it("lists every registered tool with a non-empty description", async () => {
    const census = await golemToolCensus();
    expect([...census.tools].map((t) => t.name).sort()).toStrictEqual([...EXPECTED_TOOLS]);
    for (const tool of census.tools) {
      expect(tool.description.length, `${tool.name} has no description`).toBeGreaterThan(0);
      expect(tool.descriptionTokens).toBeGreaterThan(0);
      // A definition is always bigger than its description — it carries the schema.
      expect(tool.definitionTokens).toBeGreaterThan(tool.descriptionTokens);
    }
  });

  it("totals match the sum of the parts and stay in the measured band", async () => {
    const census = await golemToolCensus();
    expect(census.descriptionTokens).toBe(
      census.tools.reduce((n, t) => n + t.descriptionTokens, 0),
    );
    expect(census.definitionTokens).toBe(census.tools.reduce((n, t) => n + t.definitionTokens, 0));
    // §88 measured ~902 description tokens by hand on 2026-07-30 and this
    // reproduces it. The band is wide on purpose: it should catch a description
    // doubling in size (as `level` accidentally did), not fail on a typo fix.
    expect(census.descriptionTokens).toBeGreaterThan(700);
    expect(census.descriptionTokens).toBeLessThan(1200);
  });

  it("sorts by descending description size, so the shrink targets come first", async () => {
    const census = await golemToolCensus();
    const sizes = census.tools.map((t) => t.descriptionTokens);
    expect([...sizes]).toStrictEqual([...sizes].sort((a, b) => b - a));
  });
});
