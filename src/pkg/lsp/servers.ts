/**
 * The language-server config map (R8.6).
 *
 * One row per server: what to spawn, and which file extensions it answers for.
 * This is data, in the same spirit as `src/ext/manifest.ts` — Golem ships none
 * of these servers' bytes and spawns only what the user already installed.
 *
 * Only `typescript-language-server` is built in, because it is the one row this
 * repo can actually exercise. Everything else is a settings entry
 * (`knowledge.lsp_servers`), so adding `gopls` or `rust-analyzer` is a config
 * change rather than a Golem release — and an unverified row Golem asserted
 * would be exactly the kind of claim Decision 53's registry exists to avoid.
 */

import path from "node:path";

export interface LspServerSpec {
  /** Stable id used in settings and in tool output. */
  readonly id: string;
  /** Executable name resolved on `PATH` (`PATHEXT`-aware on Windows), or an explicit path. */
  readonly command: string;
  /** Argument array — never a shell string (CLAUDE.md cross-platform rule). */
  readonly args: readonly string[];
  /** LSP `languageId` sent in `textDocument/didOpen`. */
  readonly languageId: string;
  /** Lowercase file extensions this row claims, each including the dot. */
  readonly extensions: readonly string[];
}

/**
 * `typescript-language-server --stdio` — the reference row.
 *
 * Installed by the user (`npm i -g typescript-language-server typescript`); on
 * Windows npm installs it as a `.cmd` shim, which is why detection goes through
 * `commandOnPath` rather than a bare `spawn` attempt.
 */
export const TYPESCRIPT_LSP: LspServerSpec = {
  id: "typescript-language-server",
  command: "typescript-language-server",
  args: ["--stdio"],
  languageId: "typescript",
  extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
};

export const DEFAULT_LSP_SERVERS: readonly LspServerSpec[] = [TYPESCRIPT_LSP];

/**
 * The built-in rows with the user's own rows layered on top. A configured row
 * whose `id` matches a built-in **replaces** it, so pointing the TypeScript row
 * at a wrapper script or a pinned local binary is a two-line settings change.
 */
export function resolveLspServers(
  configured: readonly LspServerSpec[] = [],
): readonly LspServerSpec[] {
  const byId = new Map<string, LspServerSpec>();
  for (const spec of [...DEFAULT_LSP_SERVERS, ...configured]) byId.set(spec.id, spec);
  return [...byId.values()];
}

/**
 * The first row claiming this file's extension, or `undefined` when no
 * configured server handles it — which the bridge reports as a no-op, not an
 * error (Decision 53's degrade rule).
 *
 * Later rows win on a tie, so a user row for `.ts` overrides the built-in one
 * even under a different id.
 */
export function serverForFile(
  file: string,
  servers: readonly LspServerSpec[] = DEFAULT_LSP_SERVERS,
): LspServerSpec | undefined {
  const ext = path.extname(file).toLowerCase();
  if (ext.length === 0) return undefined;
  let match: LspServerSpec | undefined;
  for (const spec of servers) {
    if (spec.extensions.some((candidate) => candidate.toLowerCase() === ext)) match = spec;
  }
  return match;
}
