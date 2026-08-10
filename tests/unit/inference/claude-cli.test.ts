/**
 * R9.15 — drafting on the user's own subscription by spawning the official CLI.
 *
 * The property that matters most here is a NEGATIVE one: Golem never reads,
 * copies or forwards a Claude Code credential. These tests pin the mechanics
 * that make that true — the prompt never becomes an argument, the child never
 * inherits Golem's or Anthropic's wiring — and the two guards that keep the
 * route from being pointless or surprising.
 */

import { describe, expect, it } from "vitest";
import {
  ClaudeCliError,
  claudeCliArgs,
  draftWithClaudeCli,
  scrubbedEnv,
} from "../../../src/inference/claude-cli.js";
import {
  createTargetDispatcher,
  TargetDispatchError,
} from "../../../src/inference/target-dispatcher.js";
import type {
  ChatMessage,
  ChatResult,
  InferenceService,
  Role,
} from "../../../src/interfaces/inference.js";
import type { TargetRegistrySettings } from "../../../src/providers/index.js";

function stubInference(): InferenceService {
  return {
    chat: async (role: Role, messages: readonly ChatMessage[]): Promise<ChatResult> => ({
      text: `local:${String(messages[0]?.content ?? "")}`,
      model: "qwen2.5-coder:7b",
      role,
      promptTokens: 1,
      completionTokens: 1,
      finishReason: "stop",
    }),
    embed: async () => [],
    capabilities: () => 2 as never,
  };
}

/** Secret shapes built at runtime — never literals (see the R9.3 fixture note). */
const FAKE_KEY = ["sk", "ant", "api03", "B".repeat(95)].join("-");

const CLI_TARGET: TargetRegistrySettings = {
  upstream_provider: "anthropic",
  upstream_base_url: "https://api.anthropic.com",
  upstream_auth_scheme: "inherit",
  targets: [
    {
      id: "subscription",
      provider: "claude-cli",
      base_url: "https://api.anthropic.com",
      model: "claude-sonnet-5",
      trust: "vendor",
    },
  ],
};

/** The same registry, but the session is fronted by a third party. */
const THIRD_PARTY: TargetRegistrySettings = {
  ...CLI_TARGET,
  upstream_provider: "openrouter",
  upstream_base_url: "https://openrouter.ai/api/v1",
};

/** A minimal EventEmitter-shaped child: enough for the adapter's contract. */
function fakeChild(onStdin: (s: string) => void, stdout: string, code = 0): unknown {
  const handlers: Record<string, ((arg: never) => void)[]> = {};
  const stream = (name: "stdout" | "stderr") => ({
    on(event: string, cb: (chunk: Buffer | string) => void) {
      if (event === "data" && name === "stdout" && stdout !== "") setTimeout(() => cb(stdout), 0);
      return this;
    },
  });
  const child = {
    stdout: stream("stdout"),
    stderr: stream("stderr"),
    stdin: {
      end(s: string) {
        onStdin(s);
        setTimeout(() => {
          for (const cb of handlers.close ?? []) cb(code as never);
        }, 1);
      },
    },
    kill() {},
    on(event: string, cb: (arg: never) => void) {
      const existing = handlers[event];
      if (existing === undefined) handlers[event] = [cb];
      else existing.push(cb);
      return child;
    },
  };
  return child;
}

describe("the two guards on a claude-cli target", () => {
  const drafter = async ({ prompt }: { prompt: string }) => `drafted from: ${prompt}`;

  it("drafts, and redacts before the spawn", async () => {
    let sawPrompt = "";
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings: CLI_TARGET,
      env: {},
      spawnDrafter: async ({ prompt }) => {
        sawPrompt = prompt;
        return "ok";
      },
      sessionModel: () => "claude-opus-5",
    });

    const result = await dispatcher.dispatch({
      role: "drafter",
      prompt: `draft this, key is ${FAKE_KEY}`,
      targetId: "subscription",
    });

    // A spawn is an egress: the secret must not reach the child process.
    expect(sawPrompt).not.toContain(FAKE_KEY);
    expect(sawPrompt).toContain("[REDACTED:");
    expect(result.redactedCount).toBeGreaterThan(0);
    expect(result.model).toBe("claude-sonnet-5");
    expect(result.targetId).toBe("subscription");
  });

  it("refuses when the session's upstream is a third party", async () => {
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings: THIRD_PARTY,
      env: {},
      spawnDrafter: drafter,
      sessionModel: () => "claude-opus-5",
    });

    await expect(
      dispatcher.dispatch({ role: "drafter", prompt: "hi", targetId: "subscription" }),
    ).rejects.toThrow(/billed to a different account/);
  });

  it("refuses to draft on the model the session is already using", async () => {
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings: CLI_TARGET,
      env: {},
      spawnDrafter: drafter,
      sessionModel: () => "claude-sonnet-5",
    });

    await expect(
      dispatcher.dispatch({ role: "drafter", prompt: "hi", targetId: "subscription" }),
    ).rejects.toThrow(/already using/);
  });

  it("allows the dispatch when the session model is unknown", async () => {
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings: CLI_TARGET,
      env: {},
      spawnDrafter: drafter,
      sessionModel: () => undefined,
    });

    const result = await dispatcher.dispatch({
      role: "drafter",
      prompt: "hi",
      targetId: "subscription",
    });
    expect(result.targetId).toBe("subscription");
  });

  it("refuses rather than rerouting when no spawner is wired", async () => {
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings: CLI_TARGET,
      env: {},
      sessionModel: () => "claude-opus-5",
    });

    await expect(
      dispatcher.dispatch({ role: "drafter", prompt: "hi", targetId: "subscription" }),
    ).rejects.toBeInstanceOf(TargetDispatchError);
  });
});

describe("the spawn is a text call, and carries no Golem credential", () => {
  it("puts the prompt on stdin and never in the argument list", async () => {
    const seen: { file: string; argv: string[]; stdin: string; env: NodeJS.ProcessEnv } = {
      file: "",
      argv: [],
      stdin: "",
      env: {},
    };
    const prompt = `Refactor this. Key ${FAKE_KEY}. "quoted" & piped | ; rm -rf /`;

    const text = await draftWithClaudeCli(prompt, "claude-sonnet-5", {
      cwd: process.cwd(),
      resolveCommand: () => "/usr/local/bin/claude",
      env: {
        PATH: "/usr/bin",
        ANTHROPIC_BASE_URL: "http://localhost:4477",
        ANTHROPIC_API_KEY: "sk-should-not-travel",
        GOLEM_UPSTREAM_API_KEY__OPENROUTER: "sk-or-should-not-travel",
        ENABLE_TOOL_SEARCH: "true",
        HOME: "/home/dev",
      },
      spawnImpl: ((file: string, argv: string[], opts: { env: NodeJS.ProcessEnv }) => {
        seen.file = file;
        seen.argv = argv;
        seen.env = opts.env;
        return fakeChild((s) => {
          seen.stdin = s;
        }, "drafted ok");
      }) as never,
    });

    expect(text).toBe("drafted ok");
    // The gate: nothing the caller supplied appears in argv.
    expect(seen.argv.join(" ")).not.toContain(FAKE_KEY);
    expect(seen.argv.join(" ")).not.toContain("rm -rf");
    expect(seen.stdin).toBe(prompt);
    expect(seen.argv).toContain("--print");
    // And no Golem/Anthropic wiring reached the child.
    expect(seen.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(seen.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen.env.GOLEM_UPSTREAM_API_KEY__OPENROUTER).toBeUndefined();
    expect(seen.env.ENABLE_TOOL_SEARCH).toBeUndefined();
    expect(seen.env.HOME).toBe("/home/dev");
  });

  it("refuses a model id that could not safely be an argument", async () => {
    await expect(
      draftWithClaudeCli("hi", "sonnet; rm -rf /", { resolveCommand: () => "/bin/claude" }),
    ).rejects.toBeInstanceOf(ClaudeCliError);
  });

  it("says so when the CLI is not installed, rather than failing obscurely", async () => {
    await expect(
      draftWithClaudeCli("hi", "claude-sonnet-5", { resolveCommand: () => null }),
    ).rejects.toThrow(/not on PATH/);
  });

  it("denies the file and exec tools — a draft must not touch the project", () => {
    const args = claudeCliArgs("claude-sonnet-5");
    const denied = args[args.indexOf("--disallowed-tools") + 1] ?? "";
    for (const tool of ["Bash", "Edit", "Write", "Read", "WebFetch"]) {
      expect(denied).toContain(tool);
    }
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--strict-mcp-config");
  });

  it("scrubbedEnv keeps everything else untouched", () => {
    const out = scrubbedEnv({ PATH: "/usr/bin", GOLEM_X: "x", ANTHROPIC_Y: "y", TERM: "xterm" });
    expect(out).toEqual({ PATH: "/usr/bin", TERM: "xterm" });
  });
});
