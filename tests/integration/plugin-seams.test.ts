/**
 * R8.11 — the plugin seams against REAL plugin files on disk (ADR-0004).
 *
 * The contract tests pin the redaction seam's structural guarantees. These pin
 * the part that only shows up when something is actually loaded from the
 * filesystem: resolution, consent, pins, and — the ones that matter most —
 * every way a plugin can fail. Decision 53's criterion 3 says absence and
 * failure must degrade to a no-op, so each degrade path below asserts that the
 * request, the pipeline or the tool call *survives*, not merely that an error
 * was recorded.
 *
 * Plugins are written to a temp dir as real ESM modules and imported by the
 * real loader — no mocking of the import, because the import IS the seam.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CompressionService } from "../../src/interfaces/compression.js";
import { sliderPolicyForLevel } from "../../src/interfaces/policy.js";
import { createGolemPipeline } from "../../src/pipeline/index.js";
import {
  clearPluginRedactionRules,
  installPluginRedactionRules,
  pluginRedactionRules,
} from "../../src/pipeline/plugin-rules.js";
import { redactStandaloneText } from "../../src/pipeline/redaction.js";
import { activatePlugins, loadPlugins, runToolQuarantined } from "../../src/plugins/index.js";
import type { ProxyRequest } from "../../src/proxy/types.js";
import { rmTemp } from "../helpers/tmp.js";

const dirs: string[] = [];

afterEach(async () => {
  clearPluginRedactionRules();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, rmTemp)));
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "golem-plugin-"));
  dirs.push(dir);
  return dir;
}

/** Write an ESM plugin file and return the absolute path (used as the specifier). */
async function writePlugin(dir: string, name: string, source: string): Promise<string> {
  const file = path.join(dir, `${name}.mjs`);
  await writeFile(file, source, "utf8");
  return file;
}

const GOOD_PLUGIN = `
export default {
  name: "acme",
  version: "1.0.0",
  redactionRules: [
    { id: "badge-id", description: "ACME badge ids", pattern: "BADGE-\\\\d{8}" },
  ],
  stage: {
    name: "tag",
    transform(ctx) {
      return { body: { ...ctx.body, acme_tagged: true } };
    },
  },
  tools: [
    {
      name: "echo",
      title: "Echo",
      description: "Echo the text back",
      params: [{ name: "text", type: "string", description: "what to echo", required: true }],
      handler(args) { return "echo: " + args.text; },
    },
  ],
};
`;

/** A pipeline whose compression stage does nothing — isolates the plugin stage. */
const NOOP_COMPRESSION: CompressionService = {
  compress: async (messages) => ({
    messagesOut: [...messages],
    refs: [],
    stageSavings: {},
  }),
  retrieve: async () => {
    throw new Error("not used");
  },
  stats: async () => ({
    projectId: "test",
    requests: 0,
    tokensBefore: 0,
    tokensAfter: 0,
    perStage: {},
    ccrRefsStored: 0,
    ccrRefsRetrieved: 0,
  }),
};

function messagesRequest(body: unknown): ProxyRequest {
  return {
    method: "POST",
    url: "/v1/messages",
    headers: {},
    body: Buffer.from(JSON.stringify(body), "utf8"),
  } as ProxyRequest;
}

describe("plugin loading — consent, pins and resolution (ADR-0004 §3)", () => {
  it("loads a plugin from a local path and grants only the seams named", async () => {
    const dir = await makeDir();
    const file = await writePlugin(dir, "acme", GOOD_PLUGIN);

    const result = await loadPlugins(dir, [{ id: "acme", specifier: file, seams: ["redaction"] }]);
    const plugin = result.plugins[0];
    expect(plugin?.failure).toBeUndefined();
    expect(plugin?.redactionRules).toHaveLength(1);
    // The stage and tool exist in the package but were NOT granted, so they are
    // absent — installing is not consent, naming the seam is.
    expect(plugin?.stage).toBeUndefined();
    expect(plugin?.tools).toEqual([]);
    expect(plugin?.detail).toMatch(/not granted/);
  });

  it("grants all three seams when all three are named", async () => {
    const dir = await makeDir();
    const file = await writePlugin(dir, "acme", GOOD_PLUGIN);
    const result = await loadPlugins(dir, [
      { id: "acme", specifier: file, seams: ["redaction", "stage", "tool"] },
    ]);
    const plugin = result.plugins[0];
    expect(plugin?.redactionRules).toHaveLength(1);
    expect(plugin?.stage?.name).toBe("tag");
    expect(plugin?.tools).toHaveLength(1);
  });

  it("contributes nothing when no seams are granted", async () => {
    const dir = await makeDir();
    const file = await writePlugin(dir, "acme", GOOD_PLUGIN);
    const result = await loadPlugins(dir, [{ id: "acme", specifier: file }]);
    expect(result.plugins[0]?.failure).toBe("no-seams-enabled");
    expect(result.plugins[0]?.redactionRules).toEqual([]);
  });

  it("refuses to run a version that does not match the pin", async () => {
    const dir = await makeDir();
    const file = await writePlugin(dir, "acme", GOOD_PLUGIN);
    const result = await loadPlugins(dir, [
      { id: "acme", specifier: file, pin: "2.0.0", seams: ["redaction"] },
    ]);
    expect(result.plugins[0]?.failure).toBe("pin-mismatch");
    expect(result.plugins[0]?.detail).toMatch(/pinned 2\.0\.0, installed 1\.0\.0/);
    expect(result.plugins[0]?.redactionRules).toEqual([]);
  });

  it("loads when the pin matches", async () => {
    const dir = await makeDir();
    const file = await writePlugin(dir, "acme", GOOD_PLUGIN);
    const result = await loadPlugins(dir, [
      { id: "acme", specifier: file, pin: "1.0.0", seams: ["redaction"] },
    ]);
    expect(result.plugins[0]?.failure).toBeUndefined();
  });
});

describe("plugin loading — every failure is a no-op with a reason (criterion 3)", () => {
  it("a plugin that is not installed is `unresolved`, not an error", async () => {
    const dir = await makeDir();
    const result = await loadPlugins(dir, [
      { id: "ghost", specifier: "@nobody/definitely-not-installed", seams: ["redaction"] },
    ]);
    expect(result.plugins[0]?.failure).toBe("unresolved");
    expect(result.plugins[0]?.detail).toMatch(/Golem never installs a plugin/);
    // The reason line and the detail must not simply repeat each other.
    expect(result.plugins[0]?.detail).not.toMatch(/^not installed/);
  });

  it("a plugin that throws on import is `import-failed`, and loading continues", async () => {
    const dir = await makeDir();
    const bad = await writePlugin(dir, "bad", `throw new Error("boom at import");`);
    const good = await writePlugin(dir, "acme", GOOD_PLUGIN);

    const result = await loadPlugins(dir, [
      { id: "bad", specifier: bad, seams: ["redaction"] },
      { id: "acme", specifier: good, seams: ["redaction"] },
    ]);
    expect(result.plugins[0]?.failure).toBe("import-failed");
    expect(result.plugins[0]?.detail).toMatch(/boom at import/);
    // The one after it still loads — a broken plugin does not poison the list.
    expect(result.plugins[1]?.failure).toBeUndefined();
    expect(result.plugins[1]?.redactionRules).toHaveLength(1);
  });

  it("a module that is not a plugin is `invalid-export`", async () => {
    const dir = await makeDir();
    const file = await writePlugin(dir, "notaplugin", `export default { hello: "world" };`);
    const result = await loadPlugins(dir, [{ id: "x", specifier: file, seams: ["redaction"] }]);
    expect(result.plugins[0]?.failure).toBe("invalid-export");
  });

  it("keeps the good rules from a plugin whose other rules are rejected", async () => {
    const dir = await makeDir();
    const file = await writePlugin(
      dir,
      "mixed",
      `export default {
         name: "mixed",
         redactionRules: [
           { id: "ok", description: "fine", pattern: "OK-\\\\d{4}" },
           { id: "redos", description: "bad", pattern: "(a+)+b" },
           { id: "nofunc", description: "hostile", pattern: "X", validate: () => true },
         ],
       };`,
    );
    const result = await loadPlugins(dir, [{ id: "mixed", specifier: file, seams: ["redaction"] }]);
    const plugin = result.plugins[0];
    expect(plugin?.redactionRules).toHaveLength(1);
    expect(plugin?.redactionRules[0]?.id).toBe("mixed/ok");
    expect(plugin?.rejectedRules).toHaveLength(2);
    expect(plugin?.rejectedRules.map((r) => r.reason).join(" ")).toMatch(/backtracking/);
    expect(plugin?.rejectedRules.map((r) => r.reason).join(" ")).toMatch(/must NAME/);
  });
});

describe("activatePlugins — the one call a host makes", () => {
  it("installs seam A, and hands back seam B and seam C for the caller to wire", async () => {
    const dir = await makeDir();
    const file = await writePlugin(dir, "acme", GOOD_PLUGIN);

    clearPluginRedactionRules();
    const active = await activatePlugins(dir, [
      { id: "acme", specifier: file, seams: ["redaction", "stage", "tool"] },
    ]);

    expect(pluginRedactionRules()).toHaveLength(1);
    expect(redactStandaloneText("BADGE-12345678")).toBe("[REDACTED:acme/badge-id:1]");
    expect(active.stages).toHaveLength(1);
    expect(active.tools).toHaveLength(1);
  });

  it("with no entries, installs nothing and changes no redaction output", async () => {
    const dir = await makeDir();
    clearPluginRedactionRules();
    const before = redactStandaloneText("BADGE-12345678 and sk-test");
    const active = await activatePlugins(dir, []);
    expect(pluginRedactionRules()).toEqual([]);
    expect(active.stages).toEqual([]);
    expect(active.tools).toEqual([]);
    expect(redactStandaloneText("BADGE-12345678 and sk-test")).toBe(before);
  });
});

describe("seam B — the pipeline stage and its gate (ADR-0004 threat 6)", () => {
  const stage = {
    pluginName: "acme",
    stage: {
      name: "tag",
      transform: (ctx: { body: Readonly<Record<string, unknown>> }) => ({
        body: { ...ctx.body, acme_tagged: true },
      }),
    },
  };

  async function runAtLevel(level: 0 | 1 | 2 | 3, upstreamBaseUrl: string): Promise<unknown> {
    const pipeline = createGolemPipeline({
      compression: NOOP_COMPRESSION,
      policy: () => sliderPolicyForLevel(level),
      projectId: "test",
      upstreamBaseUrl,
      pluginStages: [stage],
    });
    const out = await pipeline.process(
      messagesRequest({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    );
    return JSON.parse(out.body?.toString("utf8") ?? "{}");
  }

  it("does NOT run at slider ≤1 — the byte-fidelity guarantee is untouched", async () => {
    for (const level of [0, 1] as const) {
      const body = await runAtLevel(level, "https://openrouter.ai/api/v1");
      expect(body).not.toHaveProperty("acme_tagged");
    }
  });

  it("does NOT run against a caching upstream, even at slider 3 (Decision 31)", async () => {
    const body = await runAtLevel(3, "https://api.anthropic.com");
    expect(body).not.toHaveProperty("acme_tagged");
  });

  it("runs at slider ≥2 on a non-caching upstream", async () => {
    const body = await runAtLevel(2, "https://openrouter.ai/api/v1");
    expect(body).toHaveProperty("acme_tagged", true);
  });

  it("a stage that throws is a no-op — the request still goes through", async () => {
    const pipeline = createGolemPipeline({
      compression: NOOP_COMPRESSION,
      policy: () => sliderPolicyForLevel(2),
      projectId: "test",
      upstreamBaseUrl: "https://openrouter.ai/api/v1",
      pluginStages: [
        {
          pluginName: "hostile",
          stage: {
            name: "explode",
            transform: () => {
              throw new Error("boom");
            },
          },
        },
      ],
    });
    const original = messagesRequest({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const out = await pipeline.process(original);
    expect(JSON.parse(out.body?.toString("utf8") ?? "{}")).toHaveProperty("messages");
  });

  it("a stage returning a body without messages is refused", async () => {
    const pipeline = createGolemPipeline({
      compression: NOOP_COMPRESSION,
      policy: () => sliderPolicyForLevel(2),
      projectId: "test",
      upstreamBaseUrl: "https://openrouter.ai/api/v1",
      pluginStages: [
        {
          pluginName: "sloppy",
          stage: { name: "drop", transform: () => ({ body: { model: "m" } }) },
        },
      ],
    });
    const out = await pipeline.process(
      messagesRequest({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    );
    const body = JSON.parse(out.body?.toString("utf8") ?? "{}") as Record<string, unknown>;
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it("runs on already-redacted content — a stage never sees a secret", async () => {
    clearPluginRedactionRules();
    let seen = "";
    const pipeline = createGolemPipeline({
      compression: NOOP_COMPRESSION,
      policy: () => sliderPolicyForLevel(2),
      projectId: "test",
      upstreamBaseUrl: "https://openrouter.ai/api/v1",
      pluginStages: [
        {
          pluginName: "watcher",
          stage: {
            name: "observe",
            transform: (ctx) => {
              seen = JSON.stringify(ctx.body);
              return null;
            },
          },
        },
      ],
    });
    await pipeline.process(
      messagesRequest({
        model: "m",
        messages: [{ role: "user", content: "my key is AKIAIOSFODNN7EXAMPLE ok" }],
      }),
    );
    expect(seen).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(seen).toContain("REDACTED");
  });
});

describe("seam C — tool quarantine (ADR-0004 threat 8)", () => {
  const ctx = { projectDir: ".", log: () => {} };

  it("returns the handler's text", async () => {
    const outcome = await runToolQuarantined(
      "acme",
      { name: "echo", title: "Echo", description: "", handler: (args) => `echo: ${args.text}` },
      { text: "hi" },
      ctx,
    );
    expect(outcome).toEqual({ text: "echo: hi", isError: false });
  });

  it("turns a throw into a tool error, never a server crash", async () => {
    const outcome = await runToolQuarantined(
      "acme",
      {
        name: "boom",
        title: "Boom",
        description: "",
        handler: () => {
          throw new Error("nope");
        },
      },
      {},
      ctx,
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/nope/);
  });

  it("refuses a non-string result", async () => {
    const outcome = await runToolQuarantined(
      "acme",
      {
        name: "weird",
        title: "Weird",
        description: "",
        handler: () => ({ not: "a string" }) as unknown as string,
      },
      {},
      ctx,
    );
    expect(outcome.isError).toBe(true);
  });
});

describe("the shipped default is byte-identical to no plugin support", () => {
  it("an empty registry leaves redaction output unchanged", () => {
    clearPluginRedactionRules();
    const text = "AKIAIOSFODNN7EXAMPLE and BADGE-12345678";
    const before = redactStandaloneText(text);
    installPluginRedactionRules([]);
    expect(redactStandaloneText(text)).toBe(before);
    // The built-in still fires; the unmatched org format is simply not a secret
    // Golem knows about — which is exactly the gap seam A exists to close.
    expect(before).toContain("REDACTED");
    expect(before).toContain("BADGE-12345678");
  });
});
