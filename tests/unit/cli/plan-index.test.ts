/**
 * The generated roadmap index.
 *
 * Two properties carry it: grouping must never *hide* a task (the roadmap's own
 * "visible, not lost" rule for blocked items), and the splice must be idempotent —
 * a regeneration that shifted content every run would make the roadmap diff noise.
 */

import { describe, expect, it } from "vitest";
import {
  groupPlanTasks,
  PLAN_INDEX_BEGIN,
  PLAN_INDEX_END,
  renderPlanIndex,
  renderPlanSummary,
  splicePlanIndex,
} from "../../../src/cli/plan-index.js";
import { parsePlanTask } from "../../../src/tasks/index.js";

function task(
  id: string,
  extra: Record<string, string> = {},
  state = "queued",
  title = `goal for ${id}`,
) {
  const lines = Object.entries(extra).map(([k, v]) => `${k}: ${v}`);
  return parsePlanTask(
    `---\ntask: ${id}\ntitle: ${title}\nstate: ${state}\n${lines.join("\n")}\n---\n\nbody\n`,
  );
}

describe("groupPlanTasks", () => {
  it("splits ready, blocked and done", () => {
    const { ready, blocked, done } = groupPlanTasks([
      task("A"),
      task("B", { blocked: "needs hardware" }),
      task("C", {}, "done"),
      task("D", {}, "cancelled"),
    ]);
    expect(ready.map((t) => t.id)).toStrictEqual(["A"]);
    expect(blocked.map((t) => t.id)).toStrictEqual(["B"]);
    // Cancelled is terminal too — it belongs with done, not with ready.
    expect(done.map((t) => t.id)).toStrictEqual(["C", "D"]);
  });

  it("treats an unfinished dependency as blocking", () => {
    const { ready, blocked } = groupPlanTasks([task("A"), task("B", { depends_on: "[A]" })]);
    expect(ready.map((t) => t.id)).toStrictEqual(["A"]);
    expect(blocked.map((t) => t.id)).toStrictEqual(["B"]);
  });

  it("unblocks once the dependency is done", () => {
    const { ready } = groupPlanTasks([task("A", {}, "done"), task("B", { depends_on: "[A]" })]);
    expect(ready.map((t) => t.id)).toStrictEqual(["B"]);
  });

  it("does not block on a dependency that does not exist", () => {
    // A typo'd or already-retired dependency must not silently park a task forever.
    const { ready } = groupPlanTasks([task("B", { depends_on: "[GONE]" })]);
    expect(ready.map((t) => t.id)).toStrictEqual(["B"]);
  });

  it("keeps a blocked task in a non-terminal state — blocked is metadata, not a state", () => {
    const { blocked } = groupPlanTasks([task("B", { blocked: "no keys" })]);
    expect(blocked[0]?.state).toBe("queued");
  });

  it("loses nothing: every task lands in exactly one group", () => {
    const all = [
      task("A"),
      task("B", { blocked: "x" }),
      task("C", {}, "done"),
      task("D", { depends_on: "[A]" }),
      task("E", {}, "failed"),
    ];
    const { ready, blocked, done } = groupPlanTasks(all);
    expect(ready.length + blocked.length + done.length).toBe(all.length);
  });
});

describe("renderPlanIndex", () => {
  const tasks = [
    task("R8.5", { owner: "agent", size: "L", gate: "harness decides" }),
    task("R7.5", { owner: "user", size: "M", blocked: "credentialed act" }),
    task("R6.4", {}, "done"),
  ];

  it("emits markers, counts, and a link per task", () => {
    const out = renderPlanIndex(tasks);
    expect(out.startsWith(PLAN_INDEX_BEGIN)).toBe(true);
    expect(out.trimEnd().endsWith(PLAN_INDEX_END)).toBe(true);
    expect(out).toContain("1 ready, 1 blocked, 1 done");
    expect(out).toContain("[R8.5](tasks/R8.5.md)");
    expect(out).toContain("[R7.5](tasks/R7.5.md)");
  });

  it("tells the reader to edit the task, not the table", () => {
    expect(renderPlanIndex(tasks)).toContain("Edit the task documents, not this table");
  });

  it("shows the blocker for a blocked task and the gate for a ready one", () => {
    const out = renderPlanIndex(tasks);
    expect(out).toContain("credentialed act");
    expect(out).toContain("harness decides");
  });

  it("renders well-formed table rows", () => {
    for (const line of renderPlanIndex(tasks).split("\n")) {
      if (!line.startsWith("|") || line.includes("---")) continue;
      // A row must open and close with a pipe and have no stray leading space.
      expect(line).toMatch(/^\| .* \|$/);
    }
  });

  it("emits markers even with no tasks at all, so the region stays splice-able", () => {
    const out = renderPlanIndex([]);
    expect(out).toContain(PLAN_INDEX_BEGIN);
    expect(out).toContain(PLAN_INDEX_END);
    expect(out).toContain("Nothing ready");
    expect(out).toContain("Nothing blocked");
  });

  it("omits the Closed section when nothing is closed", () => {
    expect(renderPlanIndex([task("A")])).not.toContain("### Closed");
  });

  it("escapes a pipe in a title rather than breaking the table", () => {
    const out = renderPlanIndex([task("A", {}, "queued", "a | b")]);
    expect(out).toContain("a \\| b");
  });
});

describe("splicePlanIndex", () => {
  const doc = `# Roadmap\n\n## Open work\n\n${PLAN_INDEX_BEGIN}\nold\n${PLAN_INDEX_END}\n\n## After\n`;

  it("replaces the region and leaves the surrounding document alone", () => {
    const { text, spliced } = splicePlanIndex(doc, renderPlanIndex([task("A")]));
    expect(spliced).toBe(true);
    expect(text).toContain("# Roadmap");
    expect(text).toContain("## After");
    expect(text).not.toContain("old");
    expect(text).toContain("[A](tasks/A.md)");
  });

  it("is idempotent — a second splice of the same render changes nothing", () => {
    const rendered = renderPlanIndex([task("A")]);
    const once = splicePlanIndex(doc, rendered).text;
    expect(splicePlanIndex(once, rendered).text).toBe(once);
  });

  it("refuses rather than appending a second index when the markers are missing", () => {
    const { text, spliced } = splicePlanIndex("# No markers\n", renderPlanIndex([task("A")]));
    expect(spliced).toBe(false);
    expect(text).toBe("# No markers\n");
  });

  it("refuses when the markers are in the wrong order", () => {
    const inverted = `${PLAN_INDEX_END}\nx\n${PLAN_INDEX_BEGIN}\n`;
    expect(splicePlanIndex(inverted, "new").spliced).toBe(false);
  });
});

describe("renderPlanSummary", () => {
  it("leads with the counts and names the blocker", () => {
    const out = renderPlanSummary([
      task("R8.5", { size: "L" }),
      task("R7.5", { owner: "user", blocked: "needs credentials" }),
    ]);
    expect(out).toContain("1 ready, 1 blocked, 0 done");
    expect(out).toContain("R8.5");
    expect(out).toContain("[blocked: needs credentials]");
  });

  it("omits an empty group instead of printing an empty heading", () => {
    const out = renderPlanSummary([task("A")]);
    expect(out).toContain("ready:");
    expect(out).not.toContain("blocked:");
  });
});
