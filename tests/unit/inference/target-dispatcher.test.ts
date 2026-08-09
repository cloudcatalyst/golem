/**
 * R9.3 — `coder` on any target.
 *
 * The gate for this task is a recorded proof that **the dispatched payload
 * carries no secret/PII for any non-local target, while the returned draft is
 * fully de-redacted.** That is the first describe block, and it asserts on the
 * bytes actually sent rather than trusting the code path.
 *
 * Fixture note: every secret is assembled at runtime, so this source file
 * contains neither a real secret (which tooling would redact out from under the
 * test) nor a literal `[REDACTED:…]` placeholder (which redaction is idempotent
 * over, so the test would pass while proving nothing).
 *
 * The frozen `InferenceService` is a stub: this dispatcher sits above it and
 * must not change its meaning.
 */

import { describe, expect, it } from "vitest";
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

/** A stub for the frozen contract — records what the LOCAL path was asked. */
function stubInference(): InferenceService & { calls: { role: Role; prompt: string }[] } {
  const calls: { role: Role; prompt: string }[] = [];
  return {
    calls,
    chat: async (role: Role, messages: readonly ChatMessage[]): Promise<ChatResult> => {
      calls.push({ role, prompt: String(messages[0]?.content ?? "") });
      return {
        text: "local draft",
        model: "qwen2.5-coder:7b",
        role,
        promptTokens: 1,
        completionTokens: 1,
        finishReason: "stop",
      };
    },
    embed: async () => [],
    capabilities: () => 2 as never,
  };
}

/**
 * Capture every outbound request so we can assert on the actual bytes.
 *
 * `reply` may be a function of the request body, which is how the round-trip
 * test echoes the redacted prompt back instead of hard-coding placeholder
 * indices — asserting against those would only test the test.
 */
function captureFetch(reply: Record<string, unknown> | ((body: string) => unknown)): {
  fetchImpl: typeof fetch;
  sent: { url: string; body: string; headers: Record<string, string> }[];
} {
  const sent: { url: string; body: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    sent.push({
      url: String(url),
      body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const resolved = typeof reply === "function" ? (reply as (b: string) => unknown)(body) : reply;
    return new Response(JSON.stringify(resolved), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

/** Realistic secret shapes, built at runtime (see the fixture note above). */
const FAKE_KEY = ["sk", "ant", "api03", "A".repeat(95)].join("-");
const FAKE_EMAIL = ["oncall", "example.com"].join("@");

/** A prompt carrying material that must never leave the machine unredacted. */
const SECRET_PROMPT =
  `Refactor this. My key is ${FAKE_KEY} and the on-call address is ${FAKE_EMAIL}. ` +
  `Use key ${FAKE_KEY} again.`;

/** Pull the user message back out of a captured OpenAI Chat Completions body. */
function sentPrompt(body: string): string {
  return JSON.parse(body).messages[0].content as string;
}

const REMOTE: TargetRegistrySettings = {
  upstream_provider: "anthropic",
  upstream_base_url: "https://api.anthropic.com",
  upstream_auth_scheme: "inherit",
  targets: [
    {
      id: "cheap",
      provider: "openrouter",
      base_url: "https://openrouter.ai/api/v1",
      model: "openai/gpt-oss-20b:free",
      account: "openrouter",
      trust: "third-party",
    },
  ],
  accounts: [
    { id: "openrouter", provider: "openrouter", base_url: "https://openrouter.ai/api/v1" },
  ],
};

describe("the gate — no secret leaves, and the draft comes back usable", () => {
  it("redacts the dispatched payload for a non-local target", async () => {
    const { fetchImpl, sent } = captureFetch({
      model: "openai/gpt-oss-20b:free",
      choices: [{ message: { content: "done" } }],
    });
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings: REMOTE,
      fetchImpl,
      env: { GOLEM_UPSTREAM_API_KEY__OPENROUTER: "sk-or-thekey" },
    });

    const result = await dispatcher.dispatch({
      role: "drafter",
      prompt: SECRET_PROMPT,
      targetId: "cheap",
    });

    expect(sent).toHaveLength(1);
    const body = sent[0]?.body ?? "";
    // The RECORDED BYTES carry no secret and no PII. This is the gate.
    expect(body).not.toContain(FAKE_KEY);
    expect(body).not.toContain(FAKE_EMAIL);
    expect(body).toContain("[REDACTED:");
    expect(result.redactedCount).toBeGreaterThan(0);
  });

  it("restores the placeholders so the returned draft is usable", async () => {
    // A draft full of `[REDACTED:…]` would be worthless — the round trip is part
    // of the requirement, not a nicety. The stub echoes the redacted prompt back,
    // so a correct restoration reproduces the ORIGINAL byte for byte.
    const { fetchImpl } = captureFetch((body) => ({
      model: "m",
      choices: [{ message: { content: sentPrompt(body) } }],
    }));
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings: REMOTE,
      fetchImpl,
      env: {},
    });

    const result = await dispatcher.dispatch({
      role: "drafter",
      prompt: SECRET_PROMPT,
      targetId: "cheap",
    });

    expect(result.text).toBe(SECRET_PROMPT);
    expect(result.text).toContain(FAKE_KEY);
    expect(result.text).not.toContain("[REDACTED:");
  });

  it("reuses one placeholder per distinct secret, so restoration is unambiguous", async () => {
    const { fetchImpl, sent } = captureFetch({
      model: "m",
      choices: [{ message: { content: "ok" } }],
    });
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings: REMOTE,
      fetchImpl,
      env: {},
    });
    await dispatcher.dispatch({ role: "drafter", prompt: SECRET_PROMPT, targetId: "cheap" });

    // The same key appears twice and must map to ONE placeholder used twice —
    // per-VALUE numbering is what makes restoration total.
    const prompt = sentPrompt(sent[0]?.body ?? "");
    const placeholders = prompt.match(/\[REDACTED:[^\]]+\]/g) ?? [];
    expect(placeholders.length).toBeGreaterThanOrEqual(3);
    expect(placeholders[0]).toBe(placeholders[placeholders.length - 1]);
    expect(new Set(placeholders).size).toBeLessThan(placeholders.length);
  });
});

describe("the local path is unchanged", () => {
  it("delegates to the frozen InferenceService when no target is named", async () => {
    const inference = stubInference();
    const { fetchImpl, sent } = captureFetch({});
    const dispatcher = createTargetDispatcher({ inference, settings: REMOTE, fetchImpl, env: {} });

    const result = await dispatcher.dispatch({
      role: "drafter",
      prompt: SECRET_PROMPT,
      worker: "coder",
    });

    expect(result.targetId).toBeNull();
    expect(result.model).toBe("qwen2.5-coder:7b");
    expect(result.redactedCount).toBe(0);
    // Nothing left the machine, and the local model saw the prompt VERBATIM —
    // redacting it would degrade the draft for no privacy gain.
    expect(sent).toHaveLength(0);
    expect(inference.calls[0]?.prompt).toBe(SECRET_PROMPT);
    expect(inference.calls[0]?.role).toBe("drafter");
  });

  it("uses the local service for a loopback target declared local", async () => {
    const inference = stubInference();
    const { fetchImpl, sent } = captureFetch({});
    const dispatcher = createTargetDispatcher({
      inference,
      settings: {
        ...REMOTE,
        targets: [
          {
            id: "local",
            provider: "ollama",
            base_url: "http://localhost:11434/v1",
            model: "qwen2.5-coder:7b",
            trust: "local",
          },
        ],
      },
      fetchImpl,
      env: {},
    });

    const result = await dispatcher.dispatch({
      role: "drafter",
      prompt: SECRET_PROMPT,
      targetId: "local",
    });
    expect(result.redactedCount).toBe(0);
    expect(sent).toHaveLength(0);
    expect(inference.calls[0]?.prompt).toBe(SECRET_PROMPT);
  });

  it("REFUSES to believe trust:local on a non-loopback URL", async () => {
    // Trust is user-authored config. A typo'd or copy-pasted `trust = "local"`
    // on a remote URL must not turn the redaction bypass into silent egress:
    // config may raise the floor, never assert its way past physics.
    const { fetchImpl, sent } = captureFetch({
      model: "m",
      choices: [{ message: { content: "ok" } }],
    });
    const inference = stubInference();
    const dispatcher = createTargetDispatcher({
      inference,
      settings: {
        ...REMOTE,
        targets: [
          {
            id: "notreallylocal",
            provider: "openai",
            base_url: "https://api.openai.com/v1",
            model: "gpt-5.2",
            trust: "local",
          },
        ],
      },
      fetchImpl,
      env: {},
    });

    await dispatcher.dispatch({
      role: "drafter",
      prompt: SECRET_PROMPT,
      targetId: "notreallylocal",
    });

    // It went out over the network — and it went out REDACTED.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).not.toContain(FAKE_KEY);
    expect(sent[0]?.body).not.toContain(FAKE_EMAIL);
    expect(inference.calls).toHaveLength(0);
  });
});

describe("inference.coder_target — the default coder target (R9.4)", () => {
  it("dispatches to the configured default when a call names no target", async () => {
    const { fetchImpl, sent } = captureFetch({
      model: "m",
      choices: [{ message: { content: "ok" } }],
    });
    const inference = stubInference();
    const dispatcher = createTargetDispatcher({
      inference,
      settings: REMOTE,
      fetchImpl,
      env: {},
      workerTargets: { coder: "cheap" },
    });

    const result = await dispatcher.dispatch({
      role: "drafter",
      prompt: SECRET_PROMPT,
      worker: "coder",
    });

    expect(result.targetId).toBe("cheap");
    expect(inference.calls).toHaveLength(0);
    // Still redacted — a default target is not a trusted one.
    expect(sent[0]?.body).not.toContain(FAKE_KEY);
    expect(result.redactedCount).toBeGreaterThan(0);
  });

  it("lets an explicit target override the default", async () => {
    const { fetchImpl, sent } = captureFetch({
      model: "m",
      content: [{ type: "text", text: "ok" }],
    });
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings: {
        ...REMOTE,
        targets: [
          ...(REMOTE.targets ?? []),
          {
            id: "vendor",
            provider: "anthropic",
            base_url: "https://api.anthropic.com",
            model: "claude-opus-5",
          },
        ],
      },
      fetchImpl,
      env: {},
      workerTargets: { coder: "cheap" },
    });

    const result = await dispatcher.dispatch({
      role: "drafter",
      prompt: "hi",
      worker: "coder",
      targetId: "vendor",
    });
    expect(result.targetId).toBe("vendor");
    expect(sent[0]?.url).toContain("api.anthropic.com");
  });

  it("FAILS CLOSED on an unknown default rather than falling back to local", async () => {
    // Silently drafting locally would report success while ignoring the user's
    // configured choice — the same substitution the registry refuses everywhere.
    const { fetchImpl, sent } = captureFetch({});
    const inference = stubInference();
    const dispatcher = createTargetDispatcher({
      inference,
      settings: REMOTE,
      fetchImpl,
      env: {},
      workerTargets: { coder: "ghost" },
    });

    await expect(
      dispatcher.dispatch({ role: "drafter", prompt: "hi", worker: "coder" }),
    ).rejects.toThrow(/unknown target "ghost"/);
    expect(sent).toHaveLength(0);
    expect(inference.calls).toHaveLength(0);
  });

  it("keeps the local path when no default is configured", async () => {
    const inference = stubInference();
    const dispatcher = createTargetDispatcher({ inference, settings: REMOTE, env: {} });
    const result = await dispatcher.dispatch({ role: "drafter", prompt: "hi", worker: "coder" });
    expect(result.targetId).toBeNull();
    expect(inference.calls).toHaveLength(1);
  });
});

describe("fail-closed selection", () => {
  it("rejects an unknown target rather than falling back", async () => {
    const { fetchImpl, sent } = captureFetch({});
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings: REMOTE,
      fetchImpl,
      env: {},
    });
    await expect(
      dispatcher.dispatch({ role: "drafter", prompt: "hi", targetId: "ghost" }),
    ).rejects.toThrow(TargetDispatchError);
    expect(sent).toHaveLength(0);
  });

  it("rejects a target opted out with agent_selectable = false", async () => {
    const settings: TargetRegistrySettings = {
      ...REMOTE,
      targets: [
        {
          id: "expensive",
          provider: "anthropic",
          base_url: "https://api.anthropic.com",
          model: "claude-opus-5",
          agent_selectable: false,
        },
      ],
    };
    const { fetchImpl, sent } = captureFetch({});
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings,
      fetchImpl,
      env: {},
    });

    await expect(
      dispatcher.dispatch({ role: "drafter", prompt: "hi", targetId: "expensive" }),
    ).rejects.toThrow(/agent_selectable = false/);
    expect(sent).toHaveLength(0);
    // ...and it is not offered in the enum either.
    expect(dispatcher.selectableTargets().map((t) => t.id)).not.toContain("expensive");
  });

  it("lists declared targets as selectable by default", () => {
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings: REMOTE,
      env: {},
    });
    const ids = dispatcher.selectableTargets().map((t) => t.id);
    expect(ids).toContain("cheap");
    // The synthetic default and account-derived rows are selectable too.
    expect(ids).toContain("anthropic");
  });

  it("refuses a modelless remote target instead of asking for nothing", async () => {
    const { fetchImpl, sent } = captureFetch({});
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings: {
        ...REMOTE,
        targets: [{ id: "bare", provider: "openai", base_url: "https://api.openai.com/v1" }],
      },
      fetchImpl,
      env: {},
    });
    await expect(
      dispatcher.dispatch({ role: "drafter", prompt: "hi", targetId: "bare" }),
    ).rejects.toThrow(/declares no model/);
    expect(sent).toHaveLength(0);
  });
});

describe("transport and audit", () => {
  it("sends OpenAI Chat Completions to a translating provider, with the account's key", async () => {
    const { fetchImpl, sent } = captureFetch({
      model: "m",
      choices: [{ message: { content: "ok" } }],
    });
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings: REMOTE,
      fetchImpl,
      env: { GOLEM_UPSTREAM_API_KEY__OPENROUTER: "sk-or-thekey" },
    });
    await dispatcher.dispatch({ role: "drafter", prompt: "hi", targetId: "cheap" });

    // An ABSOLUTE url: upstreamChatCompletionsPath returns a path, because it
    // was built for undici (origin + path), and fetch needs the whole thing.
    expect(sent[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(JSON.parse(sent[0]?.body ?? "{}").model).toBe("openai/gpt-oss-20b:free");
    expect(sent[0]?.headers.authorization).toBe("Bearer sk-or-thekey");
  });

  it("sends Anthropic Messages to a byte-faithful provider", async () => {
    const { fetchImpl, sent } = captureFetch({
      model: "claude-x",
      content: [{ type: "text", text: "ok" }],
    });
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings: {
        ...REMOTE,
        targets: [
          {
            id: "vendor",
            provider: "anthropic",
            base_url: "https://api.anthropic.com",
            model: "claude-opus-5",
          },
        ],
      },
      fetchImpl,
      env: {},
    });
    const result = await dispatcher.dispatch({ role: "drafter", prompt: "hi", targetId: "vendor" });

    expect(sent[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(result.text).toBe("ok");
  });

  it("audits every dispatch with the resolved target and reason, and no secret", async () => {
    const events: unknown[] = [];
    const { fetchImpl } = captureFetch({ model: "m", choices: [{ message: { content: "ok" } }] });
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings: REMOTE,
      fetchImpl,
      env: { GOLEM_UPSTREAM_API_KEY__OPENROUTER: "sk-or-thekey" },
      audit: (e) => events.push(e),
    });
    await dispatcher.dispatch({ role: "drafter", prompt: SECRET_PROMPT, targetId: "cheap" });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      targetId: "cheap",
      provider: "openrouter",
      trust: "third-party",
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("sk-or-thekey");
    expect(serialized).not.toContain(FAKE_KEY);
    expect(serialized).toContain("redacted before dispatch");
  });

  it("surfaces an upstream failure as a clean error, not a partial draft", async () => {
    const fetchImpl = (async () =>
      new Response("nope", {
        status: 429,
        statusText: "Too Many Requests",
      })) as unknown as typeof fetch;
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings: REMOTE,
      fetchImpl,
      env: {},
    });
    await expect(
      dispatcher.dispatch({ role: "drafter", prompt: "hi", targetId: "cheap" }),
    ).rejects.toThrow(/returned 429/);
  });
});
