/**
 * WS-A A1 — header handling for the transparent proxy.
 *
 * Only transport-level (hop-by-hop) headers are touched; every end-to-end
 * header — auth, `anthropic-version`, `anthropic-beta`, rate-limit and
 * `request-id` response headers, custom headers — passes through unchanged.
 */

import type { IncomingHttpHeaders } from "node:http";
import { BYPASS_HEADER } from "./types.js";

/** RFC 9110 §7.6.1 hop-by-hop headers — never forwarded in either direction. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Request-only headers the proxy owns:
 * - `host` is set by the upstream client from the upstream URL;
 * - `content-length` is recomputed from the (possibly pipelined) body;
 * - `expect` is answered locally by Node's HTTP server.
 */
const REQUEST_STRIPPED = new Set(["host", "content-length", "expect"]);

function connectionListedHeaders(headers: IncomingHttpHeaders): Set<string> {
  const value = headers.connection;
  if (typeof value !== "string") return new Set();
  return new Set(
    value
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length > 0),
  );
}

/**
 * Headers to forward upstream: incoming headers minus hop-by-hop headers,
 * proxy-owned request headers, and the `x-golem-bypass` control header.
 */
export function forwardableRequestHeaders(
  headers: IncomingHttpHeaders,
): Record<string, string | string[]> {
  const alsoStripped = connectionListedHeaders(headers);
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(name) || REQUEST_STRIPPED.has(name) || alsoStripped.has(name)) continue;
    if (name === BYPASS_HEADER) continue;
    // Node joins duplicate headers; names are already lowercased.
    out[name] = value;
  }
  return out;
}

/**
 * Headers to relay back to the client: upstream response headers minus
 * hop-by-hop headers. `content-length` (when present) is kept — the body
 * is piped through untouched, so it remains correct.
 */
export function forwardableResponseHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    out[lower] = value;
  }
  return out;
}

/**
 * Whether the request demands pure passthrough. Any value other than an
 * explicit negative ("false" / "0") counts as set, so `x-golem-bypass: true`
 * and a bare `x-golem-bypass: 1` both bypass.
 */
export function isBypassRequest(headers: IncomingHttpHeaders): boolean {
  const raw = headers[BYPASS_HEADER];
  if (raw === undefined) return false;
  const value = (Array.isArray(raw) ? (raw[raw.length - 1] ?? "") : raw).trim().toLowerCase();
  return value !== "false" && value !== "0" && value !== "";
}
