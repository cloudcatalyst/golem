/**
 * R8.5 — hand-labelled retrieval cases for `golem bench map`.
 *
 * Labelled against THIS repository, deliberately: dogfooding is the only source
 * of ground truth Golem has that nobody had to invent, and every expected path
 * below was verified by opening the file. A case is "which file do I open to do
 * this?", phrased the way a developer would ask it — never using the file's own
 * name, or the map's path-token matching would answer it without any of the
 * ranking under test.
 *
 * `expected` lists every path that counts as right. Where two files genuinely
 * share a concern (a stage and its rule table) both are listed rather than
 * pretending one is canonical.
 *
 * Honest limits, stated because the harness exists to prevent self-deception:
 *  - ~20 cases resolve deltas of ~5 percentage points at best. `--repeats`
 *    averages sampling noise; it cannot make the case set bigger.
 *  - The chooser is a local model, not the frontier model that reads a map in
 *    production. A null result is weak evidence of safety, not proof (§89).
 *  - These paths rot. A case whose file moved must be re-labelled, not deleted:
 *    the harness reports unlabelled/missing expectations rather than quietly
 *    scoring them wrong.
 */

export interface RetrievalCase {
  readonly id: string;
  /** The question, as a developer would ask it. */
  readonly query: string;
  /** Repo-relative POSIX paths, any of which counts as correct. */
  readonly expected: readonly string[];
}

export const RETRIEVAL_CASES: readonly RetrievalCase[] = [
  {
    id: "redaction-stage",
    query: "Where do we strip secrets and PII out of a request before anything else touches it?",
    expected: ["src/pipeline/redaction.ts", "src/pipeline/redaction-rules.ts"],
  },
  {
    id: "oversized-swap",
    query:
      "An enormous tool result is replaced with a short excerpt plus a lossless reference. Where does that replacement happen?",
    expected: ["src/hooks/post-tool-use.ts"],
  },
  {
    id: "level-table",
    query:
      "I need to change which compression stages run at savings level 2 versus level 3. Where is that table?",
    expected: ["src/interfaces/policy.ts"],
  },
  {
    id: "originals-store",
    query: "Where are the original bytes behind a reference marker persisted and read back?",
    expected: ["src/compression/ccr-store.ts", "src/compression/local-blob-store.ts"],
  },
  {
    id: "answer-without-model",
    query:
      "Which file decides whether a question can be answered from the local knowledge base instead of calling the model?",
    expected: ["src/knowledge/local-answer.ts", "src/pipeline/local-answer-response.ts"],
  },
  {
    id: "gemini-translation",
    query: "Where is an Anthropic-shaped request rewritten into Google's request format?",
    expected: ["src/providers/gemini-translate.ts"],
  },
  {
    id: "openai-translation",
    query: "Where do we turn an Anthropic request into an OpenAI chat-completions request?",
    expected: ["src/providers/openai-translate.ts"],
  },
  {
    id: "rate-limit-headers",
    query:
      "The upstream sends back headers saying how much of the 5-hour window is used. Where do we turn those into a prediction of when we will run out?",
    expected: ["src/proxy/limit-prediction.ts"],
  },
  {
    id: "usage-sniff",
    query:
      "Where do we read the token counts off a streamed response without changing the bytes we forward?",
    expected: ["src/proxy/usage-sniffer.ts"],
  },
  {
    id: "cache-verdict",
    query:
      "Where do we classify whether this request could still have hit the prompt cache, and name what broke it?",
    expected: ["src/proxy/cache-prefix.ts"],
  },
  {
    id: "relaunch-argv",
    query: "Where do we build the command line that restarts a parked session in headless mode?",
    expected: ["src/tasks/resume.ts"],
  },
  {
    id: "committed-tasks",
    query: "Where are the committed markdown task documents parsed into task objects?",
    expected: ["src/tasks/plan-task.ts"],
  },
  {
    id: "wiki-frontmatter",
    query: "Where is a wiki page's YAML header parsed and its wikilinks pulled out?",
    expected: ["src/wiki/frontmatter.ts"],
  },
  {
    id: "hardware-tier",
    query: "Where do we detect the machine's GPU and decide which local model tier it can run?",
    expected: ["src/inference/capability.ts", "src/inference/probe.ts"],
  },
  {
    id: "model-catalog-roles",
    query: "Where is the mapping from a role like drafter or judge to a concrete local model?",
    expected: ["src/inference/catalog.ts"],
  },
  {
    id: "autonomy-classify",
    query:
      "Where do we decide whether a shell command is a read, a write, or something destructive?",
    expected: ["src/autonomy/classify.ts"],
  },
  {
    id: "credential-store",
    query: "Where is an upstream API key written to and read from the operating system's keychain?",
    expected: ["src/credentials/store.ts", "src/credentials/backends.ts"],
  },
  {
    id: "settings-precedence",
    query:
      "Where are project settings, user settings, environment overrides and defaults merged into one config?",
    expected: ["src/config/loader.ts"],
  },
  {
    id: "hook-registration",
    query: "Where do we write Golem's hook entries into Claude Code's settings file?",
    expected: ["src/hooks/settings-writer.ts", "src/hooks/settings-extras.ts"],
  },
  {
    id: "chunking",
    query: "Where is a markdown document split into pieces small enough to embed?",
    expected: ["src/knowledge/chunker.ts"],
  },
  {
    id: "statusline",
    query: "Where is the single status line that Claude Code renders at the bottom produced?",
    expected: ["src/cli/statusline.ts"],
  },
  {
    id: "brevity-dial",
    query: "Where is the instruction that tells the model to answer more briefly assembled?",
    expected: ["src/pipeline/brevity.ts"],
  },
];
