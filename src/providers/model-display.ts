/**
 * Upstream model DISPLAY helpers (R6.2 status/statusline/extension).
 *
 * Model ids are shown VERBATIM on every surface — the id as configured
 * (`inference` catalog / account `model`) or as served (`claude-opus-5[1m]`,
 * `qwen2.5-coder:7b`). There is deliberately no prettifier here: only Claude ids
 * have a marketing family/version to fold into (`Opus 5`), so pretty-printing
 * them alongside raw ids for every other model (`kimi-k3`, `qwen2.5-coder:7b`)
 * made the same line mix two naming schemes. The raw id is also what the user
 * types into config, so it is the label they can act on.
 *
 * - {@link sniffRequestModel} reads the top-level `model` field out of a proxy
 *   request body. On a byte-faithful Anthropic upstream the proxy never parses
 *   the body, so this is the ONLY way it learns the per-request model
 *   (`claude-*`) that Claude Code sent — read-only, never mutating the bytes it
 *   forwards. Bounded and non-throwing so it is safe on the hot response path.
 * - {@link stripVendorPrefix} drops a `vendor/` slug at the translating-provider
 *   boundary (wire-level, not display).
 */

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

/**
 * Strip a leading vendor/provider prefix from a model id when forwarding to an
 * OpenAI-schema or Gemini upstream. Some gateways (OpenRouter, account registries)
 * use slugs like `moonshotai/kimi-k3`, but the upstream API itself expects just
 * `kimi-k3`. Display surfaces keep the raw configured value; this normalization is
 * applied only at the translating-provider boundary.
 *
 * Strips one leading `<vendor>/` segment where `vendor` is non-empty and contains no
 * `/`. Leaves every other shape unchanged, including already-bare ids and ids with
 * multiple slashes (which are treated as opaque).
 */
export function stripVendorPrefix(modelId: string): string {
  const slash = modelId.indexOf("/");
  if (slash <= 0 || slash !== modelId.lastIndexOf("/")) return modelId;
  return modelId.slice(slash + 1);
}
