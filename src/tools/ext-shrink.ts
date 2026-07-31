/**
 * P3b — point the existing `golem bench tools` harness at **caveman-shrink**
 * instead of rebuilding it.
 *
 * `caveman-shrink` (MIT, `mcp-servers/caveman-shrink` in the caveman repo) is MCP
 * middleware that compresses the prose fields of a `tools/list` response. That is
 * the same job Workstream B measured and rejected (`shrink.ts`), so the honest
 * move is not to reimplement it but to run their implementation through the gate
 * that already exists — 27 labelled selection cases plus, since R8.S1, an
 * argument-construction harness that can veto.
 *
 * **Golem ships none of its bytes.** The module is resolved from the *user's own*
 * install (`npm i -g caveman-shrink`, a local `node_modules`, or an explicit path),
 * the same tier-2 shape as `golem ext`: never vendored, never auto-downloaded, and
 * absence is a reported fact.
 *
 * **Absence must not become an identity transform.** If the package cannot be
 * resolved, this returns `null` and the caller refuses to run — a no-op transform
 * would produce a tidy "0% saved, 0 accuracy delta" row that reads like a
 * measurement of their shrinker and is actually a measurement of nothing.
 */

import { createRequire } from "node:module";

export interface ExternalShrinker {
  /** Package name, for the report. */
  readonly name: string;
  /** Resolved filename (or the module id when the resolver cannot say). */
  readonly resolvedFrom: string;
  /** Their transform, normalised to `string → string`. */
  readonly compress: (text: string) => string;
}

/** `compress(text)` returns `{ compressed }` in v0.1.0; a bare string is accepted too. */
function normaliseCompress(fn: (text: string) => unknown): (text: string) => string {
  return (text: string): string => {
    const result = fn(text);
    if (typeof result === "string") return result;
    if (typeof result === "object" && result !== null) {
      const compressed = (result as { compressed?: unknown }).compressed;
      if (typeof compressed === "string") return compressed;
    }
    // Their shape changed (README says pre-1.0). Returning the input keeps the
    // harness from crashing, and the caller sees a zero delta on THAT tool
    // rather than a fabricated saving.
    return text;
  };
}

/**
 * Resolve `caveman-shrink`'s compressor from the user's install, or null.
 *
 * Candidates, in order: an explicit path, `GOLEM_CAVEMAN_SHRINK`, the package's
 * `compress.js` (the pure function — no child process, no stdio proxy), then the
 * package root. Any failure — not installed, not requireable, no `compress` — moves
 * to the next candidate silently: this is a lookup, and its result is reported by
 * the caller, so a warning here would be noise on the "not installed" path.
 */
export function resolveCavemanShrink(opts?: {
  readonly explicitPath?: string;
  readonly requireImpl?: NodeJS.Require;
}): ExternalShrinker | null {
  const req = opts?.requireImpl ?? createRequire(import.meta.url);
  const candidates = [
    opts?.explicitPath,
    process.env.GOLEM_CAVEMAN_SHRINK,
    "caveman-shrink/compress.js",
    "caveman-shrink",
  ].filter((id): id is string => id !== undefined && id !== "");

  for (const id of candidates) {
    let mod: unknown;
    try {
      mod = req(id);
    } catch {
      continue;
    }
    if (typeof mod !== "object" || mod === null) continue;
    const compress = (mod as { compress?: unknown }).compress;
    if (typeof compress !== "function") continue;
    let resolvedFrom = id;
    try {
      resolvedFrom = req.resolve(id);
    } catch {
      // Keep the id: a module that required fine but will not resolve is odd
      // but not a reason to discard a working transform.
    }
    return {
      name: "caveman-shrink",
      resolvedFrom,
      compress: normaliseCompress(compress as (text: string) => unknown),
    };
  }
  return null;
}
