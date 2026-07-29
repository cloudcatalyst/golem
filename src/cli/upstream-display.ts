/**
 * Pure display helpers for "which upstream is this?", split out so that *rendering*
 * an upstream label costs nothing to import.
 *
 * These lived in statusline.ts and status.ts, whose module graphs are ~142ms and
 * ~430ms respectively (init.js, the hooks barrel, the proxy, the local-model probe).
 * The `golem ui` panel needs only these two functions to draw its header, and paying
 * 430ms for a string formatter put the whole first frame behind it — so they moved
 * here, where the only imports are types. statusline.ts and status.ts re-export them,
 * so every existing caller is unaffected. See verification-notes §86c.
 */

import type { StatusReport } from "./status.js";

/**
 * A short, honest label for an upstream base URL: the recognised gateways by name,
 * anything else by host, and an unparseable URL as the fixed string `upstream`
 * (which is also what keeps HTML metacharacters out of the VS Code renderer).
 */
export function upstreamLabel(url: string): string {
  try {
    const host = new URL(url).host.toLowerCase();
    if (host.includes("azure")) return "foundry";
    if (host === "api.anthropic.com") return "anthropic";
    if (host.includes("openrouter")) return "openrouter";
    return host;
  } catch {
    return "upstream";
  }
}

/**
 * Human-readable upstream line, e.g.
 *   `kimi (openai) · api.moonshot.ai · model kimi-k3`
 * or, when the proxy has served a model that differs from the configured one:
 *   `kimi (openai) · api.moonshot.ai · default model kimi-k3 · last served <m>`
 * When no account is active, the leading `<account> ` is dropped.
 */
export function renderUpstream(upstream: StatusReport["upstream"]): string {
  const host = upstreamLabel(upstream.base_url);
  const who =
    upstream.account !== null
      ? `${upstream.account} (${upstream.provider})`
      : `${upstream.provider}`;
  const parts = [who];
  // Skip the host when it's redundant with what `who` already conveys — e.g. an
  // `anthropic` provider whose base URL also labels as `anthropic`.
  if (host !== upstream.provider && host !== upstream.account) parts.push(host);
  const dflt = upstream.default_model;
  const served = upstream.last_served_model ?? null;
  // Model ids are shown verbatim on both sides, so the comparison is a plain
  // id-vs-id one (see providers/model-display.ts — no prettified family labels).
  if (dflt !== null && served !== null && served !== dflt) {
    // A configured default exists AND the proxy served something else — show both so
    // the divergence is visible (e.g. a translating upstream mid-switch).
    parts.push(`default model ${dflt}`);
    parts.push(`last served ${served}`);
  } else if (served !== null) {
    // No configured default (byte-faithful Anthropic), or it matches: the served
    // model IS the live model — show it as the current model.
    parts.push(`model ${served}`);
  } else if (dflt !== null) {
    parts.push(`model ${dflt}`);
  }
  return parts.join(" · ");
}
