/**
 * R9.21 — a large page must cost exactly ONE network fetch.
 *
 * The defect, observed on `https://www.rfc-editor.org/rfc/rfc5280` (327,623 chars
 * extracted): `golem init` registers `web-fetch-pre` with `timeout: 15`, and on a
 * cache miss the hook fetches the page itself before serving it. Two numbers were
 * the same 15 seconds — the hook's kill deadline and `DEFAULT_RAW_FETCH_TIMEOUT_MS`
 * — so the fetch was entitled to the whole budget, and the work that must follow it
 * (extract, redact, cache, **ingest**, serve) ran past the deadline. Claude Code
 * killed the hook and ran WebFetch normally.
 *
 * Both halves then happened: one download by Golem (the cache proved it — the entry
 * was there, `raw: true`), one by WebFetch, plus a summarizer call. The user saw a
 * normal answer, so nothing looked wrong; the cost was silent.
 *
 * These tests pin the two things that make the cost visible and bounded:
 *
 * 1. Golem gives the fetcher only the budget it can afford to spend, so a page it
 *    cannot serve in time is declined EARLY and WebFetch pays for one download —
 *    never Golem paying for a full one and then being killed before using it.
 * 2. The serve happens BEFORE the optional KB ingest. Serving is what prevents the
 *    second fetch; indexing is a bonus, and doing the bonus first was backwards.
 */

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { golemInit } from "../../../src/cli/init.js";
import {
  runWebFetchPre,
  WEB_FETCH_PRE_TIMEOUT_SECONDS,
  WEB_FETCH_SERVE_RESERVE_MS,
} from "../../../src/hooks/index.js";
import { WebCache, webCacheDir } from "../../../src/knowledge/index.js";
import { rmTemp } from "../../helpers/tmp.js";

let root: string;
let projectDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "golem-wf-budget-"));
  projectDir = path.join(root, "project");
  await mkdir(projectDir, { recursive: true });
});

afterAll(async () => {
  await rm(root, rmTemp).catch(() => {});
});

function fakeIo(stdin: string): {
  stdin: AsyncIterable<string>;
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdin: (async function* () {
      yield stdin;
    })(),
    stdout: { write: (s: string) => void out.push(s) },
    stderr: { write: (s: string) => void err.push(s) },
    out,
    err,
  };
}

const URL_BIG = "https://www.rfc-editor.org/rfc/rfc5280";

const preInput = (url: string): string =>
  JSON.stringify({ cwd: projectDir, tool_input: { url, prompt: "what does it say" } });

/** A page big enough that the real one triggered this bug. */
const BIG_PAGE = "RFC 5280 body text. ".repeat(16_000);

describe("web-fetch-pre budget (R9.21)", () => {
  it("declines early rather than paying for a fetch it cannot finish", async () => {
    // The budget is already spent by the time the miss is handled — the state the
    // real hook reaches after a slow stdin read, config load and endpoint probe.
    let fetches = 0;
    const io = fakeIo(preInput(URL_BIG));
    await runWebFetchPre(io, {
      projectDir,
      budgetMs: 0,
      fetchRawEnabled: async () => true,
      fetchRaw: async () => {
        fetches += 1;
        return { content: BIG_PAGE, headers: {} };
      },
    });

    // The whole point: Golem did NOT download the page. WebFetch will, once.
    expect(fetches).toBe(0);
    expect(io.out).toStrictEqual([]); // fell open — no deny, so WebFetch runs
    expect(await new WebCache(webCacheDir(projectDir)).get(URL_BIG)).toBeNull();
    expect(io.err.join("")).toContain("one fetch, not two");
  });

  it("hands the fetcher a budget strictly smaller than the hook's own deadline", async () => {
    // A fetcher entitled to the whole window is the bug: it can finish and still
    // leave nothing for the serve. The reserve is what it must be short by.
    let seenBudget: number | undefined;
    await runWebFetchPre(fakeIo(preInput(URL_BIG)), {
      projectDir,
      fetchRawEnabled: async () => true,
      fetchRaw: async (_u, budgetMs) => {
        seenBudget = budgetMs;
        return { content: BIG_PAGE, headers: {} };
      },
    });

    expect(seenBudget).toBeDefined();
    const hookMs = WEB_FETCH_PRE_TIMEOUT_SECONDS * 1_000;
    expect(seenBudget as number).toBeLessThanOrEqual(hookMs - WEB_FETCH_SERVE_RESERVE_MS);
    expect(seenBudget as number).toBeGreaterThan(0);
  });

  it("serves the page BEFORE the optional KB ingest", async () => {
    // Ingest embeds the whole page; on a 327KB document that is seconds of work,
    // and it used to run first, on the critical path, inside a hook the platform
    // kills. So the fetch could succeed, the cache write could land, and the hook
    // could still die before its stdout was read — which is exactly the
    // double-fetch. Order is the fix, and this is what pins it.
    const order: string[] = [];
    const io = fakeIo(preInput(URL_BIG));
    const stdoutWrite = io.stdout.write.bind(io.stdout);
    io.stdout.write = (s: string) => {
      order.push("serve");
      stdoutWrite(s);
    };

    await runWebFetchPre(io, {
      projectDir,
      fetchRawEnabled: async () => true,
      fetchRaw: async () => ({ content: BIG_PAGE, headers: {} }),
      buildKnowledge: async () => {
        order.push("ingest");
        return null;
      },
    });

    expect(order[0]).toBe("serve");
    expect(order).toContain("ingest");
  });

  it("still serves when the ingest is skipped for want of budget, and caches the page", async () => {
    // Just enough budget to fetch and serve, none left for the bonus. The page must
    // still reach Claude AND the cache, so the next fetch is a hit — the saving is
    // preserved even when the indexing is not.
    let ingested = false;
    const io = fakeIo(preInput(URL_BIG));
    await runWebFetchPre(io, {
      projectDir,
      // Enough at the start to clear the reserve check, but past the deadline by
      // the time the fetch returns. The reserve is scaled down so this costs
      // milliseconds instead of sleeping past the real 4s one.
      budgetMs: 90,
      serveReserveMs: 20,
      fetchRawEnabled: async () => true,
      fetchRaw: async () => {
        await new Promise((r) => setTimeout(r, 140));
        return { content: BIG_PAGE, headers: {} };
      },
      buildKnowledge: async () => {
        ingested = true;
        return null;
      },
    });

    const decision = JSON.parse(io.out[0] ?? "{}");
    expect(decision.hookSpecificOutput?.permissionDecision).toBe("deny"); // served
    expect((await new WebCache(webCacheDir(projectDir)).get(URL_BIG))?.raw).toBe(true);
    expect(ingested).toBe(false);
    expect(io.err.join("")).toContain("skipped the KB ingest");
  });

  /**
   * The loop this task exists to close. The hook cannot read its own
   * `timeoutSeconds` out of the payload, so the budget it enforces has to be kept
   * in step with what `golem init` writes. Deriving both from one constant is the
   * fix; this asserts the derivation actually reaches the file, because a constant
   * that init has quietly stopped using is the same bug with extra steps.
   */
  it("init writes the same timeout the hook budgets itself against", async () => {
    await golemInit({
      projectDir,
      probe: {
        claudeCodeInstalled: () => Promise.resolve(true),
        headroomWrapActive: () => Promise.resolve(false),
      },
    });
    const settings = JSON.parse(
      await readFile(path.join(projectDir, ".claude", "settings.json"), "utf8"),
    ) as {
      hooks?: {
        PreToolUse?: { matcher?: string; hooks?: { command?: string; timeout?: number }[] }[];
      };
    };
    const entries = (settings.hooks?.PreToolUse ?? []).flatMap((m) => m.hooks ?? []);
    const pre = entries.find((h) => (h.command ?? "").includes("web-fetch-pre"));
    expect(pre, "init did not register a web-fetch-pre PreToolUse hook").toBeDefined();
    expect(pre?.timeout).toBe(WEB_FETCH_PRE_TIMEOUT_SECONDS);
    // And the reserve has to leave the fetch something to work with — a reserve
    // that swallowed the whole window would decline every page.
    expect(WEB_FETCH_SERVE_RESERVE_MS).toBeLessThan(WEB_FETCH_PRE_TIMEOUT_SECONDS * 1_000);
  });

  it("an aborted fetch caches nothing, so no half-page can be served later", async () => {
    // The fail-open contract: a fetcher that gives up on the budget must leave the
    // cache untouched. A partial page cached as though complete would be worse than
    // the double fetch it replaced.
    const io = fakeIo(preInput(URL_BIG));
    await runWebFetchPre(io, {
      projectDir,
      fetchRawEnabled: async () => true,
      fetchRaw: async (_u, budgetMs) => {
        expect(budgetMs).toBeGreaterThan(0);
        throw Object.assign(new Error("The operation was aborted due to timeout"), {
          name: "TimeoutError",
        });
      },
    });

    expect(io.out).toStrictEqual([]); // fell open
    expect(await new WebCache(webCacheDir(projectDir)).get(URL_BIG)).toBeNull();
  });
});
