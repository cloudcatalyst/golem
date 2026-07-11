/**
 * R3.3 — opt-in syntax-aware code chunking via `web-tree-sitter` (WASM
 * grammars for TS/TSX/JS), splitting on top-level declaration boundaries
 * instead of `chunker.ts`'s line/column heuristic.
 *
 * `web-tree-sitter` + the `tree-sitter-typescript`/`tree-sitter-javascript`
 * grammar packages are NEVER a `golem-run` dependency (regular or optional) —
 * CLAUDE.md's "no heavyweight deps in the default install" hard rule and
 * verification-notes §27's rejection of native tree-sitter bindings for the
 * default apply to the WASM payload too. They are a separate, user-installed
 * opt-in (added alongside `golem-run` in the same `node_modules` tree, e.g.
 * as project devDependencies); this module resolves them with a plain
 * dynamic `import()` and degrades to `null` — the caller falls back to the
 * heuristic `chunkCode` — on ANY failure: package absent, WASM init
 * failure, unsupported extension, or a parse error. Ingest never crashes
 * because this feature is or isn't installed.
 *
 * (Type-only import: erased at compile time, so it costs consumers nothing
 * at runtime and doesn't leak into this module's exported types.)
 */

import { createRequire } from "node:module";
import path from "node:path";
import type { Language, Node as TsNode } from "web-tree-sitter";

// `import.meta.resolve` isn't implemented by vite-node's SSR transform (used by
// vitest), only by plain Node ESM — createRequire's resolver works in both.
const require = createRequire(import.meta.url);

import { MAX_CHUNK_CHARS, type RawChunk, windowChunks } from "./chunker.js";

interface GrammarSource {
  readonly pkg: string;
  readonly file: string;
}

const GRAMMAR_BY_EXT: Readonly<Record<string, GrammarSource>> = {
  ".ts": { pkg: "tree-sitter-typescript", file: "tree-sitter-typescript.wasm" },
  ".mts": { pkg: "tree-sitter-typescript", file: "tree-sitter-typescript.wasm" },
  ".cts": { pkg: "tree-sitter-typescript", file: "tree-sitter-typescript.wasm" },
  ".tsx": { pkg: "tree-sitter-typescript", file: "tree-sitter-tsx.wasm" },
  ".js": { pkg: "tree-sitter-javascript", file: "tree-sitter-javascript.wasm" },
  ".jsx": { pkg: "tree-sitter-javascript", file: "tree-sitter-javascript.wasm" },
  ".mjs": { pkg: "tree-sitter-javascript", file: "tree-sitter-javascript.wasm" },
  ".cjs": { pkg: "tree-sitter-javascript", file: "tree-sitter-javascript.wasm" },
};

type TreeSitterModule = typeof import("web-tree-sitter");

let runtimePromise: Promise<TreeSitterModule | null> | null = null;
const languageCache = new Map<string, Language | null>();

/** Load + init web-tree-sitter once; cached across calls. Null if unavailable. */
function loadRuntime(): Promise<TreeSitterModule | null> {
  runtimePromise ??= import("web-tree-sitter")
    .then(async (mod) => {
      await mod.Parser.init();
      return mod;
    })
    .catch(() => null);
  return runtimePromise;
}

/** Resolve + load one grammar's .wasm by walking up from its package.json. */
async function loadLanguage(mod: TreeSitterModule, ext: string): Promise<Language | null> {
  const cached = languageCache.get(ext);
  if (cached !== undefined) return cached;

  const grammar = GRAMMAR_BY_EXT[ext];
  if (grammar === undefined) {
    languageCache.set(ext, null);
    return null;
  }
  try {
    const pkgJsonPath = require.resolve(`${grammar.pkg}/package.json`);
    const wasmPath = path.join(path.dirname(pkgJsonPath), grammar.file);
    const language = await mod.Language.load(wasmPath);
    languageCache.set(ext, language);
    return language;
  } catch {
    languageCache.set(ext, null);
    return null;
  }
}

/** One top-level node → a RawChunk (or windowed sub-chunks if oversized). */
function chunkFromNode(node: TsNode): RawChunk[] {
  const text = node.text;
  if (text.trim() === "") return [];
  const startLine = node.startPosition.row + 1;
  const metadata = { nodeType: node.type };
  if (text.length <= MAX_CHUNK_CHARS) {
    return [{ text, startLine, endLine: node.endPosition.row + 1, kind: "code", metadata }];
  }
  return windowChunks(text.split(/\r?\n/), startLine, "code", metadata);
}

/**
 * Syntax-aware chunking for one file's content, or `null` to signal "not
 * available / not applicable — fall back to the heuristic chunker."
 */
export async function chunkCodeSyntaxAware(
  ext: string,
  content: string,
): Promise<RawChunk[] | null> {
  if (!(ext in GRAMMAR_BY_EXT)) return null;
  const mod = await loadRuntime();
  if (mod === null) return null;
  const language = await loadLanguage(mod, ext);
  if (language === null) return null;

  try {
    const parser = new mod.Parser();
    parser.setLanguage(language);
    const tree = parser.parse(content);
    if (tree === null) return null;
    const out: RawChunk[] = [];
    for (const child of tree.rootNode.children) {
      if (child === null) continue;
      out.push(...chunkFromNode(child));
    }
    return out;
  } catch {
    return null;
  }
}
