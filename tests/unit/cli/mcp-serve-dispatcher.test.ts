/**
 * R10.8 — the `coder` dispatcher's WIRING, not its logic.
 *
 * The routing change is worthless if the dispatcher is handed the wrong settings
 * object, and that failure is completely silent: `settings.proxy` satisfies
 * `TargetRegistrySettings` structurally (it still carries the deprecated
 * `proxy.default_target` leaf), so passing it where `withDefaultTarget(settings)`
 * was meant type-checks, throws nothing, and simply ignores the user's
 * `inference.default_target` on every dispatch. Nothing but a test that follows
 * a real setting all the way to the wire can catch that.
 *
 * So these assert on the URL actually requested, given settings written the way
 * a user writes them.
 */

import { describe, expect, it } from "vitest";
import { createCoderDispatcher } from "../../../src/cli/commands/mcp-serve.js";
import { DEFAULT_SETTINGS, type GolemSettings } from "../../../src/config/schema.js";
import { NoDrafterConfiguredError } from "../../../src/inference/target-dispatcher.js";
import type { ChatMessage, InferenceService, Role } from "../../../src/interfaces/inference.js";

/** The frozen contract, stubbed. Records whether the LOCAL path was taken. */
function stubInference(): InferenceService & { calls: number } {
  const service = {
    calls: 0,
    chat: async (role: Role, _messages: readonly ChatMessage[]) => {
      service.calls += 1;
      return {
        text: "local draft",
        model: "qwen2.5-coder:7b",
        role,
        promptTokens: 1,
        completionTokens: 1,
        finishReason: "stop" as const,
      };
    },
    embed: async () => [],
    capabilities: () => 2 as never,
  };
  return service as InferenceService & { calls: number };
}

function captureFetch(reply: Record<string, unknown>): {
  fetchImpl: typeof fetch;
  sent: { url: string; body: string }[];
} {
  const sent: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

/** Settings as a user writes them: the live key is `inference.default_target`. */
function settingsWith(overrides: {
  defaultTarget?: string;
  workerTargets?: Record<string, string>;
}): GolemSettings {
  return {
    ...DEFAULT_SETTINGS,
    proxy: {
      ...DEFAULT_SETTINGS.proxy,
      upstream_provider: "anthropic",
      upstream_base_url: "https://api.anthropic.com",
      upstream_model: "claude-sonnet-5",
      upstream_auth_scheme: "inherit",
      gateways: [
        {
          id: "openrouter",
          provider: "openrouter",
          base_url: "https://openrouter.ai/api/v1",
          models: ["openai/gpt-oss-20b:free"],
        },
      ],
    },
    inference: {
      ...DEFAULT_SETTINGS.inference,
      ...(overrides.defaultTarget !== undefined ? { default_target: overrides.defaultTarget } : {}),
      worker_targets: overrides.workerTargets ?? {},
    },
  } as GolemSettings;
}

describe("R10.8 — createCoderDispatcher passes the MERGED settings", () => {
  it("honours inference.default_target (the bug: raw settings.proxy ignored it)", async () => {
    const inference = stubInference();
    const { fetchImpl, sent } = captureFetch({
      model: "openai/gpt-oss-20b:free",
      choices: [{ message: { content: "ok" } }],
    });
    const dispatcher = createCoderDispatcher(
      settingsWith({ defaultTarget: "openrouter:openai/gpt-oss-20b:free" }),
      inference,
      process.cwd(),
      { fetchImpl, env: {}, resolveKey: () => "sk-or-test", audit: () => {} },
    );

    const result = await dispatcher.dispatch({ role: "drafter", prompt: "hi", worker: "coder" });

    // Had the raw `settings.proxy` been passed, `default_target` would have read
    // as undefined and this would have gone to the harness default instead —
    // with no error anywhere to say so.
    expect(result.targetId).toBe("openrouter:openai/gpt-oss-20b:free");
    expect(result.route).toBe("default_target");
    expect(sent[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(inference.calls).toBe(0);
  });

  it("passes inference.worker_targets through as the worker default", async () => {
    const inference = stubInference();
    const { fetchImpl, sent } = captureFetch({
      model: "openai/gpt-oss-20b:free",
      choices: [{ message: { content: "ok" } }],
    });
    const dispatcher = createCoderDispatcher(
      settingsWith({
        defaultTarget: "anthropic",
        workerTargets: { coder: "openrouter:openai/gpt-oss-20b:free" },
      }),
      inference,
      process.cwd(),
      { fetchImpl, env: {}, resolveKey: () => "sk-or-test", audit: () => {} },
    );

    const result = await dispatcher.dispatch({ role: "drafter", prompt: "hi", worker: "coder" });

    expect(result.route).toBe("worker");
    expect(sent[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  it("reaches the harness default — NOT the local model — when nothing is configured", async () => {
    // The task's gate, through the real wiring: a project with no
    // `worker_targets` and no `default_target` drafts on the harness's own
    // upstream. The local service is present and is still never asked.
    const inference = stubInference();
    const { fetchImpl, sent } = captureFetch({
      model: "claude-sonnet-5",
      content: [{ type: "text", text: "ok" }],
    });
    const dispatcher = createCoderDispatcher(settingsWith({}), inference, process.cwd(), {
      fetchImpl,
      env: {},
      // R13.11 — step 4 is a destination only when Golem holds a credential for
      // that upstream. With none it declines (the test below); the gate this test
      // states is about ROUTING, so give it one.
      resolveKey: () => "sk-ant-stored",
      audit: () => {},
    });

    const result = await dispatcher.dispatch({ role: "drafter", prompt: "hi", worker: "coder" });

    expect(result.route).toBe("harness");
    expect(result.targetId).toBe("anthropic");
    expect(sent[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(inference.calls).toBe(0);
  });

  it("DECLINES through the real wiring when the harness default has no credential", async () => {
    // The reported defect, end to end and in the exact shape a user meets it: a
    // Claude Code session whose upstream is Anthropic on the default `inherit`
    // scheme, with nothing in `worker_targets` or `default_target`. Golem never
    // holds that session's credential, so it cannot originate a request there —
    // this used to POST unauthenticated and surface a bare `401 Unauthorized`,
    // which reads as a broken proxy rather than as "nothing is routed here".
    const inference = stubInference();
    const { fetchImpl, sent } = captureFetch({});
    const dispatcher = createCoderDispatcher(settingsWith({}), inference, process.cwd(), {
      fetchImpl,
      env: {},
      resolveKey: () => undefined,
      audit: () => {},
    });

    await expect(
      dispatcher.dispatch({ role: "drafter", prompt: "hi", worker: "coder" }),
    ).rejects.toThrow(NoDrafterConfiguredError);
    // No request was built, and the local model was NOT quietly used instead:
    // R10.8's rule holds — local is a destination, never a fallback.
    expect(sent).toHaveLength(0);
    expect(inference.calls).toBe(0);
  });

  it("audits the route, so the stderr line says WHICH step chose the target", async () => {
    const events: { route?: string; reason?: string }[] = [];
    const { fetchImpl } = captureFetch({
      model: "claude-sonnet-5",
      content: [{ type: "text", text: "ok" }],
    });
    const dispatcher = createCoderDispatcher(settingsWith({}), stubInference(), process.cwd(), {
      fetchImpl,
      env: {},
      resolveKey: () => "sk-ant-stored",
      audit: (e) => events.push(e),
    });

    await dispatcher.dispatch({ role: "drafter", prompt: "hi", worker: "coder" });

    expect(events[0]?.route).toBe("harness");
    expect(events[0]?.reason).toContain("nothing named a target");
  });
});
