/**
 * R8.S3 — session tree recorder: observation + persistence + rendering.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  readSessionTree,
  renderSessionTree,
  SessionTreeRecorder,
  sessionTreePath,
  writeSessionTree,
} from "../../src/session/session-tree.js";

const _FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/** A minimal /v1/messages body with the given messages array. */
function req(messages: unknown[]): Record<string, unknown> {
  return { model: "claude-sonnet-5-20260501", max_tokens: 1024, messages };
}

/** A user text message. */
function u(text: string): Record<string, unknown> {
  return { role: "user", content: text };
}

/** An assistant text message. */
function a(text: string): Record<string, unknown> {
  return { role: "assistant", content: text };
}

describe("SessionTreeRecorder", () => {
  const t0 = "2026-08-03T12:00:00.000Z";
  const t1 = "2026-08-03T12:01:00.000Z";
  const t2 = "2026-08-03T12:02:00.000Z";
  const t3 = "2026-08-03T12:03:00.000Z";

  it("records a new conversation on first observation", () => {
    const rec = new SessionTreeRecorder();
    rec.observeAt(req([u("hello")]), t0);
    const tree = rec.snapshot();
    expect(tree.conversations).toHaveLength(1);
    expect(tree.conversations[0]?.requestCount).toBe(1);
    expect(tree.conversations[0]?.root.depth).toBe(1);
  });

  it("extends the same branch on appending messages", () => {
    const rec = new SessionTreeRecorder();
    rec.observeAt(req([u("hello")]), t0);
    rec.observeAt(req([u("hello"), a("hi there")]), t1);
    const tree = rec.snapshot();
    expect(tree.conversations).toHaveLength(1);
    const c = tree.conversations[0];
    expect(c?.requestCount).toBe(2);
    expect(c?.root.depth).toBe(2);
    expect(c?.root.branches).toHaveLength(0);
  });

  it("creates a sub-branch on rewind (fork)", () => {
    const rec = new SessionTreeRecorder();
    // Build 3 messages in the trunk.
    rec.observeAt(req([u("a"), a("b"), u("c")]), t0);
    rec.observeAt(req([u("a"), a("b"), u("c"), a("d")]), t1);
    rec.observeAt(req([u("a"), a("b"), u("c"), a("d"), u("e")]), t2);
    const c = rec.snapshot().conversations[0];
    expect(c?.root.depth).toBe(5);

    // Rewind to message 3 and continue differently.
    rec.observeAt(req([u("a"), a("b"), u("c")]), t3);
    const tree = rec.snapshot();
    expect(tree.conversations).toHaveLength(1);
    const root = tree.conversations[0]?.root;
    expect(root?.depth).toBe(5); // trunk depth unchanged
    expect(root?.branches).toHaveLength(1); // one sub-branch
    expect(root?.branches[0]?.forkedAt).toBe(3); // forked at message index 3
  });

  it("supports multiple conversations", () => {
    const rec = new SessionTreeRecorder();
    rec.observeAt(req([u("first")]), t0);
    rec.observeAt(req([u("second")]), t1);
    expect(rec.snapshot().conversations).toHaveLength(2);
  });

  it("evicts oldest conversations when over max", () => {
    const rec = new SessionTreeRecorder(2);
    rec.observeAt(req([u("a")]), t0);
    rec.observeAt(req([u("b")]), t1);
    rec.observeAt(req([u("c")]), t2);
    expect(rec.size()).toBe(2);
  });

  it("ignores bodies with no messages", () => {
    const rec = new SessionTreeRecorder();
    rec.observeAt(req([]), t0);
    expect(rec.size()).toBe(0);
  });
});

describe("renderSessionTree", () => {
  it("returns a message when empty", () => {
    expect(renderSessionTree({ conversations: [] })).toMatch("No recorded sessions");
  });

  it("renders a simple tree", () => {
    const tree = {
      conversations: [
        {
          conversationKey: "abc123def456",
          startedAt: "2026-08-03T12:00:00.000Z",
          lastRequestAt: "2026-08-03T12:05:00.000Z",
          requestCount: 3,
          root: {
            forkedAt: 0,
            startedAt: "2026-08-03T12:00:00.000Z",
            lastRequestAt: "2026-08-03T12:01:00.000Z",
            requestCount: 2,
            depth: 4,
            branches: [
              {
                forkedAt: 4,
                startedAt: "2026-08-03T12:02:00.000Z",
                lastRequestAt: "2026-08-03T12:02:00.000Z",
                requestCount: 1,
                depth: 1,
                branches: [],
              },
            ],
          },
        },
      ],
    };
    const rendered = renderSessionTree(tree);
    expect(rendered).toMatch("1 conversation");
    expect(rendered).toMatch("abc123def4…");
    expect(rendered).toMatch("root");
    expect(rendered).toMatch("fork at msg 4");
  });
});

describe("persistence", () => {
  it("roundtrips a session tree through disk", async () => {
    const rec = new SessionTreeRecorder();
    rec.observeAt(req([u("hello")]), "2026-08-03T12:00:00.000Z");
    const tree = rec.snapshot();

    await writeSessionTree(_FIXTURES, tree);
    const loaded = await readSessionTree(_FIXTURES);
    expect(loaded).not.toBeNull();
    expect(loaded?.conversations[0]?.requestCount).toBe(1);
  });
});

it("sessionTreePath returns the expected path", () => {
  const p = sessionTreePath("/tmp/proj");
  expect(p).toMatch(/\.golem[/\\]state[/\\]session-tree\.json$/);
});
