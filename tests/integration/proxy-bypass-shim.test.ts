/**
 * R10.12 / Decision 56 — the bypass shim.
 *
 * `golem proxy stop` keeps the project port bound instead of releasing it,
 * because Claude Code's `ANTHROPIC_BASE_URL` cannot be un-set without a window
 * reload (verification-notes §112b) — so a released port is a dead socket the
 * user cannot escape from. R8.31 built this; the R9.23 batch commit (1992445)
 * deleted `src/cli/proxy-state.ts` and the shim with it, and the defect was open
 * again until R10.12.
 *
 * The load-bearing test is the PAIR at the bottom: the shim redacts even when
 * the live slider says level 0, and a control proves a level-0 non-shim build
 * really does forward the secret. Without the control the first test could keep
 * passing for the wrong reason if the contrast ever disappeared.
 */

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProxyFromSettings } from "../../src/cli/proxy-runtime.js";
import { loadConfig } from "../../src/config/index.js";
import { JsonlTelemetryStore } from "../../src/telemetry/jsonl-store.js";
import { useTempDirs } from "../helpers/tmp.js";

let projectDir: string;
const newTempDir = useTempDirs("golem-shim-");

/** An upstream that records exactly what bytes reached it. */
async function captureUpstream(): Promise<{
  server: Server;
  url: string;
  bodies: string[];
  close: () => Promise<void>;
}> {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", content: [] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    bodies,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

beforeEach(async () => {
  projectDir = await newTempDir();
});

let upstream: Awaited<ReturnType<typeof captureUpstream>> | null = null;
afterEach(async () => {
  await upstream?.close();
  upstream = null;
});

/** Build a proxy against the capture upstream and POST one message through it. */
async function postThrough(
  opts: { shim: boolean; bypassAll?: boolean },
  body: unknown,
): Promise<{ sentUpstream: string }> {
  upstream = await captureUpstream();
  const { settings } = await loadConfig({ projectDir });
  const withUpstream = {
    ...settings,
    proxy: {
      ...settings.proxy,
      upstream_base_url: upstream.url,
      // R11.1: the full bypass is a setting of its own now (ADR-0004), so the
      // control case turns THAT on rather than choosing a dial value that used to
      // mean the same thing.
      ...(opts.bypassAll === true ? { bypass_all: true } : {}),
    },
  };
  const telemetry = new JsonlTelemetryStore(projectDir);
  const { proxy } = buildProxyFromSettings(projectDir, withUpstream, telemetry, {
    ...(opts.shim ? { shim: true } : {}),
  });
  const addr = await proxy.listen(0);
  try {
    await fetch(`http://127.0.0.1:${addr.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    });
  } finally {
    await proxy.close();
  }
  return { sentUpstream: upstream.bodies[0] ?? "" };
}

/** Built at runtime — a literal secret would be redacted out of this file. */
const secret = () => `sk-ant-${"a1b2c3d4".repeat(6)}`;

const messageWith = (text: string) => ({
  model: "claude-opus-5",
  max_tokens: 16,
  messages: [{ role: "user", content: text }],
});

describe("bypass shim (R10.12 / Decision 56)", () => {
  it("still forwards upstream — the port serves rather than refusing", async () => {
    const { sentUpstream } = await postThrough({ shim: true }, messageWith("hello there"));
    // The whole point of the shim: a request through a "stopped" proxy completes.
    expect(sentUpstream).toContain("hello there");
  });

  it("REDACTS even when the live slider says level 0", async () => {
    // Level 0 is the single sanctioned redaction-off path, and a shim that
    // tracked the slider could be moved onto it while presenting itself as
    // "stopped" — a hard-rule breach arriving as a convenience feature. The
    // shim's policy is pinned at module scope precisely so this cannot happen.
    const { sentUpstream } = await postThrough(
      { shim: true, bypassAll: true },
      messageWith(`my key is ${secret()}`),
    );
    expect(sentUpstream).not.toContain(secret());
    expect(sentUpstream).toContain("REDACTED");
  });

  it("CONTROL: a NON-shim build with proxy.bypass_all really does forward the secret", async () => {
    // The load-bearing half. Without it, the test above could keep passing
    // because the contrast disappeared rather than because the shim held.
    const { sentUpstream } = await postThrough(
      { shim: false, bypassAll: true },
      messageWith(`my key is ${secret()}`),
    );
    expect(sentUpstream).toContain(secret());
  });
});
