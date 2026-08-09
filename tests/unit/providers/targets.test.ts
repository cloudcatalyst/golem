/**
 * R9.1 — the target registry.
 *
 * The properties under test are the ones the design rests on, not the getters:
 * a target never carries a secret, an unknown id resolves to NOTHING (never a
 * neighbour), an existing account-only config is already a usable registry, and
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
 * The real migration input as of 2026-08-08: six accounts in
 * `.golem/settings.local.json`, five of them sharing ONE OpenRouter credential
 * while naming different models. That last fact is the whole reason accounts and
 * targets are separate registries, so it is the fixture rather than a tidy
 * invented one.
 */
const SIX_ACCOUNTS: TargetRegistrySettings = {
  ...BASE,
  accounts: [
    {
      id: "moonshotai-kimi-k2.7-code",
      provider: "openai",
      base_url: "https://api.moonshot.ai/v1",
      model: "moonshotai/kimi-k2.7-code",
    },
    {
      id: "openrouter-gpt-oss",
      provider: "openrouter",
      base_url: "https://openrouter.ai/api/v1",
      model: "openai/gpt-oss-20b:free",
    },
    {
      id: "openrouter-laguna",
      provider: "openrouter",
      base_url: "https://openrouter.ai/api/v1",
      model: "poolside/laguna-s-2.1:free",
    },
    {
      id: "openrouter-qwen3",
      provider: "openrouter",
      base_url: "https://openrouter.ai/api/v1",
      model: "qwen/qwen3-14b",
    },
    {
      id: "openrouter-gemma4",
      provider: "openrouter",
      base_url: "https://openrouter.ai/api/v1",
      model: "google/gemma-4-26b-a4b-it",
    },
    {
      id: "openrouter-deepseek-v4",
      provider: "openrouter",
      base_url: "https://openrouter.ai/api/v1",
      model: "qwen/qwen3-14b",
    },
  ],
};

describe("target registry — composition", () => {
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

  it("surfaces every existing account as a target with no config edit (migration fixture)", () => {
    const targets = listTargets(SIX_ACCOUNTS);
    // The six accounts plus the synthetic default.
    expect(targets).toHaveLength(7);
    expect(targets.filter((t) => t.origin === "account").map((t) => t.id)).toEqual([
      "moonshotai-kimi-k2.7-code",
      "openrouter-gpt-oss",
      "openrouter-laguna",
      "openrouter-qwen3",
      "openrouter-gemma4",
      "openrouter-deepseek-v4",
    ]);
  });

  it("keeps many-targets-one-account distinct: same credential, different models", () => {
    const openrouter = listTargets(SIX_ACCOUNTS).filter((t) => t.provider === "openrouter");
    expect(openrouter).toHaveLength(5);
    // Each names its own model...
    expect(new Set(openrouter.map((t) => t.model)).size).toBe(4); // qwen3 appears twice
    // ...and each carries its own account reference, so one key can back them all.
    expect(openrouter.every((t) => t.accountId === t.id)).toBe(true);
  });

  it("lets an explicit target override an account-derived row IN PLACE", () => {
    const settings: TargetRegistrySettings = {
      ...SIX_ACCOUNTS,
      targets: [
        {
          id: "openrouter-qwen3",
          provider: "openrouter",
          base_url: "https://openrouter.ai/api/v1",
          model: "qwen/qwen3-32b",
          trust: "third-party",
        },
      ],
    };
    const targets = listTargets(settings);
    // Overriding must not duplicate the id...
    expect(targets.filter((t) => t.id === "openrouter-qwen3")).toHaveLength(1);
    // ...nor move it to the end of the table.
    expect(targets.map((t) => t.id)).toEqual(listTargets(SIX_ACCOUNTS).map((t) => t.id));
    const row = targets.find((t) => t.id === "openrouter-qwen3");
    expect(row).toMatchObject({ model: "qwen/qwen3-32b", origin: "target" });
    // An override with no explicit `account` still inherits the same-id account,
    // so adopting a target does not silently drop its credential.
    expect(row?.accountId).toBe("openrouter-qwen3");
  });

  it("carries no secret field on any resolved target", () => {
    for (const target of listTargets(SIX_ACCOUNTS)) {
      const keys = Object.keys(target).map((k) => k.toLowerCase());
      expect(
        keys.some((k) => k.includes("key") || k.includes("secret") || k.includes("token")),
      ).toBe(false);
    }
  });
});

describe("target registry — trust defaults", () => {
  it("treats a loopback ollama as local and a LAN ollama as lan", () => {
    expect(defaultTrustFor("ollama", "http://localhost:11434/v1")).toBe("local");
    expect(defaultTrustFor("ollama", "http://127.0.0.1:11434/v1")).toBe("local");
    expect(defaultTrustFor("ollama", "http://192.168.1.40:11434/v1")).toBe("lan");
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
      targets: [
        {
          id: "lan-box",
          provider: "ollama",
          base_url: "http://localhost:11434/v1",
          model: "qwen2.5-coder:14b",
          trust: "lan",
        },
      ],
    });
    expect(targets.find((t) => t.id === "lan-box")?.trust).toBe("lan");
  });
});

describe("target registry — the default selector and its migration shim", () => {
  it("reads active_account when default_target is unset (existing config keeps working)", () => {
    expect(resolveDefaultTargetId({ ...SIX_ACCOUNTS, active_account: "openrouter-qwen3" })).toBe(
      "openrouter-qwen3",
    );
  });

  it("prefers default_target once it is set", () => {
    expect(
      resolveDefaultTargetId({
        ...SIX_ACCOUNTS,
        active_account: "openrouter-qwen3",
        default_target: "openrouter-laguna",
      }),
    ).toBe("openrouter-laguna");
  });

  it("falls back to the synthetic default id when neither is set", () => {
    expect(resolveDefaultTargetId(BASE)).toBe(defaultTargetId("anthropic"));
    expect(resolveDefaultTargetId(BASE)).toBe("anthropic");
  });
});

describe("target registry — fail-closed lookup", () => {
  it("resolves a known id", () => {
    const lookup = resolveTarget(SIX_ACCOUNTS, "openrouter-laguna");
    expect(lookup.ok).toBe(true);
    if (lookup.ok) expect(lookup.target.model).toBe("poolside/laguna-s-2.1:free");
  });

  it("NEVER substitutes another target for an unknown id", () => {
    // The failure this exists to prevent: a typo'd or stale id quietly shipping
    // the request — and the context — to a model the caller did not name.
    const lookup = resolveTarget(SIX_ACCOUNTS, "openrouter-qwen4");
    expect(lookup.ok).toBe(false);
    if (!lookup.ok) {
      expect(lookup.reason).toContain("unknown target");
      expect(lookup.reason).toContain("No substitute was used");
      // It reports what DOES exist, so the error is actionable.
      expect(lookup.known).toContain("openrouter-qwen3");
    }
  });

  it("fails closed even when the registry is empty", () => {
    const lookup = resolveTarget(BASE, "anything");
    expect(lookup.ok).toBe(false);
    if (!lookup.ok) expect(lookup.known).toEqual(["anthropic"]);
  });
});

describe("target registry — credential preflight inputs", () => {
  it("names every account some target references, de-duplicated", () => {
    const referenced = accountsReferencedByTargets({
      ...SIX_ACCOUNTS,
      targets: [
        {
          id: "cheap",
          provider: "openrouter",
          base_url: "https://openrouter.ai/api/v1",
          model: "openai/gpt-oss-20b:free",
          account: "openrouter-gpt-oss",
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

describe("target registry — startup warnings", () => {
  it("flags a translating target with no model", () => {
    const warnings = targetWarnings({
      ...BASE,
      targets: [{ id: "broken", provider: "openrouter", base_url: "https://openrouter.ai/api/v1" }],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.targetId).toBe("broken");
    expect(warnings[0]?.message).toContain("needs a model id");
  });

  it("flags a doubled API version segment before it 404s a real request", () => {
    const warnings = targetWarnings({
      ...BASE,
      targets: [
        {
          id: "doubled",
          provider: "anthropic",
          base_url: "https://api.anthropic.com/v1",
        },
      ],
    });
    expect(warnings.some((w) => w.targetId === "doubled" && w.message.includes("404"))).toBe(true);
  });

  it("warns for EVERY misconfigured target, not just the default one", () => {
    const warnings = targetWarnings({
      ...BASE,
      default_target: "anthropic",
      targets: [
        { id: "a", provider: "openrouter", base_url: "https://openrouter.ai/api/v1" },
        { id: "b", provider: "openai", base_url: "https://api.openai.com/v1" },
      ],
    });
    expect(warnings.map((w) => w.targetId).sort()).toEqual(["a", "b"]);
  });

  it("is silent on a sound registry", () => {
    expect(targetWarnings(SIX_ACCOUNTS)).toEqual([]);
  });
});
