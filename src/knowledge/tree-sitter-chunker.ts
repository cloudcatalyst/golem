/**
 * R3.3 — opt-in syntax-aware code chunking via `web-tree-sitter` (WASM
 * grammars for TS/TSX/JS), splitting on top-level declaration boundaries
 * instead of `chunker.ts`'s line/column heuristic.
 *
 * R8.5 additionally makes this the **symbol** adapter ({@link extractFileFacts}):
 * the repo map needs definitions, references and imports out of the same parse
 * trees. Both live here on purpose — this is the ONLY module that touches
 * `web-tree-sitter`, it owns the single runtime/grammar cache, and no exported
 * signature mentions a tree-sitter type (so `dist`'s `.d.ts` never forces the
 * optional package on a consumer). `repo-map.ts` is pure over the plain data
 * returned here.
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

/* ------------------------------------------------------------------------- *
 * R8.5 — symbol / reference / import extraction for the repo map.
 * ------------------------------------------------------------------------- */

/** What a definition is, as far as a signature skeleton cares. */
export type SymbolKind = "function" | "class" | "method" | "interface" | "type" | "enum" | "const";

/** One definition, reduced to the one line a skeleton shows. */
export interface SymbolDef {
  readonly name: string;
  readonly kind: SymbolKind;
  /** 1-based line of the definition's first character. */
  readonly line: number;
  /** Single-line, whitespace-collapsed signature with the body removed. */
  readonly signature: string;
  readonly exported: boolean;
}

/** Everything one parsed file contributes to the map. */
export interface FileFacts {
  /** Definitions in source order. */
  readonly defs: readonly SymbolDef[];
  /** Identifier → occurrence count, for the reference graph. */
  readonly refs: Readonly<Record<string, number>>;
  /** Raw module specifiers this file imports / re-exports from. */
  readonly imports: readonly string[];
}

/** True when a grammar exists for `ext` (lowercase, with the dot). */
export function isSymbolExtractable(ext: string): boolean {
  return ext in GRAMMAR_BY_EXT;
}

/** Extensions the symbol extractor understands — the map's file filter. */
export const SYMBOL_EXTS: readonly string[] = Object.keys(GRAMMAR_BY_EXT);

/** Signature lines are one-liners; anything longer is elided with `…`. */
const MAX_SIGNATURE_CHARS = 160;

/** Node types whose text is never a reference (strings, comments, JSX text). */
const REF_SKIP_TYPES: ReadonlySet<string> = new Set([
  "comment",
  "string",
  "template_string",
  "string_fragment",
  "jsx_text",
  "regex",
]);

/** Node types that carry an identifier we count as a reference. */
const REF_TYPES: ReadonlySet<string> = new Set([
  "identifier",
  "type_identifier",
  "property_identifier",
  "shorthand_property_identifier",
  "shorthand_property_identifier_pattern",
]);

const DECL_KINDS: Readonly<Record<string, SymbolKind>> = {
  function_declaration: "function",
  generator_function_declaration: "function",
  function_signature: "function",
  class_declaration: "class",
  abstract_class_declaration: "class",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  enum_declaration: "enum",
};

const METHOD_TYPES: ReadonlySet<string> = new Set([
  "method_definition",
  "method_signature",
  "abstract_method_signature",
]);

function namedKids(node: TsNode): TsNode[] {
  const out: TsNode[] = [];
  for (const child of node.namedChildren) {
    if (child !== null && child !== undefined) out.push(child);
  }
  return out;
}

/** Collapse to one line and cap the length — signatures must stay one row. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= MAX_SIGNATURE_CHARS ? flat : `${flat.slice(0, MAX_SIGNATURE_CHARS - 1)}…`;
}

/**
 * A declaration's header: its own text up to where the body starts, so
 * `export function f(a: string): void {` survives and the 200 lines under it do
 * not. Falls back to the node's first line when there is no body (an
 * `interface` member list, an abstract signature).
 */
function headerOf(node: TsNode, content: string): string {
  const body = node.childForFieldName("body");
  const end = body === null ? node.endIndex : body.startIndex;
  const slice = content.slice(node.startIndex, Math.max(node.startIndex, end));
  const trimmed = slice.trimEnd().replace(/[{(\s]+$/u, "");
  return oneLine(trimmed.length > 0 ? trimmed : (slice.split("\n")[0] ?? ""));
}

function nameOf(node: TsNode): string | null {
  const name = node.childForFieldName("name");
  const text = name?.text ?? null;
  return text !== null && text.length > 0 ? text : null;
}

function pushDef(
  out: SymbolDef[],
  node: TsNode,
  content: string,
  kind: SymbolKind,
  exported: boolean,
  name?: string,
): void {
  const symbolName = name ?? nameOf(node);
  if (symbolName === null) return;
  const signature = headerOf(node, content);
  if (signature.length === 0) return;
  out.push({
    name: symbolName,
    kind,
    line: node.startPosition.row + 1,
    signature: exported && !signature.startsWith("export") ? `export ${signature}` : signature,
    exported,
  });
}

/** Class/interface members worth a row: methods, and arrow-valued fields. */
function pushMembers(out: SymbolDef[], node: TsNode, content: string): void {
  const body = node.childForFieldName("body");
  if (body === null) return;
  for (const member of namedKids(body)) {
    if (METHOD_TYPES.has(member.type)) {
      const name = nameOf(member);
      if (name === null) continue;
      out.push({
        name,
        kind: "method",
        line: member.startPosition.row + 1,
        signature: headerOf(member, content),
        exported: false,
      });
    }
  }
}

/**
 * `const x = …` at the top level: an arrow/function value is a function, a
 * plain value is a const. Type-only annotations are kept, initialisers are not
 * — a 3k-char lookup table must not land in the map as one row.
 */
function pushLexical(out: SymbolDef[], node: TsNode, content: string, exported: boolean): void {
  for (const declarator of namedKids(node)) {
    if (declarator.type !== "variable_declarator") continue;
    const name = nameOf(declarator);
    if (name === null) continue;
    const value = declarator.childForFieldName("value");
    const isFn =
      value !== null &&
      (value.type === "arrow_function" ||
        value.type === "function_expression" ||
        value.type === "function");
    const declKeyword = oneLine(content.slice(node.startIndex, declarator.startIndex));
    let signature: string;
    if (isFn && value !== null) {
      // Keep the parameter list, drop the body: `const f = (a: string) =>`.
      const body = value.childForFieldName("body");
      const end = body === null ? value.endIndex : body.startIndex;
      signature = oneLine(content.slice(node.startIndex, end).replace(/[{\s]+$/u, ""));
    } else {
      const type = declarator.childForFieldName("type");
      signature = oneLine(
        `${declKeyword} ${name}${type === null ? "" : content.slice(type.startIndex, type.endIndex)}`,
      );
    }
    out.push({
      name,
      kind: isFn ? "function" : "const",
      line: declarator.startPosition.row + 1,
      signature: exported && !signature.startsWith("export") ? `export ${signature}` : signature,
      exported,
    });
  }
}

/** One top-level statement → zero or more definitions. */
function collectDefs(node: TsNode, content: string, out: SymbolDef[], exported: boolean): void {
  if (node.type === "export_statement") {
    const decl = node.childForFieldName("declaration");
    if (decl !== null) collectDefs(decl, content, out, true);
    return;
  }
  const kind = DECL_KINDS[node.type];
  if (kind !== undefined) {
    pushDef(out, node, content, kind, exported);
    if (kind === "class") pushMembers(out, node, content);
    return;
  }
  if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
    pushLexical(out, node, content, exported);
  }
}

function moduleSpecifier(node: TsNode): string | null {
  const source = node.childForFieldName("source");
  if (source === null) return null;
  const text = source.text.replace(/^['"`]|['"`]$/gu, "");
  return text.length > 0 ? text : null;
}

/** Walk the whole tree once, counting reference identifiers. */
function collectRefs(root: TsNode, refs: Record<string, number>): void {
  const stack: TsNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as TsNode;
    if (REF_SKIP_TYPES.has(node.type)) continue;
    if (REF_TYPES.has(node.type)) {
      const name = node.text;
      if (name.length > 1) refs[name] = (refs[name] ?? 0) + 1;
      continue; // identifiers have no interesting children
    }
    for (const child of node.namedChildren) {
      if (child !== null && child !== undefined) stack.push(child);
    }
  }
}

/**
 * Definitions, references and import specifiers for one file, or `null` when
 * tree-sitter is unavailable / the extension has no grammar / the parse failed.
 * `null` is the no-op signal: the caller drops the file from the map rather
 * than failing (CLAUDE.md's tier-2 rule, Decision 53).
 */
export async function extractFileFacts(ext: string, content: string): Promise<FileFacts | null> {
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

    const defs: SymbolDef[] = [];
    const imports: string[] = [];
    for (const child of namedKids(tree.rootNode)) {
      if (child.type === "import_statement") {
        const spec = moduleSpecifier(child);
        if (spec !== null) imports.push(spec);
        continue;
      }
      if (child.type === "export_statement") {
        const spec = moduleSpecifier(child);
        if (spec !== null) imports.push(spec); // `export … from "./x.js"` is a dependency too
      }
      collectDefs(child, content, defs, false);
    }
    const refs: Record<string, number> = {};
    collectRefs(tree.rootNode, refs);
    return { defs, refs, imports };
  } catch {
    return null;
  }
}

/**
 * R8.7 — "does this still parse?", the syntax half of Golem's edit validation.
 *
 * Returns `true` when the parse tree contains a syntax error, `false` when it is
 * clean, and **`null` when nothing could be checked** (grammar absent,
 * `web-tree-sitter` not installed, unsupported extension). The three-way return
 * matters: an edit validator must never read "could not check" as "clean", or a
 * machine without the optional grammars silently loses the only automatic guard
 * against a local model writing unparseable code.
 *
 * Note tree-sitter is an error-*recovering* parser — it always returns a tree,
 * so `hasError` (not a thrown exception) is the signal. `isMissing` catches the
 * subtler case where recovery inserted a token that was never written.
 */
export async function hasParseError(ext: string, content: string): Promise<boolean | null> {
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
    return tree.rootNode.hasError || tree.rootNode.isMissing;
  } catch {
    return null;
  }
}
