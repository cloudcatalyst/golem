/**
 * R9.2 — the proxy serving many targets.
 *
 * Two real upstream servers stand in for two targets, so "concurrently" is
 * tested rather than asserted: the same proxy instance serves both in one run,
 * which the pre-R9.2 single-`Pool`-in-the-constructor design could not do.
 *
 * The properties under test are the risky ones: an unknown target is refused
 * rather than silently served by the default, a virtual `golem/<id>` model never
 * reaches an upstream, and a proxy with no resolver behaves exactly as before.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRouteResolver } from "../../src/cli/route-resolver.js";
import type { TargetRegistrySettings } from "../../src/providers/index.js";
import { GolemProxy } from "../../src/proxy/index.js";

/** A stub upstream that records what it was sent and answers with its own name. */
interface StubUpstream {
  readonly server: Server;
  readonly url: string;
  readonly seen: { method: string; path: string; body: string }[];
}

async function startUpstream(name: string): Promise<StubUpstream> {
  const seen: { method: string; path: string; body: string }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        path: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ upstream: name }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}`, seen };
}

let alpha: StubUpstream;
let beta: StubUpstream;
let proxy: GolemProxy | undefined;

beforeEach(async () => {
  alpha = await startUpstream("alpha");
  beta = await startUpstream("beta");
});

afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
  await new Promise<void>((resolve) => alpha.server.close(() => resolve()));
  await new Promise<void>((resolve) => beta.server.close(() => resolve()));
});

/** A registry with two Anthropic-protocol targets, one per stub upstream. */
function settings(): TargetRegistrySettings & { map_reasoning_to_thinking: boolean } {
  return {
    upstream_provider: "anthropic",
    upstream_base_url: alpha.url,
    upstream_auth_scheme: "inherit",
    map_reasoning_to_thinking: true,
    targets: [
      { id: "alpha", provider: "anthropic", base_url: alpha.url, model: "claude-alpha" },
      { id: "beta", provider: "anthropic", base_url: beta.url, model: "claude-beta" },
    ],
    default_target: "alpha",
  };
}

async function startProxy(
  overrides: Partial<TargetRegistrySettings> = {},
): Promise<{ base: string }> {
  const merged = { ...settings(), ...overrides };
  proxy = new GolemProxy({
    upstreamBaseUrl: alpha.url,
    resolveRoute: createRouteResolver({ settings: merged }),
  });
  const { port } = await proxy.listen(0, "127.0.0.1");
  return { base: `http://127.0.0.1:${port}` };
}

function post(
  base: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("multi-target proxy routing (R9.2)", () => {
  it("serves TWO targets from one proxy instance", async () => {
    const { base } = await startProxy();

    const a = await post(base, { model: "golem/alpha", messages: [] });
    const b = await post(base, { model: "golem/beta", messages: [] });

    await expect(a.json()).resolves.toEqual({ upstream: "alpha" });
    await expect(b.json()).resolves.toEqual({ upstream: "beta" });
    // The structural claim: one proxy, two upstream origins, both dialled.
    expect(alpha.seen).toHaveLength(1);
    expect(beta.seen).toHaveLength(1);
  });

  it("never forwards a virtual golem/* id — the target's own model is sent", async () => {
    const { base } = await startProxy();
    await post(base, { model: "golem/beta", messages: [] });

    const body = JSON.parse(beta.seen[0]?.body ?? "{}");
    expect(body.model).toBe("claude-beta");
    // No provider has a model called `golem/beta`; forwarding it would 404 at
    // best and fuzzy-match at worst.
    expect(beta.seen[0]?.body).not.toContain("golem/");
  });

  it("routes by header when the body names no virtual id", async () => {
    const { base } = await startProxy();
    await post(base, { model: "claude-opus-5", messages: [] }, { "x-golem-target": "beta" });
    expect(beta.seen).toHaveLength(1);
    // Header routing does NOT rewrite the model — the caller's id is forwarded,
    // because nothing about it was a Golem selector.
    expect(JSON.parse(beta.seen[0]?.body ?? "{}").model).toBe("claude-opus-5");
  });

  it("falls back to default_target when nothing selects one", async () => {
    const { base } = await startProxy();
    await post(base, { model: "claude-opus-5", messages: [] });
    expect(alpha.seen).toHaveLength(1);
    expect(beta.seen).toHaveLength(0);
  });

  it("FAILS CLOSED on an unknown virtual id — no upstream is dialled at all", async () => {
    const { base } = await startProxy();
    const res = await post(base, { model: "golem/ghost", messages: [] });

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("golem/ghost");
    expect(text).toContain("No substitute was used");
    expect(text).toContain("alpha");
    // The whole point: the default target must NOT have quietly served this.
    expect(alpha.seen).toHaveLength(0);
    expect(beta.seen).toHaveLength(0);
  });

  it("FAILS CLOSED on an unknown header target", async () => {
    const { base } = await startProxy();
    const res = await post(
      base,
      { model: "claude-opus-5", messages: [] },
      { "x-golem-target": "ghost" },
    );
    expect(res.status).toBe(400);
    expect(alpha.seen).toHaveLength(0);
    expect(beta.seen).toHaveLength(0);
  });

  it("refuses a virtual id whose target declares no model", async () => {
    // There would be nothing to put in the body — silently forwarding
    // `golem/modelless` is exactly the failure the rewrite exists to prevent.
    const { base } = await startProxy({
      targets: [
        { id: "alpha", provider: "anthropic", base_url: alpha.url, model: "claude-alpha" },
        { id: "modelless", provider: "anthropic", base_url: beta.url },
      ],
    });
    const res = await post(base, { model: "golem/modelless", messages: [] });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("declares no model");
    expect(beta.seen).toHaveLength(0);
  });

  it("routes a body with no model field to the default target, rewriting nothing", async () => {
    // Only a virtual id sets `rewriteModel`, so a modelless body cannot reach
    // the rewrite path at all — it is an ordinary default-target request.
    const { base } = await startProxy();
    const res = await post(base, { messages: [] });
    expect(res.status).toBe(200);
    expect(alpha.seen).toHaveLength(1);
    expect(alpha.seen[0]?.body).not.toContain("model");
  });

  it("keeps the single-upstream path unchanged when NO resolver is configured", async () => {
    // The additive guarantee: without `resolveRoute` the proxy is the code it
    // has always been, serving one upstream and rewriting nothing.
    proxy = new GolemProxy({ upstreamBaseUrl: beta.url });
    const { port } = await proxy.listen(0, "127.0.0.1");
    const res = await post(`http://127.0.0.1:${port}`, {
      model: "golem/alpha",
      messages: [],
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ upstream: "beta" });
    // Untouched: even a golem/* string is forwarded verbatim, because nothing
    // asked this proxy to interpret it.
    expect(JSON.parse(beta.seen[0]?.body ?? "{}").model).toBe("golem/alpha");
  });

  it("binds a conversation to its target so later turns stay put", async () => {
    const bindings = new Map<string, string>();
    const merged = { ...settings() };
    proxy = new GolemProxy({
      upstreamBaseUrl: alpha.url,
      resolveRoute: createRouteResolver({
        settings: merged,
        bindings,
        conversationKeyOf: () => "conv-1",
      }),
    });
    const { port } = await proxy.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;

    // Turn 1 selects beta explicitly...
    await post(base, { model: "claude-opus-5", messages: [] }, { "x-golem-target": "beta" });
    // ...turn 2 says nothing, and must not snap back to the default.
    await post(base, { model: "claude-opus-5", messages: [] });

    expect(beta.seen).toHaveLength(2);
    expect(alpha.seen).toHaveLength(0);
  });

  it("lets an explicit act override an existing binding", async () => {
    const bindings = new Map<string, string>([["conv-1", "beta"]]);
    proxy = new GolemProxy({
      upstreamBaseUrl: alpha.url,
      resolveRoute: createRouteResolver({
        settings: settings(),
        bindings,
        conversationKeyOf: () => "conv-1",
      }),
    });
    const { port } = await proxy.listen(0, "127.0.0.1");
    await post(`http://127.0.0.1:${port}`, { model: "golem/alpha", messages: [] });
    expect(alpha.seen).toHaveLength(1);
    expect(beta.seen).toHaveLength(0);
  });

  it("records the routing reason for the audit trail", async () => {
    const events: { targetId: string; reason: string }[] = [];
    proxy = new GolemProxy({
      upstreamBaseUrl: alpha.url,
      resolveRoute: createRouteResolver({
        settings: settings(),
        onRoute: (e) => events.push({ targetId: e.targetId, reason: e.reason }),
      }),
    });
    const { port } = await proxy.listen(0, "127.0.0.1");
    await post(`http://127.0.0.1:${port}`, { model: "golem/beta", messages: [] });

    expect(events).toHaveLength(1);
    expect(events[0]?.targetId).toBe("beta");
    expect(events[0]?.reason).toContain("virtual model id");
  });
});
