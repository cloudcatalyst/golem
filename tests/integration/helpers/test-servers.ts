/**
 * Test scaffolding: a local fake upstream serving recorded shapes, plus a
 * raw HTTP client that reads response bodies as untouched bytes.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "undici";
import { GolemProxy, type ProxyServerOptions } from "../../../src/proxy/index.js";

export type UpstreamHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
) => void | Promise<void>;

export interface FakeUpstream {
  readonly origin: string;
  readonly port: number;
  close(): Promise<void>;
}

/** Start a local fake upstream on an ephemeral port. */
export function startUpstream(handler: UpstreamHandler): Promise<FakeUpstream> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void handler(req, res, Buffer.concat(chunks));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        port,
        close: () =>
          new Promise<void>((res2, rej2) => {
            server.close((err) => (err ? rej2(err) : res2()));
            server.closeAllConnections();
          }),
      });
    });
  });
}

export interface RunningProxy {
  readonly proxy: GolemProxy;
  readonly origin: string;
  close(): Promise<void>;
}

/** Start a GolemProxy on an ephemeral port. */
export async function startProxy(options: ProxyServerOptions): Promise<RunningProxy> {
  const proxy = new GolemProxy(options);
  const addr = await proxy.listen();
  return {
    proxy,
    origin: `http://127.0.0.1:${addr.port}`,
    close: () => proxy.close(),
  };
}

export interface RawResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
}

/**
 * Issue one request and collect the raw body bytes. A fresh undici Client
 * per call keeps tests free of dangling keep-alive sockets.
 */
export async function rawRequest(
  origin: string,
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: Buffer | string;
  } = {},
): Promise<RawResponse> {
  const client = new Client(origin);
  try {
    const response = await client.request({
      path,
      method: (init.method ?? "GET") as "GET" | "POST" | "PUT" | "DELETE" | "HEAD",
      headers: init.headers ?? {},
      body: init.body ?? null,
    });
    const parts: Buffer[] = [];
    for await (const chunk of response.body) {
      parts.push(Buffer.from(chunk as Uint8Array));
    }
    return {
      status: response.statusCode,
      headers: response.headers,
      body: Buffer.concat(parts),
    };
  } finally {
    await client.close();
  }
}

/** Write pre-split chunks to a response with an event-loop tick in between. */
export async function writeChunked(res: ServerResponse, chunks: readonly Buffer[]): Promise<void> {
  for (const chunk of chunks) {
    res.write(chunk);
    await new Promise((resolve) => setImmediate(resolve));
  }
  res.end();
}
