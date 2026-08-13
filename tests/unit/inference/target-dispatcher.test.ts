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
  gateways: [
    { id: "openrouter", provider: "openrouter", base_url: "https://openrouter.ai/api/v1" },
  ],
  targets: [
    {
      id: "cheap",
      gateway: "openrouter",
      model: "openai/gpt-oss-20b:free",
      trust: "third-party",
    },
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
      env: { GOLEM_UPSTREAM_API_KEY__OPENROUTER: "sk-or-thekey" },
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
      env: { GOLEM_UPSTREAM_API_KEY__OPENROUTER: "sk-or-thekey" },
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

/**
 * R10.8 changed WHEN the local service is reached, and nothing about WHAT
 * happens once it is. The block below is that unchanged half: a `local`-trust
 * loopback target still delegates to the frozen contract with the prompt
 * verbatim, and a `local` claim on a non-loopback URL is still refused.
 *
 * What is gone is the third case that used to head this block — "no target named
 * → local tiered inference". That was never a property of the local path; it was
 * the absence of routing, and it is the defect R10.8 removes. Its replacement
 * lives in "R10.8 — the resolution chain" below.
 */
describe("the local path is unchanged", () => {
  it("uses the local service for a loopback target declared local", async () => {
    const inference = stubInference();
    const { fetchImpl, sent } = captureFetch({});
    const dispatcher = createTargetDispatcher({
      inference,
      settings: {
        ...REMOTE,
        gateways: [
          {
            id: "localgw",
            provider: "ollama",
            base_url: "http://localhost:11434/v1",
            models: ["qwen2.5-coder:7b"],
          },
        ],
        targets: [
          {
            id: "local",
            gateway: "localgw",
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
        gateways: [
          {
            id: "notreallygw",
            provider: "openai",
            base_url: "https://api.openai.com/v1",
            models: ["gpt-5.2"],
          },
        ],
        targets: [
          {
            id: "notreallylocal",
            gateway: "notreallygw",
            model: "gpt-5.2",
            trust: "local",
          },
        ],
      },
      fetchImpl,
      // R9.23: per-gateway env var for a named gateway; GLOBAL key only works for the synthetic default (accountId=null)
      env: { GOLEM_UPSTREAM_API_KEY__NOTREALLYGW: "sk-thekey" },
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
      env: { GOLEM_UPSTREAM_API_KEY__OPENROUTER: "sk-or-thekey" },
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
        gateways: [
          {
            id: "vendorgw",
            provider: "anthropic",
            base_url: "https://api.anthropic.com",
            models: ["claude-opus-5"],
          },
        ],
        targets: [
          ...(REMOTE.targets ?? []),
          {
            id: "vendor",
            gateway: "vendorgw",
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

  it("falls through to the harness default when the worker has no entry (R10.8)", async () => {
    // Pre-R10.8 this drafted locally. It now continues down the chain — there is
    // no `inference.default_target` here either, so it lands on the synthetic
    // default over `proxy.upstream_*`, and the LOCAL SERVICE IS NEVER ASKED.
    const inference = stubInference();
    const { fetchImpl, sent } = captureFetch({
      model: "claude-x",
      content: [{ type: "text", text: "ok" }],
    });
    const dispatcher = createTargetDispatcher({
      inference,
      settings: { ...REMOTE, upstream_model: "claude-sonnet-5" },
      fetchImpl,
      env: {},
      workerTargets: { coder: "" }, // an empty entry is "no entry", not a target id
    });
    const result = await dispatcher.dispatch({ role: "drafter", prompt: "hi", worker: "coder" });
    expect(result.targetId).toBe("anthropic");
    expect(result.route).toBe("harness");
    expect(inference.calls).toHaveLength(0);
    expect(sent).toHaveLength(1);
  });
});

/**
 * R10.8 — `coder` fell through to the LOCAL model whenever nothing named a
 * target, so `inference.default_target` (the setting whose only job is to name
 * the default) was dead config. The chain is now:
 *
 *   explicit targetId → worker_targets[worker] → default_target → harness default
 *
 * Every step below resolves through the SAME fail-closed lookup and the SAME
 * redaction floor; the tests here are about which step wins, and about the two
 * properties that make the change safe — that an unknown `default_target` raises
 * instead of sliding to local, and that the redaction floor still applies to the
 * traffic this change newly routes off-machine.
 */
describe("R10.8 — the resolution chain", () => {
  /** REMOTE plus a second, distinguishable target, so precedence is observable. */
  const CHAIN: TargetRegistrySettings = {
    ...REMOTE,
    upstream_model: "claude-sonnet-5",
    gateways: [
      {
        id: "openrouter",
        provider: "openrouter",
        base_url: "https://openrouter.ai/api/v1",
        models: ["openai/gpt-oss-20b:free"],
      },
      { id: "vendorgw", provider: "anthropic", base_url: "https://api.anthropic.com" },
    ],
    targets: [
      {
        id: "cheap",
        gateway: "openrouter",
        model: "openai/gpt-oss-20b:free",
        trust: "third-party",
      },
      { id: "fallback", gateway: "openrouter", model: "openai/gpt-oss-120b", trust: "third-party" },
      { id: "vendor", gateway: "vendorgw", model: "claude-opus-5", trust: "vendor" },
    ],
  };

  const KEY = { GOLEM_UPSTREAM_API_KEY__OPENROUTER: "sk-or-thekey" };

  it("step 1 — an explicit targetId beats both worker_targets and default_target", async () => {
    const { fetchImpl, sent } = captureFetch({
      model: "m",
      choices: [{ message: { content: "k" } }],
    });
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings: { ...CHAIN, default_target: "fallback" },
      fetchImpl,
      env: KEY,
      workerTargets: { coder: "vendor" },
    });
    const result = await dispatcher.dispatch({
      role: "drafter",
      prompt: "hi",
      worker: "coder",
      targetId: "cheap",
    });
    expect(result.targetId).toBe("cheap");
    expect(result.route).toBe("explicit");
    expect(sent[0]?.url).toContain("openrouter.ai");
  });

  it("step 2 — worker_targets beats default_target", async () => {
    const { fetchImpl } = captureFetch({ model: "m", content: [{ type: "text", text: "k" }] });
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings: { ...CHAIN, default_target: "fallback" },
      fetchImpl,
      env: KEY,
      workerTargets: { coder: "vendor" },
    });
    const result = await dispatcher.dispatch({ role: "drafter", prompt: "hi", worker: "coder" });
    expect(result.targetId).toBe("vendor");
    expect(result.route).toBe("worker");
  });

  it("step 3 — default_target is used when the worker has no entry", async () => {
    // THE DEFECT THIS TASK EXISTS TO CLOSE: this dispatch used to go to the
    // local model, ignoring `default_target` entirely.
    const inference = stubInference();
    const { fetchImpl, sent } = captureFetch({
      model: "m",
      choices: [{ message: { content: "k" } }],
    });
    const dispatcher = createTargetDispatcher({
      inference,
      settings: { ...CHAIN, default_target: "fallback" },
      fetchImpl,
      env: KEY,
    });
    const result = await dispatcher.dispatch({ role: "drafter", prompt: "hi", worker: "coder" });
    expect(result.targetId).toBe("fallback");
    expect(result.route).toBe("default_target");
    expect(inference.calls).toHaveLength(0);
    expect(JSON.parse(sent[0]?.body ?? "{}").model).toBe("openai/gpt-oss-120b");
  });

  it("step 4 — the harness default upstream when nothing names a target at all", async () => {
    const inference = stubInference();
    const { fetchImpl, sent } = captureFetch({
      model: "claude-x",
      content: [{ type: "text", text: "k" }],
    });
    const dispatcher = createTargetDispatcher({
      inference,
      settings: CHAIN,
      fetchImpl,
      env: {},
    });
    const result = await dispatcher.dispatch({ role: "drafter", prompt: "hi", worker: "coder" });
    // The synthetic default over `proxy.upstream_*`, which always exists.
    expect(result.targetId).toBe("anthropic");
    expect(result.route).toBe("harness");
    expect(sent[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(inference.calls).toHaveLength(0);
  });

  it("reaches the harness default with NO local model and NO default_target", async () => {
    // The task's gate, stated directly: a project with neither must still get a
    // draft, and must get it from the harness's own upstream. The stub throws on
    // any local call, so this cannot pass by accidentally drafting locally.
    const exploding: InferenceService = {
      chat: async () => {
        throw new Error("no local model is installed on this machine");
      },
      embed: async () => [],
      capabilities: () => 2 as never,
    };
    const { fetchImpl, sent } = captureFetch({
      model: "claude-x",
      content: [{ type: "text", text: "drafted upstream" }],
    });
    const dispatcher = createTargetDispatcher({
      inference: exploding,
      settings: CHAIN,
      fetchImpl,
      env: {},
    });
    const result = await dispatcher.dispatch({ role: "drafter", prompt: "hi", worker: "coder" });
    expect(result.text).toBe("drafted upstream");
    expect(result.route).toBe("harness");
    expect(sent).toHaveLength(1);
  });

  it("FAILS CLOSED on an unknown default_target, naming what IS configured", async () => {
    // The rule `worker_targets` has always had, now applied to step 3: never a
    // silent slide to the local model, which would send the work somewhere the
    // user did not choose while reporting success.
    const inference = stubInference();
    const { fetchImpl, sent } = captureFetch({});
    const dispatcher = createTargetDispatcher({
      inference,
      settings: { ...CHAIN, default_target: "ghost" },
      fetchImpl,
      env: {},
    });
    await expect(
      dispatcher.dispatch({ role: "drafter", prompt: "hi", worker: "coder" }),
    ).rejects.toThrow(/unknown target "ghost"/);
    // The error names the alternatives and the step that chose the id.
    await expect(
      dispatcher.dispatch({ role: "drafter", prompt: "hi", worker: "coder" }),
    ).rejects.toThrow(/cheap.*fallback.*vendor.*inference\.default_target/s);
    expect(sent).toHaveLength(0);
    expect(inference.calls).toHaveLength(0);
  });

  it("resolves a default_target that names a GATEWAY to that gateway's first target", async () => {
    // R9.23 behaviour, reached through the new step rather than reimplemented.
    const { fetchImpl } = captureFetch({ model: "m", choices: [{ message: { content: "k" } }] });
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings: { ...CHAIN, default_target: "openrouter" },
      fetchImpl,
      env: KEY,
    });
    const result = await dispatcher.dispatch({ role: "drafter", prompt: "hi", worker: "coder" });
    expect(result.targetId).toBe("openrouter:openai/gpt-oss-20b:free");
    expect(result.route).toBe("default_target");
  });

  it("uses THIS SESSION's model when the harness default declares none", async () => {
    // `proxy.upstream_model` is unset on the commonest configuration there is —
    // a byte-faithful Anthropic upstream forwards the client's own id, so there
    // is nothing to configure. Step 4 has no client request to forward, so it
    // asks for the model the session is actually being served. Refusing here
    // would make the last resort unreachable for a fresh project.
    const { fetchImpl, sent } = captureFetch({
      model: "claude-opus-5",
      content: [{ type: "text", text: "ok" }],
    });
    const noUpstreamModel: TargetRegistrySettings = { ...CHAIN };
    delete (noUpstreamModel as { upstream_model?: string }).upstream_model;
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings: noUpstreamModel,
      fetchImpl,
      env: {},
      sessionModel: () => "claude-opus-5",
    });
    const result = await dispatcher.dispatch({ role: "drafter", prompt: "hi", worker: "coder" });
    expect(result.route).toBe("harness");
    expect(JSON.parse(sent[0]?.body ?? "{}").model).toBe("claude-opus-5");
  });

  it("says which step it was on when the harness default has no model to ask", async () => {
    // The last resort can still fail — and when it does the message must name
    // the step it was on and the settings that would fix it, not report a bare
    // "declares no model" about a target the user never chose.
    const noUpstreamModel: TargetRegistrySettings = { ...CHAIN };
    delete (noUpstreamModel as { upstream_model?: string }).upstream_model;
    const { fetchImpl, sent } = captureFetch({});
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings: noUpstreamModel,
      fetchImpl,
      env: {},
    });
    await expect(
      dispatcher.dispatch({ role: "drafter", prompt: "hi", worker: "coder" }),
    ).rejects.toThrow(
      /harness default upstream.*inference\.default_target.*proxy\.upstream_model/s,
    );
    expect(sent).toHaveLength(0);
  });

  it("does NOT borrow the session model for a target the user actually named", async () => {
    // The session-model stand-in is scoped to step 4. A named target that
    // declares no model is a configuration error, and quietly substituting a
    // model for it would hide the mistake.
    const { fetchImpl, sent } = captureFetch({});
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings: {
        ...CHAIN,
        gateways: [
          ...(CHAIN.gateways ?? []),
          { id: "baregw", provider: "openai", base_url: "https://api.openai.com/v1" },
        ],
        targets: [...(CHAIN.targets ?? []), { id: "bare", gateway: "baregw" }],
        default_target: "bare",
      },
      fetchImpl,
      env: {},
      sessionModel: () => "claude-opus-5",
    });
    await expect(
      dispatcher.dispatch({ role: "drafter", prompt: "hi", worker: "coder" }),
    ).rejects.toThrow(/target "bare" declares no model/);
    expect(sent).toHaveLength(0);
  });

  it("still REDACTS the traffic this change newly routes off-machine", async () => {
    // R10.8 sends more work to non-local targets, so the R9.3 trust floor is
    // what makes it safe. An unrouted draft must be redacted exactly like a
    // named one — the gate at the top of this file, on the default path.
    const { fetchImpl, sent } = captureFetch({
      model: "claude-x",
      content: [{ type: "text", text: "ok" }],
    });
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings: CHAIN,
      fetchImpl,
      env: {},
    });
    const result = await dispatcher.dispatch({
      role: "drafter",
      prompt: SECRET_PROMPT,
      worker: "coder",
    });
    expect(sent[0]?.body).not.toContain(FAKE_KEY);
    expect(sent[0]?.body).not.toContain(FAKE_EMAIL);
    expect(sent[0]?.body).toContain("[REDACTED:");
    expect(result.redactedCount).toBeGreaterThan(0);
  });

  it("keeps the local model reachable — by NAMING a target that points at it", async () => {
    // Local stays a full capability. What it stops being is implicit.
    const inference = stubInference();
    const { fetchImpl, sent } = captureFetch({});
    const dispatcher = createTargetDispatcher({
      inference,
      settings: {
        ...CHAIN,
        gateways: [
          ...(CHAIN.gateways ?? []),
          {
            id: "localgw",
            provider: "ollama",
            base_url: "http://localhost:11434/v1",
            models: ["qwen2.5-coder:7b"],
          },
        ],
        default_target: "localgw:qwen2.5-coder:7b",
      },
      fetchImpl,
      env: {},
    });
    const result = await dispatcher.dispatch({
      role: "drafter",
      prompt: SECRET_PROMPT,
      worker: "coder",
    });
    expect(result.route).toBe("default_target");
    expect(result.trust).toBe("local");
    expect(result.redactedCount).toBe(0);
    expect(sent).toHaveLength(0);
    // Verbatim, as before: redacting a prompt that never leaves the machine
    // would degrade the draft for no privacy gain.
    expect(inference.calls[0]?.prompt).toBe(SECRET_PROMPT);
  });

  it("audits WHICH step chose the target, not just which target", async () => {
    const events: { route?: string; reason?: string }[] = [];
    const { fetchImpl } = captureFetch({ model: "m", content: [{ type: "text", text: "k" }] });
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings: CHAIN,
      fetchImpl,
      env: {},
      audit: (e) => events.push(e),
    });
    await dispatcher.dispatch({ role: "drafter", prompt: SECRET_PROMPT, worker: "coder" });
    expect(events[0]?.route).toBe("harness");
    expect(events[0]?.reason).toContain("harness default upstream");
    expect(events[0]?.reason).toContain("redacted before dispatch");
    expect(JSON.stringify(events)).not.toContain(FAKE_KEY);
  });
});

/**
 * R10.8 — `llamacpp` as a first-class provider.
 *
 * It is OpenAI-shaped, so it must ride the existing translating transport rather
 * than a parallel one. What the distinct member buys is the trust default: a
 * loopback llama.cpp is genuinely local, and the same binary on the LAN is
 * genuinely not — and the second case must be redacted at its floor like any
 * other remote.
 */
describe("R10.8 — llamacpp targets", () => {
  function llamacpp(baseUrl: string): TargetRegistrySettings {
    return {
      ...REMOTE,
      gateways: [
        { id: "llama", provider: "llamacpp", base_url: baseUrl, models: ["qwen3-coder-30b"] },
      ],
      targets: [{ id: "llama-local", gateway: "llama", model: "qwen3-coder-30b" }],
    };
  }

  /**
   * R10.9 — REWRITTEN. This test previously asserted the defect as the contract:
   * that a loopback `llamacpp` target produced `sent.length === 0` and arrived at
   * `inference.calls[0]`, i.e. that declaring a llama.cpp server on `:8080` drafted
   * on the Ollama-backed tiered service at `:11434` instead. That is what R10.9
   * fixes, so the assertions had to invert — the previous ones could only pass
   * while the bug was present.
   *
   * Unredacted is still correct here and is unchanged: the endpoint is loopback, so
   * nothing leaves the machine. What changed is WHERE the bytes go.
   */
  it("dispatches a LOOPBACK llama.cpp target to that server, unredacted (R10.9)", async () => {
    const inference = stubInference();
    const { fetchImpl, sent } = captureFetch({
      model: "qwen3-coder-30b",
      choices: [{ message: { content: "draft" } }],
    });
    const audits: { targetId: string | null; reason: string; redactedCount: number }[] = [];
    const dispatcher = createTargetDispatcher({
      inference,
      settings: llamacpp("http://127.0.0.1:8080/v1"),
      fetchImpl,
      env: {},
      audit: (e) => audits.push(e),
    });

    const result = await dispatcher.dispatch({
      role: "drafter",
      prompt: SECRET_PROMPT,
      targetId: "llama-local",
    });

    // Trust was DERIVED as local from the loopback URL — the target declares none.
    expect(result.trust).toBe("local");
    // It reached THAT server, not Ollama. This is the whole defect.
    expect(inference.calls).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toContain("127.0.0.1:8080");
    // Unredacted, because loopback: the prompt arrives whole.
    expect(result.redactedCount).toBe(0);
    expect(sent[0]?.body).toContain(FAKE_KEY);
    expect(result.text).toBe("draft");
    // The gate is proven from the audit record, so it must name the endpoint.
    expect(audits[0]?.reason).toContain("127.0.0.1:8080");
    expect(audits[0]?.reason).toContain("not the tiered service");
  });

  it("still routes a loopback OLLAMA target to the tiered service (role catalog)", async () => {
    // The special case that survives: only `InferenceService` maps a ROLE through
    // the hardware-tier catalog, so it stays the destination when the target really
    // is its endpoint. Narrowing the branch must not break this.
    const inference = stubInference();
    const { fetchImpl, sent } = captureFetch({});
    const dispatcher = createTargetDispatcher({
      inference,
      settings: {
        ...REMOTE,
        gateways: [
          { id: "olla", provider: "ollama", base_url: "http://127.0.0.1:11434", models: ["q"] },
        ],
        targets: [{ id: "olla-local", gateway: "olla", model: "q" }],
      },
      localServiceBaseUrl: "http://127.0.0.1:11434",
      fetchImpl,
      env: {},
    });

    const result = await dispatcher.dispatch({
      role: "drafter",
      prompt: SECRET_PROMPT,
      targetId: "olla-local",
    });

    expect(result.trust).toBe("local");
    expect(result.redactedCount).toBe(0);
    expect(sent).toHaveLength(0);
    expect(inference.calls[0]?.prompt).toBe(SECRET_PROMPT);
  });

  it("distinguishes a second loopback Ollama from the tiered service by ORIGIN", async () => {
    // Two Ollama servers, different ports. The provider name cannot tell them
    // apart; the wired endpoint can. Without `localServiceBaseUrl` this target
    // would be swallowed by the tiered service — the residual imprecision the
    // fallback documents.
    const inference = stubInference();
    const { fetchImpl, sent } = captureFetch({
      model: "q",
      choices: [{ message: { content: "draft" } }],
    });
    const dispatcher = createTargetDispatcher({
      inference,
      settings: {
        ...REMOTE,
        gateways: [
          { id: "olla2", provider: "ollama", base_url: "http://127.0.0.1:11435", models: ["q"] },
        ],
        targets: [{ id: "olla2-local", gateway: "olla2", model: "q" }],
      },
      localServiceBaseUrl: "http://127.0.0.1:11434",
      fetchImpl,
      env: {},
    });

    await dispatcher.dispatch({ role: "drafter", prompt: SECRET_PROMPT, targetId: "olla2-local" });

    expect(inference.calls).toHaveLength(0);
    expect(sent[0]?.url).toContain("127.0.0.1:11435");
  });

  /**
   * R10.9 asked this explicitly: a loopback target whose provider is neither
   * `ollama` nor `llamacpp` must not reach the unredacted branch. `defaultTrustFor`
   * gives it `third-party`, so loopback alone buys nothing — confirming that stays
   * true is the difference between "narrow widening" and "any localhost URL turns
   * redaction off".
   */
  it("does NOT trust a loopback target whose provider is not self-hosted", async () => {
    const inference = stubInference();
    const { fetchImpl, sent } = captureFetch({
      model: "gpt-x",
      choices: [{ message: { content: "ok" } }],
    });
    const dispatcher = createTargetDispatcher({
      inference,
      settings: {
        ...REMOTE,
        gateways: [
          {
            id: "shim",
            provider: "openai",
            base_url: "http://127.0.0.1:9099/v1",
            models: ["gpt-x"],
          },
        ],
        targets: [{ id: "shim-local", gateway: "shim", model: "gpt-x" }],
      },
      fetchImpl,
      env: {},
      // A credential is required for this provider; supply one so the test fails on
      // the redaction question it is asking about, not on auth.
      resolveKey: () => "k",
    });

    const result = await dispatcher.dispatch({
      role: "drafter",
      prompt: SECRET_PROMPT,
      targetId: "shim-local",
    });

    expect(result.trust).toBe("third-party");
    expect(result.redactedCount).toBeGreaterThan(0);
    expect(sent[0]?.body).not.toContain(FAKE_KEY);
    expect(inference.calls).toHaveLength(0);
  });

  it("REDACTS a llama.cpp server on the LAN, at its trust floor", async () => {
    // Same provider, same config shape, different host. Nothing about the name
    // `llamacpp` may buy a target the unredacted path.
    const inference = stubInference();
    const { fetchImpl, sent } = captureFetch({
      model: "qwen3-coder-30b",
      choices: [{ message: { content: "ok" } }],
    });
    const dispatcher = createTargetDispatcher({
      inference,
      settings: llamacpp("http://gpubox.lan:8080/v1"),
      fetchImpl,
      env: {},
    });

    const result = await dispatcher.dispatch({
      role: "drafter",
      prompt: SECRET_PROMPT,
      targetId: "llama-local",
    });

    expect(result.trust).toBe("lan");
    expect(inference.calls).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).not.toContain(FAKE_KEY);
    expect(sent[0]?.body).not.toContain(FAKE_EMAIL);
    expect(result.redactedCount).toBeGreaterThan(0);
    // OpenAI-shaped transport, reused rather than reimplemented.
    expect(sent[0]?.url).toBe("http://gpubox.lan:8080/v1/chat/completions");
  });

  it("dispatches keyless — a missing credential is not an error for llama.cpp", async () => {
    // The most likely thing to get wrong: a keyless gateway tripping the
    // "needs a credential" guard and refusing before it ever sends.
    const { fetchImpl, sent } = captureFetch({
      model: "qwen3-coder-30b",
      choices: [{ message: { content: "ok" } }],
    });
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings: llamacpp("http://gpubox.lan:8080/v1"),
      fetchImpl,
      env: {},
      resolveKey: () => undefined,
    });

    await dispatcher.dispatch({ role: "drafter", prompt: "hi", targetId: "llama-local" });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers.authorization).toBeUndefined();
    expect(sent[0]?.headers["x-api-key"]).toBeUndefined();
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
      gateways: [
        {
          id: "expensivegw",
          provider: "anthropic",
          base_url: "https://api.anthropic.com",
          models: ["claude-opus-5"],
        },
      ],
      targets: [
        {
          id: "expensive",
          gateway: "expensivegw",
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
        gateways: [{ id: "baregw", provider: "openai", base_url: "https://api.openai.com/v1" }],
        targets: [{ id: "bare", gateway: "baregw" }],
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
        gateways: [
          {
            id: "vendorgw2",
            provider: "anthropic",
            base_url: "https://api.anthropic.com",
            models: ["claude-opus-5"],
          },
        ],
        targets: [
          {
            id: "vendor",
            gateway: "vendorgw2",
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
      env: { GOLEM_UPSTREAM_API_KEY__OPENROUTER: "sk-or-thekey" },
    });
    await expect(
      dispatcher.dispatch({ role: "drafter", prompt: "hi", targetId: "cheap" }),
    ).rejects.toThrow(/returned 429/);
  });
});

/**
 * R9.14 — the MCP server inherits no `GOLEM_UPSTREAM_API_KEY__*`, because Claude
 * Code spawns it from `.mcp.json` rather than the CLI spawning it. Before the
 * resolver, every credentialed target dispatched from `coder` went out with no
 * auth header and came back 401 while `golem target list` said the key was
 * stored. These pin both halves: the resolver supplies the key, and a target
 * with no resolvable key fails by NAME rather than as a bare upstream 401.
 */
describe("credential resolution without the environment", () => {
  it("uses resolveKey in preference to the environment", async () => {
    const { fetchImpl, sent } = captureFetch({
      model: "m",
      choices: [{ message: { content: "ok" } }],
    });
    const asked: (string | null)[] = [];
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings: REMOTE,
      fetchImpl,
      env: {}, // deliberately empty — the whole point is that env is not the source
      resolveKey: (accountId) => {
        asked.push(accountId);
        return "sk-from-the-store";
      },
    });

    await dispatcher.dispatch({ role: "drafter", prompt: "hi", targetId: "cheap" });

    expect(asked).toEqual(["openrouter"]);
    expect(sent[0]?.headers.authorization).toBe("Bearer sk-from-the-store");
  });

  it("awaits an async resolver, so the store can be read lazily", async () => {
    const { fetchImpl, sent } = captureFetch({
      model: "m",
      choices: [{ message: { content: "ok" } }],
    });
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings: REMOTE,
      fetchImpl,
      env: {},
      resolveKey: async () => "sk-async",
    });

    await dispatcher.dispatch({ role: "drafter", prompt: "hi", targetId: "cheap" });

    expect(sent[0]?.headers.authorization).toBe("Bearer sk-async");
  });

  it("names the missing credential instead of dispatching unauthenticated", async () => {
    const { fetchImpl, sent } = captureFetch({});
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings: REMOTE,
      fetchImpl,
      env: {},
      resolveKey: () => undefined,
    });

    await expect(
      dispatcher.dispatch({ role: "drafter", prompt: "hi", targetId: "cheap" }),
    ).rejects.toThrow(/needs a credential.*account "openrouter"/s);
    // Nothing was sent: an unauthenticated request would only have earned a 401.
    expect(sent).toHaveLength(0);
  });

  it("still dispatches with no credential when the scheme is inherit", async () => {
    const { fetchImpl, sent } = captureFetch({ content: [{ type: "text", text: "ok" }] });
    const dispatcher = createTargetDispatcher({
      inference: stubInference(),
      settings: {
        ...REMOTE,
        gateways: [
          {
            id: "inheritsgw",
            provider: "anthropic",
            base_url: "https://api.anthropic.com",
            models: ["claude-sonnet-5"],
          },
        ],
        targets: [
          {
            id: "inherits",
            gateway: "inheritsgw",
            model: "claude-sonnet-5",
            trust: "vendor",
          },
        ],
      },
      fetchImpl,
      env: {},
      resolveKey: () => undefined,
    });

    await dispatcher.dispatch({ role: "drafter", prompt: "hi", targetId: "inherits" });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers["x-api-key"]).toBeUndefined();
  });
});
