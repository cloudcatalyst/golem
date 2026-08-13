/**
 * R9.12 — the provenance receipt for a WebFetch Golem served itself.
 *
 * A cache-served WebFetch really runs, against the loopback STUB, so what lands
 * in the transcript is the summarizer's paraphrase of a placeholder: accurate
 * but vague, and worded differently every run. This module produces the
 * deterministic replacement. Pure — everything it needs travels on the
 * rewritten URL, so the hot-path hook never has to open the web cache.
 */

import { parseLoopbackServeUrl } from "../../proxy/loopback-serve.js";

/** Provenance wording for a served WebFetch: one line for the user, more for the model. */
export interface ServedFetchLabel {
  /**
   * Single line for `systemMessage`, the only channel the UI actually shows the
   * user here. A collapsed WebFetch row renders as just `Fetch(url)` — no result
   * line — and the URL it prints is the ORIGINAL input, not our rewrite, so
   * neither the header nor `updatedToolOutput` can carry a visible label.
   */
  readonly line: string;
  /** The fuller receipt that replaces the tool output the model reads. */
  readonly detail: string;
}

/**
 * The provenance label for a WebFetch Golem served, or null when this call is
 * not one of ours (in which case the real fetch's output is left untouched).
 * Pure: everything it needs travels on the rewritten URL.
 */
export function servedFetchLabel(
  toolName: string | undefined,
  toolInput: unknown,
): ServedFetchLabel | null {
  if (toolName !== "WebFetch") return null;
  const input =
    typeof toolInput === "object" && toolInput !== null && !Array.isArray(toolInput)
      ? (toolInput as Record<string, unknown>)
      : null;
  const url = input?.url;
  if (typeof url !== "string") return null;

  const served = parseLoopbackServeUrl(url);
  if (served === null) return null;

  if (served.source === "miss") {
    return {
      line: `Golem: fetched live and cached — ${served.targetUrl}`,
      detail:
        `**Golem** Fetched live from ${served.targetUrl} — now cached.\n` +
        "Golem fetched the raw page itself, so the model received the full page text " +
        "rather than a summary of it.",
    };
  }
  const age = served.age === undefined ? "" : ` (stored ${served.age})`;
  return {
    line: `Golem: served from cache${age} — ${served.targetUrl}`,
    detail:
      `**Golem** Served from cache${age} — ${served.targetUrl}\n` +
      "No network request was made; the page text was delivered to the model directly.",
  };
}
