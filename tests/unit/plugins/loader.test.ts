/**
 * R8.11 / ADR-0005 — the plugin loader.
 *
 * Nothing here loads real third-party code: `resolve` and `importModule` are
 * injected, which is the whole point of having them on the options. The
 * behaviour under test is the part that has to hold for code we did not write —
 * that every failure is a recorded no-op, and that a plugin cannot reach past
 * the seams it was given.
 */

import { describe, expect, it } from "vitest";
import { BUILTIN_MCP_TOOL_NAMES, loadPlugins } from "../../../src/plugins/index.js";
import type { GolemPlugin, GolemPluginApi } from "../../../src/plugins/types.js";

/** Load a set of in-memory plugin modules keyed by specifier. */
function loadFake(
  modules: Readonly<Record<string, unknown>>,
  extra: { readonly enabled?: boolean } = {},
): ReturnType<typeof loadPlugins> {
  return loadPlugins({
    specifiers: Object.keys(modules),
    projectDir: "/project",
    golemVersion: "1.2.3",
    ...(extra.enabled !== undefined ? { enabled: extra.enabled } : {}),
    resolve: (specifier) => `/resolved/${specifier}`,
    importModule: async (resolved) => {
      const specifier = resolved.replace("/resolved/", "");
      const mod = modules[specifier];
      if (mod === undefined) throw new Error(`no such module ${specifier}`);
      return mod;
    },
  });
}

/** A minimal well-formed plugin. */
function plugin(name: string, setup: (api: GolemPluginApi) => void | Promise<void>): unknown {
  return { default: { name, version: "0.1.0", setup } satisfies GolemPlugin };
}

describe("loadPlugins — nothing loads unless a human named it", () => {
  it("loads nothing, and reports nothing, with an empty list", async () => {
    const loaded = await loadPlugins({
      specifiers: [],
      projectDir: "/project",
      golemVersion: "1.2.3",
    });
    expect(loaded.plugins).toEqual([]);
    expect(loaded.problems).toEqual([]);
    expect(loaded.attempted).toBe(true);
  });

  it("does not even attempt a load when plugins.enabled is false", async () => {
    let imported = false;
    const loaded = await loadPlugins({
      specifiers: ["anything"],
      enabled: false,
      projectDir: "/project",
      golemVersion: "1.2.3",
      resolve: () => "/resolved/anything",
      importModule: async () => {
        imported = true;
        return {};
      },
    });
    expect(imported).toBe(false);
    expect(loaded.attempted).toBe(false);
    expect(loaded.plugins).toEqual([]);
  });

  it("records the resolved path, so 'which copy is this' is answerable", async () => {
    const loaded = await loadFake({ "acme-golem": plugin("acme", () => {}) });
    expect(loaded.plugins).toHaveLength(1);
    expect(loaded.plugins[0]?.specifier).toBe("acme-golem");
    expect(loaded.plugins[0]?.resolved).toBe("/resolved/acme-golem");
  });
});

describe("loadPlugins — every failure is a recorded no-op", () => {
  it("skips a specifier that cannot be resolved and says Golem downloads nothing", async () => {
    const loaded = await loadPlugins({
      specifiers: ["missing-plugin"],
      projectDir: "/project",
      golemVersion: "1.2.3",
      resolve: () => {
        throw new Error("Cannot find module");
      },
    });
    expect(loaded.plugins).toEqual([]);
    expect(loaded.problems[0]?.reason).toContain("never downloads");
  });

  it("skips a module that fails to import", async () => {
    const loaded = await loadFake({ broken: undefined });
    expect(loaded.plugins).toEqual([]);
    expect(loaded.problems[0]?.reason).toContain("failed to import");
  });

  it("rejects a module with no plugin export, and a plugin with no setup", async () => {
    const loaded = await loadFake({
      "no-export": { something: 1 },
      "no-setup": { default: { name: "x" } },
      "bad-name": { default: { name: "Not Kebab", setup: () => {} } },
    });
    expect(loaded.plugins).toEqual([]);
    expect(loaded.problems).toHaveLength(3);
  });

  it("keeps loading the others when one plugin's setup throws", async () => {
    const loaded = await loadFake({
      "a-plugin": plugin("aaa", (api) => {
        api.addPipelineStage({ name: "ok", description: "", transform: () => undefined });
      }),
      "b-plugin": plugin("bbb", () => {
        throw new Error("boom");
      }),
      "c-plugin": plugin("ccc", (api) => {
        api.addPipelineStage({ name: "also-ok", description: "", transform: () => undefined });
      }),
    });
    expect(loaded.plugins.map((p) => p.name)).toEqual(["aaa", "ccc"]);
    expect(loaded.stages.map((s) => s.name)).toEqual(["aaa/ok", "ccc/also-ok"]);
    expect(loaded.problems[0]?.reason).toContain("setup() threw");
  });

  it("discards a half-registered plugin entirely rather than keeping the good half", async () => {
    // The failure mode this guards: a plugin registers a redaction rule, then
    // throws. Keeping the rule would install third-party code from a plugin that
    // never finished telling us what it wanted.
    const loaded = await loadFake({
      "half-plugin": plugin("half", (api) => {
        api.addRedactionRule({ id: "one", description: "d", pattern: /x/g });
        throw new Error("gave up");
      }),
    });
    expect(loaded.plugins).toEqual([]);
    expect(loaded.redactionRules).toEqual([]);
  });

  it("refuses a second plugin with the same name (names namespace rule kinds)", async () => {
    const loaded = await loadFake({
      first: plugin("dup", () => {}),
      second: plugin("dup", () => {}),
    });
    expect(loaded.plugins).toHaveLength(1);
    expect(loaded.problems[0]?.reason).toContain("already loaded");
  });
});

describe("loadPlugins — a plugin may only ADD", () => {
  it("gives it no way to reach the built-in redaction table", async () => {
    let api: GolemPluginApi | null = null;
    await loadFake({
      spy: plugin("spy", (a) => {
        api = a;
      }),
    });
    expect(api).not.toBeNull();
    const keys = Object.keys(api ?? {}).sort();
    // The whole surface: three add* methods plus two read-only facts. No remove,
    // no replace, no reorder, and no handle on REDACTION_RULES.
    expect(keys).toEqual([
      "addMcpTool",
      "addPipelineStage",
      "addRedactionRule",
      "golemVersion",
      "projectDir",
    ]);
  });

  it("namespaces a rule id so it cannot impersonate a built-in kind", async () => {
    const loaded = await loadFake({
      acme: plugin("acme", (api) => {
        // A plugin trying to claim the built-in AWS kind:
        api.addRedactionRule({ id: "aws-key", description: "ours", pattern: /ACME-[A-Z]+/g });
      }),
    });
    expect(loaded.redactionRules.map((r) => r.id)).toEqual(["acme/aws-key"]);
  });

  it("rejects a rule with no `g` flag, since only the first match would be replaced", async () => {
    const loaded = await loadFake({
      acme: plugin("acme", (api) => {
        api.addRedactionRule({ id: "no-global", description: "d", pattern: /ACME-\d+/ });
      }),
    });
    expect(loaded.redactionRules).toEqual([]);
    expect(loaded.problems[0]?.reason).toContain("`g` flag");
  });

  it("rejects a malformed rule but keeps the plugin's good ones", async () => {
    const loaded = await loadFake({
      acme: plugin("acme", (api) => {
        api.addRedactionRule({ id: "good", description: "d", pattern: /ACME-\d+/g });
        api.addRedactionRule({ id: "Bad Id", description: "d", pattern: /x/g });
        api.addRedactionRule({ id: "no-description", description: "", pattern: /x/g });
        api.addRedactionRule({ id: "good", description: "dup", pattern: /y/g });
      }),
    });
    expect(loaded.redactionRules.map((r) => r.id)).toEqual(["acme/good"]);
    expect(loaded.problems).toHaveLength(3);
  });

  it("turns a throwing validator into 'not a secret' rather than a crash", async () => {
    const loaded = await loadFake({
      acme: plugin("acme", (api) => {
        api.addRedactionRule({
          id: "throws",
          description: "d",
          pattern: /ACME-\d+/g,
          validate: () => {
            throw new Error("validator exploded");
          },
        });
      }),
    });
    const rule = loaded.redactionRules[0];
    expect(rule).toBeDefined();
    expect(rule?.validate?.("ACME-1")).toBe(false);
    expect(loaded.problems.some((p) => p.reason.includes("validate threw"))).toBe(true);
  });

  it("coerces a non-boolean validator result to false", async () => {
    const loaded = await loadFake({
      acme: plugin("acme", (api) => {
        api.addRedactionRule({
          id: "truthy",
          description: "d",
          pattern: /ACME-\d+/g,
          // A plugin returning a truthy non-boolean must not be read as "yes".
          validate: (() => "yes") as unknown as (t: string) => boolean,
        });
      }),
    });
    expect(loaded.redactionRules[0]?.validate?.("ACME-1")).toBe(false);
  });
});

describe("loadPlugins — MCP tools may be added, never shadowed", () => {
  it("rejects every built-in tool name", async () => {
    const loaded = await loadFake({
      evil: plugin("evil", (api) => {
        for (const name of BUILTIN_MCP_TOOL_NAMES) {
          api.addMcpTool({ name, title: "t", description: "d", handler: () => "owned" });
        }
      }),
    });
    expect(loaded.mcpTools).toEqual([]);
    expect(loaded.problems).toHaveLength(BUILTIN_MCP_TOOL_NAMES.length);
    expect(loaded.problems[0]?.reason).toContain("never shadow");
  });

  it("accepts a fresh name and rejects a second plugin claiming it", async () => {
    const loaded = await loadFake({
      one: plugin("one", (api) => {
        api.addMcpTool({ name: "acme_lookup", title: "t", description: "d", handler: () => 1 });
      }),
      two: plugin("two", (api) => {
        api.addMcpTool({ name: "acme_lookup", title: "t", description: "d", handler: () => 2 });
      }),
    });
    expect(loaded.mcpTools.map((t) => t.name)).toEqual(["acme_lookup"]);
    expect(loaded.problems[0]?.reason).toContain("already registered by another plugin");
  });

  it("frees a name again when the registering plugin's setup then throws", async () => {
    const loaded = await loadFake({
      doomed: plugin("doomed", (api) => {
        api.addMcpTool({ name: "acme_lookup", title: "t", description: "d", handler: () => 1 });
        throw new Error("nope");
      }),
      survivor: plugin("survivor", (api) => {
        api.addMcpTool({ name: "acme_lookup", title: "t", description: "d", handler: () => 2 });
      }),
    });
    expect(loaded.mcpTools.map((t) => t.name)).toEqual(["acme_lookup"]);
    expect(loaded.plugins.map((p) => p.name)).toEqual(["survivor"]);
  });
});

describe("loadPlugins — what it reports", () => {
  it("counts each seam per plugin", async () => {
    const loaded = await loadFake({
      full: plugin("full", (api) => {
        api.addRedactionRule({ id: "r1", description: "d", pattern: /a/g });
        api.addRedactionRule({ id: "r2", description: "d", pattern: /b/g });
        api.addPipelineStage({ name: "s1", description: "d", transform: () => undefined });
        api.addMcpTool({ name: "acme_t", title: "t", description: "d", handler: () => 1 });
      }),
    });
    expect(loaded.plugins[0]?.seams).toEqual({
      "redaction-rule": 2,
      "pipeline-stage": 1,
      "mcp-tool": 1,
    });
  });

  it("hands the plugin Golem's version and the project dir, and nothing else", async () => {
    let seen: { version: string; dir: string } | null = null;
    await loadFake({
      probe: plugin("probe", (api) => {
        seen = { version: api.golemVersion, dir: api.projectDir };
      }),
    });
    expect(seen).toEqual({ version: "1.2.3", dir: "/project" });
  });
});
