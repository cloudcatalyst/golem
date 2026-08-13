/**
 * P3a — CLAUDE.md compaction actuator.
 *
 * The tests that matter are the ones that hold when the local model misbehaves:
 * byte-preservation of protected spans, and per-segment fallback to the
 * ORIGINAL whenever a rewrite cannot be proven safe.
 */

import { describe, expect, it } from "vitest";
import {
  CapabilityUnavailableError,
  type ChatMessage,
  type ChatResult,
  type InferenceService,
  type Role,
} from "../../../src/interfaces/inference.js";
import {
  COVERAGE_THRESHOLD,
  compactDocument,
  extractDirectives,
  maskProtected,
  renderCompactReport,
  restoreProtected,
  scoreDirectives,
  segmentMarkdown,
} from "../../../src/prompt/index.js";

/** An inference fake that transforms whatever it is asked to rewrite. */
function fakeInference(
  transform: (userText: string) => string,
  capture?: (m: readonly ChatMessage[]) => void,
): InferenceService {
  return {
    chat: (role: Role, m: readonly ChatMessage[]): Promise<ChatResult> => {
      capture?.(m);
      const user = String((m[m.length - 1] as { content?: unknown }).content ?? "");
      return Promise.resolve({
        text: transform(user),
        model: "m",
        role,
        promptTokens: 0,
        completionTokens: 0,
        finishReason: "stop",
      });
    },
    embed: () => Promise.resolve([]),
    capabilities: () => 2,
  };
}

/**
 * A well-behaved rewrite: drops every second non-sentinel word, copies every
 * sentinel through. Stands in for a model that obeys the placeholder rule.
 */
function shorten(user: string): string {
  let drop = false;
  return user
    .split(/\s+/)
    .filter((w) => {
      if (/GOLEMKEEP\d+/.test(w)) return true;
      drop = !drop;
      return drop;
    })
    .join(" ");
}

const unavailable: InferenceService = {
  chat: () => Promise.reject(new CapabilityUnavailableError("drafter", 2)),
  embed: () => Promise.resolve([]),
  capabilities: () => 2,
};

describe("segmentMarkdown", () => {
  it("round-trips a document exactly", () => {
    const doc = [
      "---",
      "a: 1",
      "---",
      "",
      "# Title",
      "",
      "prose here",
      "",
      "```ts",
      "x",
      "```",
      "",
    ].join("\n");
    expect(
      segmentMarkdown(doc)
        .map((s) => s.text)
        .join("\n"),
    ).toBe(doc);
  });

  it("classifies frontmatter, headings and fenced code as unrewritable", () => {
    const doc = ["---", "t: x", "---", "# H", "text", "```sh", "rm -rf /", "```"].join("\n");
    const kinds = segmentMarkdown(doc).map((s) => s.kind);
    expect(kinds).toContain("frontmatter");
    expect(kinds).toContain("heading");
    expect(kinds).toContain("code");
  });

  it("treats an unterminated fence as code rather than sending it", () => {
    const segs = segmentMarkdown(["text", "```", "never closed"].join("\n"));
    expect(segs[segs.length - 1]?.kind).toBe("code");
  });
});

describe("maskProtected / restoreProtected", () => {
  it("masks code, paths, URLs, wikilinks and SCREAMING_SNAKE identifiers", () => {
    const text =
      "Run `npm test` on src/prompt/compact.ts, see https://golem.run/docs, set GOLEM_LEVEL, read [[Compression]].";
    const { masked, spans } = maskProtected(text);
    expect(masked).not.toContain("src/prompt/compact.ts");
    expect(masked).not.toContain("https://golem.run/docs");
    expect(masked).not.toContain("GOLEM_LEVEL");
    expect(spans.map((s) => s.text)).toContain("`npm test`");
    expect(restoreProtected(masked, spans)).toBe(text);
  });

  it("restores byte-exact even when the model lowercases a sentinel", () => {
    const { masked, spans } = maskProtected("edit src/x.ts now");
    expect(restoreProtected(masked.toLowerCase().replace("edit", "EDIT"), spans)).toContain(
      "src/x.ts",
    );
  });

  it("rejects a rewrite that dropped a sentinel", () => {
    const { masked, spans } = maskProtected("touch src/a.ts and src/b.ts");
    expect(restoreProtected(masked.replace(/GOLEMKEEP0/, ""), spans)).toBeNull();
  });

  it("rejects a rewrite that duplicated or invented a sentinel", () => {
    const { masked, spans } = maskProtected("touch src/a.ts");
    expect(restoreProtected(`${masked} GOLEMKEEP0`, spans)).toBeNull();
    expect(restoreProtected(`${masked} GOLEMKEEP99`, spans)).toBeNull();
  });

  it("continues sentinel numbering across segments", () => {
    const first = maskProtected("see src/a.ts here");
    const second = maskProtected("see src/b.ts here", first.spans.length);
    expect(second.spans[0]?.id).toBe(first.spans.length);
  });
});

describe("directive coverage (the cost side)", () => {
  it("extracts bullets and imperative lines, not headings or code", () => {
    const doc = [
      "# Hard rules",
      "",
      "- Redaction must never be weakened or reordered.",
      "Some descriptive background sentence about history.",
      "",
      "```ts",
      "must never reorder",
      "```",
    ].join("\n");
    const directives = extractDirectives(doc);
    expect(directives).toContain("- Redaction must never be weakened or reordered.");
    expect(directives.join("\n")).not.toContain("# Hard rules");
  });

  it("scores a faithful rewrite high and a lossy one low", () => {
    const original = "- Redaction must never be weakened or reordered.";
    // Inflection may change ("weakened" → "weaken"); a genuinely absent word
    // ("must") still counts against the rewrite — the proxy is meant to be strict.
    const faithful = scoreDirectives(original, "- Never weaken or reorder redaction.")[0];
    expect(faithful?.coverage).toBeGreaterThanOrEqual(COVERAGE_THRESHOLD);
    expect(faithful?.missing).toEqual(["must"]);
    const lossy = scoreDirectives(original, "- Be careful with the pipeline.")[0];
    expect(lossy?.coverage).toBeLessThan(COVERAGE_THRESHOLD);
    expect(lossy?.missing).toContain("redaction");
  });
});

describe("compactDocument", () => {
  const doc = [
    "# Rules",
    "",
    "Golem is a local-first pre-LLM processing layer that does a great many things, and this",
    "paragraph exists mainly to be long enough to be worth a rewrite. Redaction must never be",
    "weakened or reordered, and the proxy stays byte-faithful at or below level 1. Always run",
    "the checks in src/cli/main.ts before shipping anything at all to any user anywhere.",
    "",
    "```ts",
    "const verbose = 'this code must survive untouched';",
    "```",
  ].join("\n");

  it("shortens prose, leaves headings and code byte-identical", async () => {
    const inference = fakeInference(shorten);
    const res = await compactDocument(doc, { inference });
    expect(res.compacted).toContain("# Rules");
    expect(res.compacted).toContain("const verbose = 'this code must survive untouched';");
    expect(res.savedTokens).toBeGreaterThan(0);
    expect(res.segments.filter((s) => s.rewritten)).toHaveLength(1);
  });

  it("never sends fenced code to the model", async () => {
    const seen: string[] = [];
    const inference = fakeInference(
      (user) => user,
      (m) => seen.push(String((m[m.length - 1] as { content?: unknown }).content ?? "")),
    );
    await compactDocument(doc, { inference });
    expect(seen.join("\n")).not.toContain("this code must survive untouched");
  });

  it("keeps the original segment when protected spans do not survive", async () => {
    const inference = fakeInference(() => "Short prose with every placeholder thrown away.");
    const res = await compactDocument(doc, { inference });
    expect(res.compacted).toContain("src/cli/main.ts");
    expect(res.warnings.join("\n")).toContain("protected spans did not survive");
    expect(res.segments.some((s) => s.rewritten)).toBe(false);
  });

  it("refuses a rewrite that would collide with the brevity stage", async () => {
    const inference = fakeInference((user) => `Caveman style. ${shorten(user)}`);
    const res = await compactDocument(doc, { inference });
    expect(res.warnings.join("\n")).toContain("brevity-stage collision");
    expect(res.compacted).toBe(doc);
  });

  it("keeps the original when the rewrite is not shorter", async () => {
    const inference = fakeInference((user) => `${user} and then some extra words appended here.`);
    const res = await compactDocument(doc, { inference });
    expect(res.compacted).toBe(doc);
    expect(res.savedTokens).toBe(0);
  });

  it("degrades to an exact no-op when the local model is unreachable", async () => {
    const res = await compactDocument(doc, { inference: unavailable });
    expect(res.compacted).toBe(doc);
    expect(res.modelUnavailable).toBe(true);
    expect(res.savedTokens).toBe(0);
    expect(res.warnings.join("\n")).toContain("local model unavailable");
  });

  /**
   * A prose segment owns the blank lines that separate it from the heading or
   * fence on either side, and the model never reproduces them. Without the
   * hold-back-and-re-attach the rewrite welds the paragraph to the next heading
   * and the file's shape drifts a little every time the command is run — a
   * silent structural regression no other assertion here would catch.
   */
  describe("blank-line reassembly", () => {
    /** Deliberately free of code, paths and identifiers, so nothing is masked. */
    const paragraph =
      "This paragraph is long enough to be worth a rewrite, and it deliberately contains " +
      "nothing that would be masked, so the rewrite is accepted exactly as the model returns it.";

    it("re-attaches the blank lines a rewritten paragraph was surrounded by", async () => {
      const spaced = ["# Rules", "", paragraph, "", "## Checks"].join("\n");
      const res = await compactDocument(spaced, { inference: fakeInference(() => "SHORT.") });
      expect(res.segments.some((s) => s.rewritten)).toBe(true);
      expect(res.compacted).toBe(["# Rules", "", "SHORT.", "", "## Checks", ""].join("\n"));
    });

    it("adds no blank line the original did not have", async () => {
      const tight = [paragraph, "## Checks"].join("\n");
      const res = await compactDocument(tight, { inference: fakeInference(() => "SHORT.") });
      expect(res.segments.some((s) => s.rewritten)).toBe(true);
      expect(res.compacted).toBe(["SHORT.", "## Checks", ""].join("\n"));
    });
  });

  it("always reports the cost side, even on a no-op", async () => {
    const res = await compactDocument(doc, { inference: unavailable });
    expect(res.directives.length).toBeGreaterThan(0);
    expect(res.directivesPreserved).toBe(res.directives.length);
    const report = renderCompactReport(res, "CLAUDE.md");
    expect(report).toContain("SAVING");
    expect(report).toContain("COST");
    expect(report).toContain("NOT measured");
  });
});
