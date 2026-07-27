/**
 * Upstream model DISPLAY helpers (R6.2 status/statusline/extension).
 *
 * Two small pure helpers used to surface *which model* the proxy is fronting:
 *
 * - {@link friendlyModelLabel} turns a raw Claude model id
 *   (`claude-opus-4-8[1m]`) into a short family label (`opus`) for the human
 *   surfaces. Stored data stays the raw id (honest observability); the friendly
 *   form is applied only at render time.
 * - {@link sniffRequestModel} reads the top-level `model` field out of a proxy
 *   request body. On a byte-faithful Anthropic upstream the proxy never parses
 *   the body, so this is the ONLY way it learns the per-request model
 *   (`claude-*`) that Claude Code sent — read-only, never mutating the bytes it
 *   forwards. Bounded and non-throwing so it is safe on the hot response path.
 */

/** Short family labels we recognise in a Claude model id, in match order. */
const MODEL_FAMILIES = ["opus", "sonnet", "haiku", "fable"] as const;

/** A numeric id segment that is really a date/build stamp (8+ digits) — dropped. */
const DATE_SEGMENT_MIN_DIGITS = 8;

/**
 * Default Anthropic vendor/model id surfaced when no upstream model is
 * configured for display. Kept in sync with the Headroom worker default.
 */
export const DEFAULT_ANTHROPIC_VENDOR_MODEL = "anthropic/claude-sonnet-4-5-20250929";

/** First upper, rest lower — `opus` → `Opus`, `qwen` → `Qwen`. */
function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * Split an OpenRouter-style `vendor/model-name` id into its parts. When the id
 * carries no `/`, `defaultVendor` is used (defaults to `anthropic` for the
 * top-level Anthropic passthrough case).
 */
export function parseVendorModel(
  modelId: string,
  defaultVendor = "anthropic",
): { readonly vendor: string; readonly modelName: string } {
  const slash = modelId.indexOf("/");
  if (slash === -1) return { vendor: defaultVendor, modelName: modelId };
  return { vendor: modelId.slice(0, slash), modelName: modelId.slice(slash + 1) };
}

/**
 * Render a vendor/model-name id as the human-facing upstream label,
 * e.g. `moonshotai/kimi-k3` → `moonshotai (kimi-k3)`.
 */
export function formatVendorModelStatus(modelId: string, defaultVendor = "anthropic"): string {
  const { vendor, modelName } = parseVendorModel(modelId, defaultVendor);
  return `${vendor} (${modelName})`;
}

/**
 * A Claude model id as a capitalized family + version for the compact one-liner
 * surfaces, e.g. `claude-opus-4-8[1m]` → `Opus 4.8`,
 * `claude-haiku-4-5-20251001` → `Haiku 4.5` (the trailing date stamp is dropped),
 * `claude-sonnet-5` → `Sonnet 5`. An id with no recognised family (a non-Claude
 * or future name) is returned unchanged. Pure — the richer sibling of
 * {@link friendlyModelLabel}, which collapses to the bare family (`opus`).
 */
export function friendlyModelVersionLabel(modelId: string): string {
  const lower = modelId.toLowerCase();
  const family = MODEL_FAMILIES.find((f) => lower.includes(f));
  if (family === undefined) return modelId;
  // Everything after the family name: strip any `[…]` build suffix and the
  // leading `-`, then keep the run of short numeric segments (`4`, `8`) up to
  // the first non-numeric or date-length (`20251001`) segment.
  const rest = lower
    .slice(lower.indexOf(family) + family.length)
    .replace(/\[[^\]]*\]/g, "")
    .replace(/^-/, "");
  const version: string[] = [];
  for (const seg of rest.split("-")) {
    if (/^\d+$/.test(seg) && seg.length < DATE_SEGMENT_MIN_DIGITS) version.push(seg);
    else break;
  }
  return version.length > 0 ? `${capitalize(family)} ${version.join(".")}` : capitalize(family);
}

/**
 * A local (Ollama) model id as a capitalized family + version, e.g.
 * `qwen2.5-coder:7b` → `Qwen 2.5`, `llama3.1:8b` → `Llama 3.1`,
 * `deepseek-coder-v2:16b` → `Deepseek` (no numeric version immediately follows
 * the family). Empty in → empty out; an id with no leading alphabetic family is
 * returned unchanged. Pure — the versioned sibling of the extension's
 * `friendlyLocalModelLabel` (bare family `qwen`).
 */
export function localModelVersionLabel(modelId: string): string {
  if (modelId === "") return "";
  const beforeTag = modelId.split(":")[0] ?? modelId; // drop `:7b`
  const familyMatch = /^[a-zA-Z]+/.exec(beforeTag);
  if (familyMatch === null) return modelId;
  const family = capitalize(familyMatch[0]);
  const versionMatch = /^[0-9]+(?:\.[0-9]+)*/.exec(beforeTag.slice(familyMatch[0].length));
  return versionMatch !== null ? `${family} ${versionMatch[0]}` : family;
}

/**
 * Map a raw Claude model id to a short human family label for display, e.g.
 * `claude-opus-4-8[1m]` → `opus`, `claude-haiku-4-5-20251001` → `haiku`. An id
 * with no recognised family (a non-Claude model, or a future name) is returned
 * unchanged so the surface still shows *something* truthful. Pure.
 */
export function friendlyModelLabel(modelId: string): string {
  const lower = modelId.toLowerCase();
  for (const family of MODEL_FAMILIES) {
    if (lower.includes(family)) return family;
  }
  return modelId;
}

/**
 * Only scan the head of a request body — the `model` field sits near the top of
 * an Anthropic messages request, and a conversation body can be multi-MB. We
 * deliberately do NOT `JSON.parse` the whole body (wasteful on the hot path, and
 * a truncated slice would not parse at all); a bounded regex over the head is
 * enough to read one top-level string field.
 */
const SNIFF_CAP_BYTES = 64 * 1024;

/** `"model": "<value>"` with JSON whitespace; `[^"\\]` keeps it to a simple (unescaped) id. */
const MODEL_FIELD_RE = /"model"\s*:\s*"([^"\\]+)"/;

/**
 * Extract the string `model` field from the head of a JSON request body, or
 * `undefined` when the body is null or carries no such field. Never throws — a
 * malformed body simply yields `undefined` (observe-only; the forwarded bytes
 * are untouched). Model ids are simple identifiers, so a plain regex over the
 * decoded head is sufficient and cannot be fooled by a `"model"` value nested
 * deep in the messages (that would be past the head cap and, in practice, not a
 * top-level key).
 */
export function sniffRequestModel(body: Buffer | null): string | undefined {
  if (body === null || body.length === 0) return undefined;
  const head = body.length > SNIFF_CAP_BYTES ? body.subarray(0, SNIFF_CAP_BYTES) : body;
  const match = MODEL_FIELD_RE.exec(head.toString("utf8"));
  const model = match?.[1];
  return model !== undefined && model !== "" ? model : undefined;
}
