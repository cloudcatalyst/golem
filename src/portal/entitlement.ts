/**
 * "Cannot reach" and "not entitled" are different states, and this is where the
 * difference is decided.
 *
 * It is the single most important distinction in the team design, and it is one
 * function, so there is exactly one place to get it right:
 *
 * | the portal says | meaning | what Golem does |
 * |---|---|---|
 * | *nothing* — timeout, DNS, offline, 5xx | **cannot reach** | use the cached team layer, report its age |
 * | `402 subscription_required` | **not entitled** | do NOT use the cache; fall back to local config, say why |
 * | `403 not_a_member` | **not entitled** | same, naming the team the project claims |
 * | `401` / refresh failed | **cannot authenticate** | use the cache, and prompt at the next interactive command |
 *
 * Conflating the first two fails in both directions, which is why neither is
 * the safe default:
 *
 * - Treating a **402 like a timeout** keeps applying cached team policy after
 *   the subscription ended. That is a free team layer, granted by a bug.
 * - Treating a **timeout like a 402** drops an entitled team's policy the
 *   moment a developer's train enters a tunnel.
 *
 * So the rule is stated positively and narrowly: **the cache is for the case
 * where no verdict was rendered.** A portal that answered has rendered a
 * verdict, and a verdict of "you are not entitled" is not a failure to reach
 * the portal — it is the answer. Stale policy beats absent policy only when the
 * question is reachability; when the answer is "not entitled", the cache is not
 * a fallback, it is the thing being withdrawn.
 *
 * A `5xx` counts as *no verdict*: the portal is up enough to answer but has not
 * answered the entitlement question, and its own contract says to retry then
 * report. An unrecognised thrown error also counts as no verdict — and that
 * cannot become a loophole, because a `402` always arrives as an HTTP response
 * and never as an unknown exception.
 *
 * **Nothing here throws, and nothing here fails.** Every outcome degrades to
 * local config and carries a sentence to say out loud, because the hazard this
 * design exists to prevent is someone believing they are running under team
 * policy when they are not.
 */

import { PortalAuthError } from "./errors.js";

/** The `code` field of a portal error body that denies entitlement. */
export type NotEntitledCode =
  | "subscription_required"
  | "not_a_member"
  | "no_organization"
  | "insufficient_role";

const NOT_ENTITLED_CODES: ReadonlySet<string> = new Set<NotEntitledCode>([
  "subscription_required",
  "not_a_member",
  "no_organization",
  "insufficient_role",
]);

export type TeamLayerDisposition =
  /** The portal answered and the caller is entitled. */
  | { readonly kind: "entitled" }
  /** No verdict was rendered: offline, DNS, timeout, or a portal 5xx. */
  | { readonly kind: "unreachable"; readonly detail: string }
  /** A verdict was rendered, and it is no. The cache must NOT be used. */
  | {
      readonly kind: "not_entitled";
      readonly code: NotEntitledCode;
      readonly status: number;
      readonly detail: string;
    }
  /** The portal is reachable but this machine could not authenticate. */
  | { readonly kind: "auth_failed"; readonly detail: string }
  /** Reachable, authenticated, and the request was wrong. Our bug. */
  | { readonly kind: "api_error"; readonly status: number; readonly detail: string };

/**
 * May a disposition fall back to `~/.golem/teams/<org_id>.json`?
 *
 * Stated as one function so the answer cannot drift between call sites, and so
 * the gate can assert it directly. `true` for exactly the two states where no
 * entitlement verdict exists to respect.
 *
 * `api_error` is deliberately `false`. A malformed request is a Golem bug, and
 * quietly applying an organization's stale policy to paper over one is how the
 * 402 hole gets reopened wearing a different hat: if the harness ever cannot
 * tell what the portal said, it must not assume the answer was yes.
 */
export function mayUseCachedTeamLayer(disposition: TeamLayerDisposition): boolean {
  return disposition.kind === "unreachable" || disposition.kind === "auth_failed";
}

/**
 * Classify an HTTP response from an org-scoped endpoint.
 *
 * `code` is the body's stable `code` field. The portal's contract is explicit:
 * **match on `code`, never on `error`** — the prose is for humans and will be
 * reworded. When a 4xx arrives with no code, or one this version does not know,
 * the status decides: v1 may ADD error codes, and a client must treat an
 * unrecognised code as a generic failure of that status rather than as
 * something it has understood.
 */
export function classifyPortalResponse(status: number, code?: string): TeamLayerDisposition {
  if (status >= 200 && status < 300) return { kind: "entitled" };

  if (status >= 500) {
    return {
      kind: "unreachable",
      detail: `the portal answered ${status}, which is a portal-side fault and not a verdict on this team`,
    };
  }

  if (status === 401) {
    return {
      kind: "auth_failed",
      detail: "the portal rejected the stored token and it could not be refreshed",
    };
  }

  if (status === 402) {
    return {
      kind: "not_entitled",
      code: "subscription_required",
      status,
      detail: "the team's subscription is not active",
    };
  }

  if (status === 403) {
    const known = code !== undefined && NOT_ENTITLED_CODES.has(code);
    // A 403 is an authorization verdict however it is coded, so an unknown code
    // still denies. `not_a_member` is the fallback because the contract makes it
    // deliberately indistinguishable from an organization that does not exist —
    // otherwise the endpoint would enumerate organization ids.
    const resolved = (known ? (code as NotEntitledCode) : "not_a_member") satisfies NotEntitledCode;
    return { kind: "not_entitled", code: resolved, status, detail: detailForCode(resolved) };
  }

  if (code !== undefined && NOT_ENTITLED_CODES.has(code)) {
    const resolved = code as NotEntitledCode;
    return { kind: "not_entitled", code: resolved, status, detail: detailForCode(resolved) };
  }

  return { kind: "api_error", status, detail: `the portal answered ${status}` };
}

function detailForCode(code: NotEntitledCode): string {
  switch (code) {
    case "subscription_required":
      return "the team's subscription is not active";
    case "not_a_member":
      return "this account is not a member of that team (or the team does not exist)";
    case "no_organization":
      return "the request named no organization";
    case "insufficient_role":
      return "this account is a member but its role does not permit reading the team layer";
  }
}

/**
 * Classify a thrown error — the offline case, and everything `src/portal/`
 * raises.
 *
 * The default is `unreachable`, which is the side that keeps an offline
 * developer working. It is safe as a default for a structural reason rather
 * than an optimistic one: an entitlement denial is always an HTTP response, so
 * it reaches {@link classifyPortalResponse} and can never arrive here.
 */
export function classifyPortalError(err: unknown): TeamLayerDisposition {
  if (err instanceof PortalAuthError) {
    switch (err.kind) {
      case "api_error":
        // Carries the status it was built from, so route it the same way a live
        // response would be routed rather than guessing a second time.
        return err.status === undefined
          ? { kind: "unreachable", detail: err.message }
          : classifyPortalResponse(err.status);
      case "not_linked":
      case "no_browser":
      case "no_secure_store":
      case "token_exchange_failed":
      case "authorization_denied":
      case "state_mismatch":
        return { kind: "auth_failed", detail: err.message };
      case "not_configured":
        // A project that names a team on a machine with no portal configured.
        // Not an entitlement question at all, and the cache — written by an
        // authenticated fetch on this machine — is the only policy available.
        return { kind: "auth_failed", detail: err.message };
      case "discovery_failed":
      case "unsupported_server":
      case "timed_out":
        return { kind: "unreachable", detail: err.message };
    }
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    kind: "unreachable",
    detail: message === "" ? "the portal could not be reached" : message,
  };
}

// ---------------------------------------------------------------------------
// Saying it out loud
// ---------------------------------------------------------------------------

/** How old a cached team layer is, in words. */
export function describeCacheAge(fetchedAtMs: number, nowMs: number): string {
  const ms = Math.max(0, nowMs - fetchedAtMs);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "less than a minute old";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} old`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} old`;
}

export interface DescribeOutcomeOptions {
  readonly orgId: string;
  /** When a cache is being used, its age in words (see {@link describeCacheAge}). */
  readonly cacheAge?: string;
}

/**
 * The line the user must see. **Degrade, but never silently.**
 *
 * Every disposition produces a sentence, because the hazard is not the
 * degradation — it is believing team policy is in force when it is not. Each
 * one names the team the project points at, says what is actually being
 * applied, and never says "failed": nothing here is a failure of the tool.
 */
export function describeTeamOutcome(
  disposition: TeamLayerDisposition,
  options: DescribeOutcomeOptions,
): string {
  const team = options.orgId;
  switch (disposition.kind) {
    case "entitled":
      return `Team ${team}: settings applied from the portal.`;
    case "unreachable":
      return options.cacheAge === undefined
        ? `Team ${team}: the portal could not be reached (${disposition.detail}) and this ` +
            `machine has no cached team settings — using local configuration only.`
        : `Team ${team}: the portal could not be reached (${disposition.detail}) — using the ` +
            `cached team settings, which are ${options.cacheAge}.`;
    case "auth_failed":
      return options.cacheAge === undefined
        ? `Team ${team}: this machine could not authenticate to the portal (${disposition.detail}) ` +
            `and has no cached team settings — using local configuration only. ` +
            `Run \`golem team link\` to sign in.`
        : `Team ${team}: this machine could not authenticate to the portal (${disposition.detail}) ` +
            `— using the cached team settings, which are ${options.cacheAge}. ` +
            `Run \`golem team link\` to sign in again.`;
    case "not_entitled":
      // No cache is mentioned because none may be used, and saying what is NOT
      // being applied is the whole point of this line.
      return (
        `Team ${team}: ${disposition.detail} (${disposition.code}) — team settings are NOT ` +
        `being applied, and the cached copy is not used for this. Using local configuration.`
      );
    case "api_error":
      return (
        `Team ${team}: the portal answered ${disposition.status}, which this version of Golem ` +
        `does not understand — team settings are NOT being applied. Using local configuration.`
      );
  }
}
