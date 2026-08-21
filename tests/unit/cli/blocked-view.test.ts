/**
 * R12.2 — one blocked read model, four renderers.
 *
 * The projection (`blockedView`) is shared by `/api/state` and
 * `golem status --json` precisely so the dashboard, the VS Code panel and a
 * paired device cannot each invent a shape. These tests pin the projection, and
 * then pin that the dashboard banner and the extension's panel banner both
 * render the SAME resolved block — including the `abandoned` case, which is the
 * one the old flag could not express.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { blockedView } from "../../../src/cli/blocked-view.js";
import { blockedBanner } from "../../../src/dashboard/server.js";
import { resolveBlock, type SessionState } from "../../../src/hooks/index.js";

const require_ = createRequire(import.meta.url);
const render = require_(path.join(process.cwd(), "vscode-extension", "render.js")) as {
  blockedModel: (blocked: unknown) => Record<string, unknown>;
  blockedHtml: (model: Record<string, unknown>) => string;
};

const at = (ageMs: number): string => new Date(Date.now() - ageMs).toISOString();

/** A live permission block on a shell command. */
const permission: SessionState = {
  v: 2,
  blocked: true,
  ts: at(5_000),
  reason: "Claude needs your permission",
  sessionId: "s-abc",
  project: { dir: "/repo/golem", name: "golem" },
  kind: "permission",
  tool: { name: "Bash", argument: "rm -rf ./build", actionClass: "destructive" },
  lastEvent: "blocked",
};

describe("blockedView", () => {
  it("answers which project, which session, on what, and since when", () => {
    const view = blockedView(resolveBlock(permission));
    expect(view.status).toBe("waiting");
    expect(view.waiting).toBe(true);
    expect(view.project_name).toBe("golem");
    expect(view.session_id).toBe("s-abc");
    expect(view.kind).toBe("permission");
    expect(view.tool).toEqual({
      name: "Bash",
      argument: "rm -rf ./build",
      action_class: "destructive",
    });
    expect(view.since).toBe(permission.ts);
    expect(view.age_ms).toBeGreaterThanOrEqual(5_000);
  });

  it("keeps the detail for an ABANDONED block — that is when it matters most", () => {
    const view = blockedView(resolveBlock({ ...permission, ts: at(20 * 60_000) }));
    expect(view.status).toBe("abandoned");
    // `waiting` is false, because it is not waiting any more...
    expect(view.waiting).toBe(false);
    // ...but a reader can still see what went unanswered, and how long ago.
    expect(view.tool?.name).toBe("Bash");
    expect(view.age_ms).toBeGreaterThan(10 * 60_000);
  });

  it("carries no detail for a clear or unknown state — there is no block to describe", () => {
    const cleared = blockedView(
      resolveBlock({ v: 2, blocked: false, ts: at(1_000), lastEvent: "responded" }),
    );
    expect(cleared).toEqual({ waiting: false, status: "clear" });
    expect(blockedView(resolveBlock(null))).toEqual({ waiting: false, status: "unknown" });
  });

  it("distinguishes 'unknown' from 'clear' — the two the old flag collapsed", () => {
    expect(blockedView(resolveBlock(null)).status).not.toBe(
      blockedView(resolveBlock({ v: 2, blocked: false, ts: at(1_000) })).status,
    );
  });
});

describe("the dashboard banner", () => {
  it("shows the tool, the argument and the age", () => {
    const html = blockedBanner(blockedView(resolveBlock(permission)));
    expect(html).toContain("Waiting on you");
    expect(html).toContain("golem");
    expect(html).toContain("Bash");
    expect(html).toContain("destructive");
    expect(html).toContain("rm -rf ./build");
  });

  it("says plainly that an abandoned block was never answered", () => {
    const html = blockedBanner(blockedView(resolveBlock({ ...permission, ts: at(20 * 60_000) })));
    expect(html).toContain("no answer recorded");
    expect(html).toContain("abandoned");
  });

  it("renders nothing when nothing is blocked", () => {
    expect(blockedBanner(blockedView(resolveBlock(null)))).toBe("");
    expect(blockedBanner(undefined)).toBe("");
  });

  it("escapes an argument rather than emitting it as markup", () => {
    // A redacted tool argument is still attacker-adjacent text.
    const html = blockedBanner(
      blockedView(
        resolveBlock({
          ...permission,
          tool: { name: "Bash", argument: `echo "<img src=x onerror=alert(1)>"` },
        }),
      ),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("the VS Code panel banner reads the same model", () => {
  const view = blockedView(resolveBlock(permission));

  it("maps status --json's blocked block into the view model", () => {
    const model = render.blockedModel(view);
    expect(model.blockedStatus).toBe("waiting");
    expect(model.blocked).toBe(true);
    expect(model.blockedTool).toBe("Bash");
    expect(model.blockedArgument).toBe("rm -rf ./build");
    expect(model.blockedActionClass).toBe("destructive");
  });

  it("degrades to 'unknown' for an older CLI that emits no block", () => {
    const model = render.blockedModel(undefined);
    expect(model.blockedStatus).toBe("unknown");
    expect(model.blocked).toBe(false);
    expect(render.blockedHtml(model)).toBe("");
  });

  it("shows the same facts the dashboard banner does", () => {
    const html = render.blockedHtml(render.blockedModel(view));
    for (const fact of ["Waiting on you", "Bash", "destructive", "rm -rf ./build"]) {
      expect(html).toContain(fact);
    }
  });

  it("shows an abandoned block, and escapes the argument", () => {
    const abandoned = blockedView(
      resolveBlock({
        ...permission,
        ts: at(20 * 60_000),
        tool: { name: "Bash", argument: "echo '<b>x</b>'" },
      }),
    );
    const html = render.blockedHtml(render.blockedModel(abandoned));
    expect(html).toContain("no answer recorded");
    expect(html).not.toContain("<b>x</b>");
  });
});
