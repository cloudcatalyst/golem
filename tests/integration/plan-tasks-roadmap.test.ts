/**
 * Drift guards over THIS repo's own plan tasks.
 *
 * `ROADMAP.md` is now a generated index (Decision 55), which only helps if it is
 * actually regenerated. These tests run against the real `docs/plan/` so a stale index,
 * a broken link, or a dangling dependency fails the suite instead of quietly misleading
 * whoever picks up the next task.
 *
 * They are integration tests rather than unit tests because the subject is the tree.
 */

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PLAN_INDEX_BEGIN,
  PLAN_INDEX_END,
  planTaskLink,
  renderPlanIndex,
  splicePlanIndex,
} from "../../src/cli/plan-index.js";
import { PlanTaskStore, TERMINAL_TASK_STATES } from "../../src/tasks/index.js";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const ROADMAP = path.join(REPO, "docs", "plan", "ROADMAP.md");

async function tasks() {
  return new PlanTaskStore(REPO).list();
}

describe("this repo's plan tasks", () => {
  it("parse, and there is more than one", async () => {
    const all = await tasks();
    expect(all.length).toBeGreaterThan(1);
  });

  it("all have a title and a non-empty brief", async () => {
    for (const task of await tasks()) {
      expect(task.title, `${task.id} has no title`).toBeDefined();
      expect(task.prompt.trim().length, `${task.id} has an empty brief`).toBeGreaterThan(200);
    }
  });

  it("every open task names either a gate or a blocker", async () => {
    // A task with neither cannot be finished honestly — this repo's precedent is that
    // the gate decides and REGRESSED is an acceptable answer (§89, §100).
    for (const task of await tasks()) {
      if (TERMINAL_TASK_STATES.has(task.state)) continue;
      const plan = task.plan;
      const hasOne = plan?.gate !== undefined || plan?.blocked !== undefined;
      expect(hasOne, `${task.id} has no gate and no blocked reason`).toBe(true);
    }
  });

  it("every open task says where its design lives, or is blocked on a decision", async () => {
    for (const task of await tasks()) {
      if (TERMINAL_TASK_STATES.has(task.state)) continue;
      const plan = task.plan;
      const grounded = plan?.design !== undefined || plan?.blocked !== undefined;
      expect(grounded, `${task.id} points at no design and gives no blocker`).toBe(true);
    }
  });

  it("has no duplicate ids", async () => {
    const ids = (await tasks()).map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has no dangling depends_on", async () => {
    const all = await tasks();
    const ids = new Set(all.map((t) => t.id));
    for (const task of all) {
      for (const dep of task.plan?.dependsOn ?? []) {
        expect(ids.has(dep), `${task.id} depends on unknown task "${dep}"`).toBe(true);
      }
    }
  });

  it("has no dependency cycles", async () => {
    const all = await tasks();
    const deps = new Map(all.map((t) => [t.id, t.plan?.dependsOn ?? []]));
    const state = new Map<string, "visiting" | "done">();
    const walk = (id: string, trail: string[]): void => {
      if (state.get(id) === "done") return;
      expect(state.get(id), `dependency cycle: ${[...trail, id].join(" -> ")}`).not.toBe(
        "visiting",
      );
      state.set(id, "visiting");
      for (const dep of deps.get(id) ?? []) walk(dep, [...trail, id]);
      state.set(id, "done");
    };
    for (const task of all) walk(task.id, []);
  });

  it("each task's document exists at the path the index links to", async () => {
    for (const task of await tasks()) {
      const file = path.join(REPO, "docs", "plan", planTaskLink(task));
      await expect(
        access(file),
        `${task.id} link points at a missing file`,
      ).resolves.toBeUndefined();
    }
  });

  it("a user-owned task is either blocked or explains itself — agents must not pick it up", async () => {
    for (const task of await tasks()) {
      if (task.plan?.owner !== "user" || TERMINAL_TASK_STATES.has(task.state)) continue;
      expect(task.plan.blocked, `${task.id} is owner:user but gives no reason`).toBeDefined();
    }
  });
});

describe("ROADMAP.md's generated index", () => {
  it("carries the splice markers", async () => {
    const doc = await readFile(ROADMAP, "utf8");
    expect(doc).toContain(PLAN_INDEX_BEGIN);
    expect(doc).toContain(PLAN_INDEX_END);
    expect(doc.indexOf(PLAN_INDEX_BEGIN)).toBeLessThan(doc.indexOf(PLAN_INDEX_END));
  });

  it("is up to date — run `golem task index --write` if this fails", async () => {
    // The point of generating it is that it cannot drift. Without this assertion the
    // roadmap could silently describe a task set that no longer exists.
    const doc = await readFile(ROADMAP, "utf8");
    const { text, spliced } = splicePlanIndex(doc, renderPlanIndex(await tasks()));
    expect(spliced).toBe(true);
    expect(text).toBe(doc);
  });

  it("does not restate task detail — the table links, it does not duplicate", async () => {
    const doc = await readFile(ROADMAP, "utf8");
    // The roadmap should be an index: no "## Out of scope"-style task sections in it.
    expect(doc).not.toContain("## Out of scope");
    expect(doc).toContain("Edit the task documents, not this table");
  });
});
