/**
 * Redaction seam for the PostToolUse hook (WS-B task B2).
 *
 * T-C3: {@link pipelineRedact} adapts the real src/pipeline/ redaction stage
 * (`REDACTION_RULES` + the high-entropy sweep) to this module's text-level
 * {@link RedactFn} shape, and is now the default the PostToolUse hook applies
 * (see post-tool-use.ts). {@link stripKnownSecrets} is a conservative built-in
 * floor that is ALWAYS applied on top — after any injected or default
 * RedactFn — so nothing can weaken redaction below that floor (CLAUDE.md hard
 * rule: redaction runs before content is stored, and is never weakened).
 * {@link identityRedact} remains available for callers that want no
 * pipeline-stage redaction (e.g. explicit test injection) while still getting
 * the always-on floor.
 */

import { redactStandaloneText } from "../pipeline/index.js";

/**
 * A redaction pass over tool-output text. Must be pure and deterministic.
 * Injection point for the src/pipeline/ redaction stage (task T-C3).
 */
export type RedactFn = (text: string) => string;

/** Identity redaction — a no-op RedactFn (e.g. for isolating the floor in tests). */
export const identityRedact: RedactFn = (text) => text;

/**
 * The real redaction stage (T-C3): the pipeline's full `REDACTION_RULES`
 * table plus the high-entropy sweep, adapted to the text-level {@link RedactFn}
 * shape. Allocates a fresh placeholder table on every call via
 * {@link redactStandaloneText}, so this stays a pure, deterministic
 * `(text) => text` function — required for prompt-cache prefix stability.
 */
export const pipelineRedact: RedactFn = (text) => redactStandaloneText(text);

/**
 * A complete PEM private-key block. Label-anchored on "PRIVATE KEY" so public
 * material (CERTIFICATE, PUBLIC KEY) is left alone: this hook stores tool
 * output for later *retrieval*, so over-stripping public certs would corrupt
 * retrievals for no security gain, while private keys must never be stored.
 */
const PEM_PRIVATE_KEY_BLOCK_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

/**
 * A truncated PEM private-key header with no matching END (e.g. the tool
 * output was cut mid-key). Strip from the header to the end of the text —
 * conservative by design.
 */
const PEM_PRIVATE_KEY_DANGLING_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/g;

/** Anthropic API keys (`sk-ant-...`). Tail charset per observed key format. */
const SK_ANT_KEY_RE = /sk-ant-[A-Za-z0-9_-]{8,}/g;

export const REDACTED_PEM_PLACEHOLDER = "[golem:redacted pem-private-key]";
export const REDACTED_SK_ANT_PLACEHOLDER = "[golem:redacted sk-ant-key]";

/**
 * Built-in conservative secret strip: PEM private-key blocks and `sk-ant-`
 * API keys are replaced with fixed placeholders. This is a floor, not the
 * redaction stage — see the module doc.
 */
export function stripKnownSecrets(text: string): string {
  return text
    .replace(PEM_PRIVATE_KEY_BLOCK_RE, REDACTED_PEM_PLACEHOLDER)
    .replace(PEM_PRIVATE_KEY_DANGLING_RE, REDACTED_PEM_PLACEHOLDER)
    .replace(SK_ANT_KEY_RE, REDACTED_SK_ANT_PLACEHOLDER);
}
