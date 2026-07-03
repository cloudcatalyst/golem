/**
 * Redaction seam for the PostToolUse hook (WS-B task B2).
 *
 * ⚠ TODO(T-C3): the real redaction stage lives in src/pipeline/ and had not
 * shipped when B2 was built (src/pipeline/index.ts is a placeholder). Until
 * the integrator wires the pipeline's redaction in via
 * {@link PostToolUseOptions.redact}, only {@link stripKnownSecrets} protects
 * stored originals. That built-in strip is deliberately conservative and is
 * ALWAYS applied — after any injected RedactFn — so injection can only
 * strengthen redaction, never weaken it (CLAUDE.md hard rule: redaction runs
 * before content is stored, and is never weakened).
 */

/**
 * A redaction pass over tool-output text. Must be pure and deterministic.
 * Injection point for the src/pipeline/ redaction stage (task T-C3).
 */
export type RedactFn = (text: string) => string;

/** Identity redaction — explicit default until T-C3 wires the pipeline stage. */
export const identityRedact: RedactFn = (text) => text;

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
 * redaction stage — see the module doc (TODO T-C3).
 */
export function stripKnownSecrets(text: string): string {
  return text
    .replace(PEM_PRIVATE_KEY_BLOCK_RE, REDACTED_PEM_PLACEHOLDER)
    .replace(PEM_PRIVATE_KEY_DANGLING_RE, REDACTED_PEM_PLACEHOLDER)
    .replace(SK_ANT_KEY_RE, REDACTED_SK_ANT_PLACEHOLDER);
}
