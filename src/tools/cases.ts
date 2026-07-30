/**
 * Workstream B — the labelled tool-selection case set.
 *
 * **These labels are a judgement call, and that is the honest limitation of the
 * whole harness.** Each case says "for this request, the right Golem tool is X",
 * written by reading the tool descriptions in `src/mcp/server.ts`. They are not
 * observed traffic. So the harness measures *agreement with these labels*, which
 * is a proxy for tool-selection accuracy, not a ground truth — good enough to
 * detect a regression caused by rewriting a description (the §88 question), and
 * not good enough to publish an absolute "Golem tool selection is N% accurate".
 *
 * `expected: null` means "no Golem tool should be called" — those cases exist
 * because the failure mode that matters most for a shrinker is not picking the
 * wrong tool, it is picking a tool at all when none applies. A description that
 * has been trimmed into vagueness tends to over-trigger.
 */

export interface SelectionCase {
  readonly id: string;
  readonly prompt: string;
  /** Tool that should be chosen, or null for "none of them". */
  readonly expected: string | null;
}

export const SELECTION_CASES: readonly SelectionCase[] = [
  // search — semantic retrieval over the local index
  {
    id: "search-1",
    prompt: "Where in this project is the redaction stage implemented?",
    expected: "search",
  },
  {
    id: "search-2",
    prompt: "Find anything we've already written about prompt caching.",
    expected: "search",
  },
  // fetch — full text of a known chunk id
  {
    id: "fetch-1",
    prompt: "Give me the full text of chunk c_8f21ab, the preview is cut off.",
    expected: "fetch",
  },
  {
    id: "fetch-2",
    prompt: "Show the complete contents of the chunk you just returned as hit 3.",
    expected: "fetch",
  },
  // expand — CCR reference
  {
    id: "expand-1",
    prompt: "The output ended with `Retrieve original: hash=deadbeef12`. I need the whole thing.",
    expected: "expand",
  },
  {
    id: "expand-2",
    prompt: "Recover the original content behind ref id 4c1d9e77 — the excerpt isn't enough.",
    expected: "expand",
  },
  // ingest — index a path
  {
    id: "ingest-1",
    prompt: "Index the ../vendor/sdk directory so search can find it.",
    expected: "ingest",
  },
  {
    id: "ingest-2",
    prompt: "Add this repo's src tree to the local vector knowledge base and keep watching it.",
    expected: "ingest",
  },
  // stats — savings numbers
  {
    id: "stats-1",
    prompt: "How many tokens has Golem saved so far, and from which stage?",
    expected: "stats",
  },
  {
    id: "stats-2",
    prompt: "Show me the cumulative compression statistics for this project.",
    expected: "stats",
  },
  // level — set the slider
  { id: "level-1", prompt: "Set Golem's slider to level 2.", expected: "level" },
  { id: "level-2", prompt: "Turn the compression dial up to aggressive.", expected: "level" },
  // devices — hardware tier
  {
    id: "devices-1",
    prompt: "What GPU did Golem detect, and which local models will it use?",
    expected: "devices",
  },
  {
    id: "devices-2",
    prompt: "Report the detected hardware tier for local inference.",
    expected: "devices",
  },
  // wiki_read — read a page
  { id: "wiki_read-1", prompt: "Read the [[Slider Levels]] wiki page.", expected: "wiki_read" },
  {
    id: "wiki_read-2",
    prompt: "Open the project wiki page titled Compression and show me its body.",
    expected: "wiki_read",
  },
  // wiki_upsert — write a page
  {
    id: "wiki_upsert-1",
    prompt:
      "Create a wiki page called Tool Search recording what we just learned, linking to [[Compression]].",
    expected: "wiki_upsert",
  },
  {
    id: "wiki_upsert-2",
    prompt:
      "Append a paragraph about the 900-token tools block to the existing Compression wiki page.",
    expected: "wiki_upsert",
  },
  // coder — local drafting
  {
    id: "coder-1",
    prompt: "Draft a TypeScript function that parses an ISO duration string into seconds.",
    expected: "coder",
  },
  {
    id: "coder-2",
    prompt: "Write a first cut of the retry wrapper class, then I'll review it.",
    expected: "coder",
  },
  // snooze — park until reset
  {
    id: "snooze-1",
    prompt: "We're at the usage limit — park this session until the window resets at 14:00Z.",
    expected: "snooze",
  },
  {
    id: "snooze-2",
    prompt: "Wait until the rate limit resets instead of stopping, then carry on.",
    expected: "snooze",
  },
  // none — a tool call here is a false positive
  { id: "none-1", prompt: "Thanks, that looks right.", expected: null },
  {
    id: "none-2",
    prompt: "Rename the variable `foo` to `bar` on line 12 of this file.",
    expected: null,
  },
  {
    id: "none-3",
    prompt: "Explain the difference between a mutex and a semaphore.",
    expected: null,
  },
  { id: "none-4", prompt: "What did I ask you two messages ago?", expected: null },
  { id: "none-5", prompt: "Run the test suite and tell me if it's green.", expected: null },
];
