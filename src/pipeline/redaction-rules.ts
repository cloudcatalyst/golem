/**
 * WS-A A3 — the redaction rule table (T-C3 security-review audit surface).
 *
 * Every secret/PII detector Golem applies before content is transformed,
 * stored, or forwarded lives in this ONE table, in the ONE order it is
 * applied. To extend redaction, append a rule here and add its positive +
 * negative cases to tests/unit/pipeline/redaction-corpus.ts (the T-C3 audit
 * corpus). Never remove or loosen a rule outside a T-C3-reviewed change
 * (CLAUDE.md hard rule: never weaken the redaction stage).
 *
 * Determinism contract (prompt-cache prefix stability, verification-notes
 * §14): matching is pure regex + pure validators over the input text — no
 * clock, no randomness, no config. Rule ORDER is part of the contract: rules
 * run in table order, left-to-right within a rule, and earlier replacements
 * are invisible to later rules (placeholders contain `[`/`]`/`:` which no
 * rule's charset matches, so redaction is idempotent).
 *
 * The generic high-entropy detector runs AFTER the table (see redaction.ts)
 * so provider-specific rules win the placeholder kind for strings both would
 * match.
 */

/** One auditable redaction rule. */
export interface RedactionRule {
  /** Placeholder kind: `[REDACTED:<id>:<n>]`. Stable — telemetry keys off it. */
  readonly id: string;
  /** What the rule catches and why the pattern is shaped the way it is. */
  readonly description: string;
  /** MUST carry the `g` flag. Applied in table order, left-to-right. */
  readonly pattern: RegExp;
  /**
   * Capture group to redact instead of the whole match (e.g. only the
   * password inside a connection string). Default: whole match.
   */
  readonly group?: number;
  /** Extra pure check on the redaction target (e.g. Luhn). Default: accept. */
  readonly validate?: (target: string) => boolean;
}

/** Luhn checksum over the digits of `target` (separators allowed). */
export function luhnValid(target: string): boolean {
  const digits = target.replace(/[ -]/g, "");
  if (!/^\d{13,19}$/.test(digits)) {
    return false;
  }
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Whether `target`'s separators (if any) are a single consistent character —
 * all spaces or all dashes, never mixed. Real cards are written with one
 * grouping style; a mix is a sign the digits were never meant to be read as
 * one number (verification-notes §50).
 */
function hasConsistentSeparatorChar(target: string): boolean {
  const seps = target.match(/[ -]/g);
  return seps === null || seps.every((s) => s === seps[0]);
}

/**
 * Whether every digit group between separators in `target` is the same
 * length. A contiguous run (no separators at all) trivially passes — there
 * is nothing to compare. Real card grouping is regular (e.g. 4-4-4-4); an
 * ASCII/byte dump of space-separated decimal values groups irregularly (1-3
 * digits per value, verification-notes §50's actual false-positive), so
 * requiring uniform group length rejects it without needing to hardcode
 * every real card-network grouping scheme.
 */
function hasUniformGrouping(target: string): boolean {
  const groups = target.split(/[ -]/);
  const firstLength = groups[0]?.length ?? 0;
  return groups.every((g) => g.length === firstLength);
}

/**
 * Combined credit-card validator: Luhn-valid AND, if separators are present,
 * formatted like a real card (one consistent separator, uniform grouping).
 * Tightens the bare Luhn gate, which let sparse/irregularly-separated digit
 * runs (e.g. space-separated ASCII byte dumps) through by chance
 * (verification-notes §50).
 */
export function isCreditCardLike(target: string): boolean {
  return luhnValid(target) && hasConsistentSeparatorChar(target) && hasUniformGrouping(target);
}

/**
 * The rule table. Order is load-bearing and part of the audit surface:
 * multi-line PEM blocks first (their base64 body would otherwise be shredded
 * by narrower rules), provider-specific key shapes next (most specific
 * first: `sk-ant-` before the generic `sk-` OpenAI shape), structured
 * formats (JWT, connection strings), then PII (card numbers, emails).
 */
export const REDACTION_RULES: readonly RedactionRule[] = [
  {
    id: "private-key",
    description:
      "PEM private key blocks (RSA/EC/DSA/OPENSSH/PKCS#8, encrypted or not). " +
      "Matched as a whole block, including the base64 body, so nothing " +
      "downstream sees any part of the key material.",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/g,
  },
  {
    id: "aws-key",
    description:
      "AWS access key IDs: fixed 4-char prefix (AKIA/ASIA/ABIA/ACCA/A3T*) + " +
      "16 uppercase-alphanumeric chars, 20 chars total.",
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA|A3T[A-Z0-9])[A-Z0-9]{16}\b/g,
  },
  {
    id: "aws-secret-key",
    description:
      "AWS secret access keys: 40-char base64-ish value adjacent to an " +
      "aws/secret-access-key context word. The bare 40-char shape alone is " +
      "too common to match without context; uncontexted secrets are still " +
      "caught by the high-entropy detector.",
    pattern:
      /\b(?:aws_?)?secret_?(?:access_?)?key\b["'\s:=]{1,5}([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
    group: 1,
  },
  {
    id: "github-token",
    description:
      "GitHub tokens: classic/fine-grained prefixes ghp_/gho_/ghu_/ghs_/ghr_ " +
      "(36+ alphanumeric) and github_pat_ (22+ chars).",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g,
  },
  {
    id: "anthropic-key",
    description: "Anthropic API keys: sk-ant- prefix. Listed before the generic sk- rule.",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    id: "openai-key",
    description:
      "OpenAI API keys: sk- prefix (incl. sk-proj-/sk-svcacct-) followed by a " +
      "long token; negative lookahead excludes sk-ant- (Anthropic rule above).",
    pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{32,}\b/g,
  },
  {
    id: "slack-token",
    description: "Slack tokens: xoxb-/xoxa-/xoxp-/xoxr-/xoxs-/xoxe- prefixes.",
    pattern: /\bxox[baprse]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: "google-api-key",
    description:
      "Google API keys: AIza prefix + 35 base64url-ish chars (39 chars total, " +
      "the fixed real-world shape). Comfortably above the entropy net's 32-char " +
      "floor, but a dedicated rule labels it correctly instead of falling " +
      "through as generic high-entropy (verification-notes §24).",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: "stripe-key",
    description:
      "Stripe live secret keys: sk_live_ prefix (underscore, not the sk- " +
      "hyphen shape the openai-key rule matches) + 24-99 alphanumeric chars " +
      "(verification-notes §24).",
    pattern: /\bsk_live_[A-Za-z0-9]{24,99}\b/g,
  },
  {
    id: "gcp-oauth-token",
    description:
      "GCP OAuth2 access tokens: ya29. prefix + 20-120 base64url chars. The " +
      "shortest real tokens sit near the entropy net's 32-char floor once the " +
      "5-char prefix is included, so a dedicated rule is needed to not miss " +
      "them (verification-notes §24).",
    pattern: /\bya29\.[A-Za-z0-9_-]{20,120}\b/g,
  },
  {
    id: "jwt",
    description:
      "JSON Web Tokens: three dot-separated base64url segments where the " +
      'header starts with eyJ (base64 of `{"`).',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    id: "connection-password",
    description:
      "Credentials embedded in connection-string URLs " +
      "(scheme://user:password@host). Only the password is redacted so the " +
      "scheme, user, and host stay legible to the model.",
    pattern: /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]+)@/g,
    group: 1,
  },
  {
    id: "azure-account-key",
    description:
      "Azure Storage account connection strings: only the AccountKey= value " +
      "is redacted (base64, 20-100 chars incl. optional = padding), leaving " +
      "AccountName/EndpointSuffix legible — same pattern as connection-password " +
      "(verification-notes §24).",
    pattern: /\bAccountKey=([A-Za-z0-9+/]{20,100}={0,2})(?=;|$)/g,
    group: 1,
  },
  {
    id: "credit-card",
    description:
      "Credit-card-like numbers: 13-19 digits with optional space/dash " +
      "separators, gated by a Luhn checksum (rejects IDs and phone numbers) " +
      "plus a separator-format check (single consistent character, uniform " +
      "grouping — rejects sparse/irregular digit runs like ASCII byte dumps " +
      "that pass Luhn by chance, verification-notes §50).",
    pattern: /(?<![\d.-])\d(?:[ -]?\d){12,18}(?![\d.-])/g,
    validate: isCreditCardLike,
  },
  {
    id: "email",
    description: "Email addresses (PII).",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
];

// ---------------------------------------------------------------------------
// High-entropy heuristic (applied after the table; see redaction.ts).
// ---------------------------------------------------------------------------

/** Placeholder kind used by the entropy detector. */
export const ENTROPY_RULE_ID = "high-entropy";

/**
 * Candidate tokens for the entropy check: unbroken runs of the characters
 * secrets are made of (base64/base64url + separators used inside single
 * tokens), BOUNDED to a credential-plausible length.
 *
 * - Floor 32: real API secrets are almost always >= 32 chars; shorter floods
 *   dev traffic with false positives.
 * - Ceiling {@link ENTROPY_MAX_CANDIDATE_CHARS}: a run longer than this is not a
 *   credential — it is DATA (a base64 image, a minified/encoded blob, an inline
 *   attachment). Redacting those is lossy over-redaction that strips content
 *   Claude needs and silently inflates "savings" (verification-notes §31/§37).
 *   Every known provider secret (Anthropic, AWS, GitHub, Slack, JWT, private-key
 *   PEM bodies handled by their own rules) fits well under the ceiling.
 */
export const ENTROPY_MAX_CANDIDATE_CHARS = 128;
// Lookarounds require the WHOLE unbroken run to be 32–128 chars: a longer run
// (a big blob) has a candidate char just past 128, so the lookahead fails and it
// is NOT matched at all — we never redact a 128-char slice out of the middle of
// a 20 KB image. Delimiters are any non-candidate char (or string edge).
export const ENTROPY_CANDIDATE_RE =
  /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{32,128}(?![A-Za-z0-9+/=_-])/g;

/**
 * Shannon-entropy threshold in bits/char. Random 32+ char base62 material
 * measures ~4.5-5.0 on its own sample; camelCase identifiers and English
 * words sit near 3.5-4.0.
 */
export const ENTROPY_THRESHOLD_BITS = 4.2;

/** Shannon entropy of `text` in bits/char, measured on its own alphabet. */
export function shannonEntropy(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const counts = new Map<string, number>();
  for (const ch of text) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Subresource-integrity / content-hash prefixes (`sha512-<base64>` etc.). These
 * saturate lockfiles (npm `integrity`) and are content hashes, NOT secrets —
 * redacting them is incidental, mislabels non-secrets, and inflates "savings"
 * (verification-notes §31). A real API key never carries an SRI algo prefix.
 */
const INTEGRITY_HASH_RE = /^(sha1|sha224|sha256|sha384|sha512|md5)-/i;

/**
 * Whether a candidate is shaped like a repo path or a versioned/slugged
 * filename rather than random secret material (verification-notes §49): a
 * whole path (`docs/decisions/ADR-0012-file-watcher`) forms one
 * candidate token because `/` sits in the entropy charset, and a path with
 * mixed case + digits (ADR numbers, dates) can measure above the entropy
 * threshold on its own alphabet.
 *
 * Splitting on the path/identifier delimiters `/`, `-`, `_` distinguishes the
 * two: every chunk of a real path or slug is a clean word or a clean number
 * (`docs`, `wiki`, `ADR`, `0012`, `file`, `watcher`). A chunk of real random
 * secret material drawn from a 64-symbol alphabet is very unlikely to land
 * entirely in one class — a handful of characters from base64/base64url have
 * good odds of mixing a letter and a digit — so requiring EVERY chunk to be
 * purely alphabetic or purely numeric is a strong non-secret signal without
 * blanket-excluding `/` (standard-base64 secrets legitimately contain it).
 * Single-chunk tokens (no delimiter at all) are left to the entropy check.
 */
function isPathLikeToken(token: string): boolean {
  const chunks = token.split(/[/_-]/).filter((c) => c.length > 0);
  if (chunks.length < 2) {
    return false;
  }
  return chunks.every((c) => /^[A-Za-z]+$/.test(c) || /^[0-9]+$/.test(c));
}

/**
 * Whether a candidate token is high-entropy secret material.
 *
 * Deliberate exclusions (audit rationale):
 * - integrity hashes (`sha512-…` SRI / npm lockfile `integrity`): content
 *   hashes, not secrets; they dominate lockfiles and their redaction is what
 *   made the savings metric look large (§31).
 * - pure hex (dashes/underscores ignored): git SHAs, sha256 content hashes,
 *   UUIDs, and Golem's own CCR `hash=<sha256>` markers saturate developer
 *   traffic and are not secrets. Hex-shaped provider secrets are covered by
 *   the pattern rules above.
 * - path-like candidates ({@link isPathLikeToken}): repo paths and versioned
 *   filenames/ADR names (§49).
 * - tokens with fewer than 2 of 3 character classes (lowercase, uppercase,
 *   digit): long identifiers, camelCase names, and shouted constants each
 *   lack at least one of the three while real random secrets at 32+ chars
 *   almost always have at least two. Base32 secrets (uppercase + digits,
 *   no lowercase) are now caught by the 2-of-3 rule.
 */
export function isHighEntropyToken(token: string): boolean {
  if (INTEGRITY_HASH_RE.test(token)) {
    return false;
  }
  const dehyphenated = token.replace(/[-_]/g, "");
  if (/^[0-9a-fA-F]*$/.test(dehyphenated)) {
    return false;
  }
  if (isPathLikeToken(token)) {
    return false;
  }
  // Require at least 2 of 3 character classes (catches base64 with all three,
  // and base32 secrets which use only uppercase + digits, no lowercase).
  const hasLower = /[a-z]/.test(token);
  const hasUpper = /[A-Z]/.test(token);
  const hasDigit = /[0-9]/.test(token);
  const classCount = (hasLower ? 1 : 0) + (hasUpper ? 1 : 0) + (hasDigit ? 1 : 0);
  if (classCount < 2) {
    return false;
  }
  return shannonEntropy(token) >= ENTROPY_THRESHOLD_BITS;
}

/**
 * ---------------------------------------------------------------------------
 * R8.11 / ADR-0005 — the append-only plugin extension point.
 *
 * Every organisation has private secret formats, and until now extending
 * redaction meant *forking Golem*. A fork drifts out of date — including out of
 * date with fixes to this very stage — so the seam below exists to make the
 * safer choice also the easier one.
 *
 * It is append-only **by construction, not by convention**:
 *
 * - `REDACTION_RULES` above stays the single audited built-in table (T-C3) and
 *   is never handed to a plugin.
 * - Extra rules are appended AFTER every built-in, so they can only ever redact
 *   *more*. A plugin rule that matches something a built-in already replaced
 *   sees a placeholder, whose `[` / `]` / `:` characters no rule's charset
 *   matches.
 * - There is no remove, replace, or reorder function. They do not exist to be
 *   called.
 * - Registration is expected exactly once, at startup, before the process serves
 *   anything. That is a determinism requirement, not tidiness: redaction must be
 *   a pure function of its input for prompt-cache prefix stability
 *   (verification-notes §14), so a table that changed mid-process would break
 *   caching for every downstream request. A second registration is therefore
 *   REFUSED rather than merged.
 * ---------------------------------------------------------------------------
 */

/** Plugin-contributed rules, appended after the built-in table. */
let extraRules: readonly RedactionRule[] = [];
let extraRulesSealed = false;

/** Outcome of a registration attempt — never a throw on a live request path. */
export interface ExtraRuleRegistration {
  readonly accepted: number;
  /** Non-null when nothing was accepted and why. */
  readonly refused: string | null;
}

/**
 * Append plugin redaction rules. Idempotent-by-refusal: the first call wins for
 * the life of the process, and a later one is refused with a reason rather than
 * silently changing the table underneath a cached prefix.
 *
 * Rules whose id is not namespaced (`<plugin>/<rule>`) are rejected — the
 * namespace is what stops a plugin impersonating a built-in placeholder kind.
 */
export function registerExtraRedactionRules(
  rules: readonly RedactionRule[],
): ExtraRuleRegistration {
  if (extraRulesSealed) {
    return {
      accepted: 0,
      refused:
        "redaction rules were already registered for this process; the table is fixed once " +
        "serving begins so prompt-cache prefixes stay stable (verification-notes §14)",
    };
  }
  const builtInIds = new Set(REDACTION_RULES.map((r) => r.id));
  const accepted: RedactionRule[] = [];
  for (const rule of rules) {
    if (!rule.id.includes("/")) continue; // must be `<plugin>/<rule>`
    if (builtInIds.has(rule.id)) continue; // cannot shadow a built-in kind
    accepted.push(rule);
  }
  extraRules = accepted;
  extraRulesSealed = true;
  return { accepted: accepted.length, refused: null };
}

/** The plugin-contributed rules currently in force (possibly empty). */
export function extraRedactionRules(): readonly RedactionRule[] {
  return extraRules;
}

/**
 * The full table in application order: **built-ins first, always**, then plugin
 * rules. The entropy sweep still runs after both (see `redaction.ts`), so
 * specific rules keep winning the placeholder kind over the generic detector.
 */
export function activeRedactionRules(): readonly RedactionRule[] {
  return extraRules.length === 0 ? REDACTION_RULES : [...REDACTION_RULES, ...extraRules];
}

/**
 * Test-only: drop plugin rules and unseal.
 *
 * This is the one function that removes a rule, and it is deliberately narrow —
 * it can only ever clear the plugin suffix, never touch `REDACTION_RULES`, and
 * a production code path calling it would still be unable to weaken a built-in.
 */
export function resetExtraRedactionRulesForTests(): void {
  extraRules = [];
  extraRulesSealed = false;
}
