/**
 * Transport entry points for the unified Golem MCP server (WS-B task B1).
 *
 * - stdio: `serveStdio(deps)` — what `claude mcp add golem -- golem mcp serve`
 *   runs (registration itself is WS-E's `golem init`, task E2).
 * - streamable HTTP: `serveHttp(deps, ...)` — `claude mcp add --transport http
 *   golem http://localhost:<port>/mcp`. Stateful sessions per the MCP
 *   streamable-HTTP spec: the session id is minted on `initialize` and echoed
 *   by clients in the `mcp-session-id` header; each session gets its own
 *   McpServer instance connected to shared deps, so slider state and the CCR
 *   store are shared across sessions.
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createGolemMcpServer, type GolemMcpServerDeps } from "./server.js";

/** Connect the server to stdio and keep serving until the transport closes. */
export async function serveStdio(deps: GolemMcpServerDeps): Promise<void> {
  const server = createGolemMcpServer(deps);
  await server.connect(new StdioServerTransport());
}

export interface ServeHttpOptions {
  /** TCP port; 0 (default) lets the OS pick a free port. */
  readonly port?: number;
  /** Bind host; defaults to loopback only — Golem is a local-first service. */
  readonly host?: string;
  /** URL path for the MCP endpoint (default "/mcp"). */
  readonly path?: string;
}

export interface GolemHttpServerHandle {
  /** The MCP endpoint URL clients should connect to. */
  readonly url: URL;
  /** Close all sessions and stop listening. */
  close(): Promise<void>;
}

const JSONRPC_INVALID_SESSION = JSON.stringify({
  jsonrpc: "2.0",
  error: {
    code: -32000,
    message: "Bad Request: no valid session. Send an initialize request first.",
  },
  id: null,
});

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Start the streamable-HTTP MCP server. Resolves once it is listening. */
export async function serveHttp(
  deps: GolemMcpServerDeps,
  options: ServeHttpOptions = {},
): Promise<GolemHttpServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const mcpPath = options.path ?? "/mcp";
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
    if (url.pathname !== mcpPath) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not Found");
      return;
    }

    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId = typeof sessionIdHeader === "string" ? sessionIdHeader : undefined;
    const existing = sessionId === undefined ? undefined : transports.get(sessionId);

    if (existing !== undefined) {
      await existing.handleRequest(req, res);
      return;
    }

    // No live session: only a POSTed initialize request may open one.
    const body = req.method === "POST" ? await readBody(req) : undefined;
    if (req.method !== "POST" || !isInitializeRequest(body)) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSONRPC_INVALID_SESSION);
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports.set(sid, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId !== undefined) transports.delete(transport.sessionId);
    };
    const server = createGolemMcpServer(deps);
    // Cast: the SDK's transport classes type optional callbacks as
    // `T | undefined` while the Transport interface declares them `prop?:`,
    // which exactOptionalPropertyTypes treats as incompatible (SDK 1.29.0;
    // see verification-notes.md §18).
    await server.connect(transport as Transport);
    await transport.handleRequest(req, res, body);
  };

  const httpServer = createServer((req, res) => {
    handleRequest(req, res).catch((error: unknown) => {
      console.error("golem mcp http error:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" }).end("Internal Server Error");
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port ?? 0, host, resolve);
  });

  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("golem mcp http server did not bind to a TCP port");
  }
  // Bracket IPv6 hosts for a valid URL authority.
  const urlHost = host.includes(":") ? `[${host}]` : host;
  const url = new URL(`http://${urlHost}:${address.port}${mcpPath}`);

  return {
    url,
    close: async () => {
      await Promise.allSettled([...transports.values()].map((t) => t.close()));
      transports.clear();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
