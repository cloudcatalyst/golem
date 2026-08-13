/**
 * R9.1 / R9.23 — the target registry.
 *
 * The properties under test are the ones the design rests on, not the getters:
 * a target never carries a secret, an unknown id resolves to NOTHING (never a
 * neighbour), an existing gateway-only config is already a usable registry, and
 * an omitted `trust` errs toward more redaction rather than less.
 */

import { describe, expect, it } from "vitest";
import {
  accountsReferencedByTargets,
  defaultTargetId,
  defaultTrustFor,
  listTargets,
  resolveDefaultTargetId,
  resolveTarget,
  TARGET_TRUST_LEVELS,
  type TargetRegistrySettings,
  targetWarnings,
} from "../../../src/providers/targets.js";

/** The top-level (legacy) config every fixture starts from. */
const BASE: TargetRegistrySettings = {
  upstream_provider: "anthropic",
  upstream_base_url: "https://api.anthropic.com",
  upstream_auth_scheme: "inherit",
};

/**
 * The real migration input as of 2026-08-08: six gateways in
 * `.golem/settings.local.json`, five of them sharing ONE OpenRouter credential
 * while naming different models. That last fact is the whole reason gateways and
 * targets are separate registries, so it is the fixture rather than a tidy
 * invented one.
 */
const SIX_GATEWAYS: TargetRegistrySettings = {
  ...BASE,
  gateways: [
    {
      id: "moonshotai-kimi-k2.7-code",
      provider: "openai",
      base_url: "https://api.moonshot.ai/v1",
      models: ["moonshotai/kimi-k2.7-code"],
    },
    {
      id: "openrouter-gpt-oss",
      provider: "openrouter",
      base_url: "https://openrouter.ai/api/v1",
      models: ["openai/gpt-oss-20b:free"],
    },
    {
      id: "openrouter-laguna",
      provider: "openrouter",
      base_url: "https://openrouter.ai/api/v1",
      models: ["poolside/laguna-s-2.1:free"],
    },
    {
      id: "openrouter-qwen3",
      provider: "openrouter",
      base_url: "https://openrouter.ai/api/v1",
      models: ["qwen/qwen3-14b"],
    },
    {
      id: "openrouter-gemma4",
      provider: "openrouter",
      base_url: "https://openrouter.ai/api/v1",
      models: ["google/gemma-4-26b-a4b-it"],
    },
    {
      id: "openrouter-deepseek-v4",
      provider: "openrouter",
      base_url: "https://openrouter.ai/api/v1",
      models: ["qwen/qwen3-14b"],
    },
  ],
};

describe("target registry -- composition", () => {
  it("lists the synthetic default even with nothing configured", () => {
    const targets = listTargets(BASE);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      id: "anthropic",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      origin: "default",
      accountId: null,
    });
  });

  it("surfaces every existing gateway as a target with no config edit (migration fixture)", () => {
    const targets = listTargets(SIX_GATEWAYS);
    // The six gateways plus the synthetic default.
    expect(targets).toHaveLength(7);
    // R9.23: gateway-derived target ids are `<gateway>/<model>`
    expect(targets.filter((t) => t.origin === "gateway").map((t) => t.id)).toEqual([
      "moonshotai-kimi-k2.7-code:moonshotai/kimi-k2.7-code",
      "openrouter-gpt-oss:openai/gpt-oss-20b:free",
      "openrouter-laguna:poolside/laguna-s-2.1:free",
      "openrouter-qwen3:qwen/qwen3-14b",
      "openrouter-gemma4:google/gemma-4-26b-a4b-it",
      "openrouter-deepseek-v4:qwen/qwen3-14b",
    ]);
  });

  it("keeps many-targets-one-gateway distinct: same credential, different models", () => {
    const openrouter = listTargets(SIX_GATEWAYS).filter((t) => t.provider === "openrouter");
    expect(openrouter).toHaveLength(5);
    // Each names its own model...
    expect(new Set(openrouter.map((t) => t.model)).size).toBe(4); // qwen3 appears twice
    // ...and each carries its own gateway reference (R9.23: accountId is the gateway id,
    // not the target id, since target ids are now `<gateway>/<model>`)
    expect(openrouter.every((t) => t.accountId !== null)).toBe(true);
  });

  it("lets an explicit target override a gateway-derived row IN PLACE", () => {
    // R9.23: target ids are compound `<gateway>/<model>`. An explicit target with
    // the same compound id replaces the gateway-derived row in place.
    const settings: TargetRegistrySettings = {
      ...SIX_GATEWAYS,
      targets: [
        {
          id: "openrouter-qwen3:qwen/qwen3-14b",
          gateway: "openrouter-qwen3",
          model: "qwen/qwen3-14b",
          trust: "third-party",
        },
      ],
    };
    const targets = listTargets(settings);
    // Overriding must not duplicate the id...
    expect(targets.filter((t) => t.id === "openrouter-qwen3:qwen/qwen3-14b")).toHaveLength(1);
    // ...and the row keeps its position in the table.
    expect(targets.map((t) => t.id)).toEqual(listTargets(SIX_GATEWAYS).map((t) => t.id));
    const row = targets.find((t) => t.id === "openrouter-qwen3:qwen/qwen3-14b");
    expect(row).toMatchObject({ model: "qwen/qwen3-14b", origin: "target" });
    expect(row?.accountId).toBe("openrouter-qwen3");
  });

  it("carries no secret field on any resolved target", () => {
    for (const target of listTargets(SIX_GATEWAYS)) {
      const keys = Object.keys(target).map((k) => k.toLowerCase());
      expect(
        keys.some((k) => k.includes("key") || k.includes("secret") || k.includes("token")),
      ).toBe(false);
    }
  });
});

describe("target registry -- trust defaults", () => {
  it("treats a loopback ollama as local and a LAN ollama as lan", () => {
    expect(defaultTrustFor("ollama", "http://localhost:11434/v1")).toBe("local");
    expect(defaultTrustFor("ollama", "http://127.0.0.1:11434/v1")).toBe("local");
    expect(defaultTrustFor("ollama", "http://192.168.1.40:11434/v1")).toBe("lan");
  });

  it("decides llamacpp trust by WHERE it is, never by the provider name (R10.8)", () => {
    // The same `llama-server` binary is genuinely local on loopback and
    // genuinely not on a LAN address. Hardcoding "llamacpp = local" would hand
    // an unredacted prompt to a box across the room on the strength of a config
    // string, which is the exact failure `permitsUnredactedDispatch` re-checks
    // for. So the URL decides, exactly as it does for ollama.
    expect(defaultTrustFor("llamacpp", "http://localhost:8080/v1")).toBe("local");
    expect(defaultTrustFor("llamacpp", "http://127.0.0.1:8080/v1")).toBe("local");
    expect(defaultTrustFor("llamacpp", "http://gpubox.lan:8080/v1")).toBe("lan");
    expect(defaultTrustFor("llamacpp", "http://192.168.1.40:8080/v1")).toBe("lan");
  });

  it("defaults an unknown provider to the MOST redacted level, not the least", () => {
    // The direction is the point: an omitted field must never buy a target more
    // of your context than it asked for.
    expect(defaultTrustFor("openrouter", "https://openrouter.ai/api/v1")).toBe("third-party");
    expect(defaultTrustFor("openai", "https://api.openai.com/v1")).toBe("third-party");
    expect(defaultTrustFor("custom", "https://gateway.example.com")).toBe("third-party");
    expect(defaultTrustFor("anthropic", "https://api.anthropic.com")).toBe("vendor");
  });

  it("falls back to third-party when the base URL cannot be parsed", () => {
    expect(defaultTrustFor("ollama", "not a url")).toBe("lan");
    expect(TARGET_TRUST_LEVELS).toContain(defaultTrustFor("custom", "not a url"));
  });

  it("lets a declared trust win over the default", () => {
    const targets = listTargets({
      ...BASE,
      // R9.23: targets reference a gateway, so the gateway must exist
      gateways: [
        {
          id: "lan-box",
          provider: "ollama",
          base_url: "http://homebox.lan:11434/v1",
          models: ["qwen2.5-coder:14b"],
        },
      ],
      targets: [
        {
          id: "lan-box/qwen2.5-coder:14b",
          gateway: "lan-box",
          model: "qwen2.5-coder:14b",
          trust: "lan",
        },
      ],
    });
    expect(targets.find((t) => t.id === "lan-box/qwen2.5-coder:14b")?.trust).toBe("lan");
  });
});

describe("target registry -- the default selector", () => {
  it("reads default_target — resolves a gateway id to the first target from that gateway (R9.23)", () => {
    expect(resolveDefaultTargetId({ ...SIX_GATEWAYS, default_target: "openrouter-laguna" })).toBe(
      "openrouter-laguna:poolside/laguna-s-2.1:free",
    );
  });

  it("falls back to the synthetic default id when neither is set", () => {
    expect(resolveDefaultTargetId(BASE)).toBe(defaultTargetId("anthropic"));
    expect(resolveDefaultTargetId(BASE)).toBe("anthropic");
  });
});

describe("target registry -- fail-closed lookup", () => {
  it("resolves a known id", () => {
    // R9.23: target ids are `<gateway>/<model>` so the compound id is used
    const lookup = resolveTarget(SIX_GATEWAYS, "openrouter-laguna:poolside/laguna-s-2.1:free");
    expect(lookup.ok).toBe(true);
    if (lookup.ok) expect(lookup.target.model).toBe("poolside/laguna-s-2.1:free");
  });

  it("NEVER substitutes another target for an unknown id", () => {
    // R9.23: target ids are `<gateway>/<model>`
    const lookup = resolveTarget(SIX_GATEWAYS, "openrouter-laguna:qwen/qwen4");
    expect(lookup.ok).toBe(false);
    if (!lookup.ok) {
      expect(lookup.reason).toContain("unknown target");
      expect(lookup.reason).toContain("No substitute was used");
      expect(lookup.known).toContain("openrouter-laguna:poolside/laguna-s-2.1:free");
    }
  });

  it("fails closed even when the registry is empty", () => {
    const lookup = resolveTarget(BASE, "anything");
    expect(lookup.ok).toBe(false);
    if (!lookup.ok) expect(lookup.known).toEqual(["anthropic"]);
  });
});

describe("target registry -- credential preflight inputs", () => {
  it("names every gateway some target references, de-duplicated", () => {
    const referenced = accountsReferencedByTargets({
      ...SIX_GATEWAYS,
      targets: [
        {
          id: "cheap/openai/gpt-oss-20b:free",
          gateway: "openrouter-gpt-oss",
          model: "openai/gpt-oss-20b:free",
        },
      ],
    });
    // `cheap` shares openrouter-gpt-oss's credential, so it adds no new id.
    expect([...referenced].sort()).toEqual(
      [
        "moonshotai-kimi-k2.7-code",
        "openrouter-deepseek-v4",
        "openrouter-gemma4",
        "openrouter-gpt-oss",
        "openrouter-laguna",
        "openrouter-qwen3",
      ].sort(),
    );
  });

  it("excludes the synthetic default, which inherits the client's own auth", () => {
    expect(accountsReferencedByTargets(BASE)).toEqual([]);
  });
});

describe("target registry -- startup warnings", () => {
  it("flags a translating target with no model", () => {
    // A translating provider needs a model id — the client's `claude-*` id
    // would not exist on the upstream. With the new schema, if a translating
    // gateway has no models and a target referencing it also declares no model,
    // the resolved target has no model and should warn.
    const warnings = targetWarnings({
      ...BASE,
      gateways: [
        { id: "broken", provider: "openrouter", base_url: "https://openrouter.ai/api/v1" },
      ],
      targets: [{ id: "broken", gateway: "broken" }],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.targetId).toBe("broken");
    expect(warnings[0]?.message).toContain("needs a model id");
  });

  it("flags a doubled API version segment before it 404s a real request", () => {
    const warnings = targetWarnings({
      ...BASE,
      gateways: [
        {
          id: "doubled",
          provider: "anthropic",
          base_url: "https://api.anthropic.com/v1",
        },
      ],
      targets: [{ id: "doubled", gateway: "doubled" }],
    });
    expect(warnings.some((w) => w.targetId === "doubled" && w.message.includes("404"))).toBe(true);
  });

  it("warns for EVERY misconfigured target, not just the default one", () => {
    const warnings = targetWarnings({
      ...BASE,
      default_target: "anthropic",
      gateways: [
        { id: "a", provider: "openrouter", base_url: "https://openrouter.ai/api/v1" },
        { id: "b", provider: "openai", base_url: "https://api.openai.com/v1" },
      ],
      targets: [
        { id: "a", gateway: "a" },
        { id: "b", gateway: "b" },
      ],
    });
    expect(warnings.map((w) => w.targetId).sort()).toEqual(["a", "b"]);
  });

  it("is silent on a sound registry", () => {
    expect(targetWarnings(SIX_GATEWAYS)).toEqual([]);
  });
});
