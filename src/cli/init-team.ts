/**
 * `golem init`'s team step — and the reason it is a *step* and not a gate.
 *
 * `project-team-binding`. Three states, from the portal's own
 * `docs/team-config.md` §4b:
 *
 * | state | behaviour |
 * |---|---|
 * | `team.org_id` present, token available | sync, and report what landed |
 * | `team.org_id` present, no token | say so, name `golem team link`, **init still succeeds** |
 * | no `team.org_id` | mention `golem team link` once, carry on |
 *
 * Two rules govern every line of this file.
 *
 * **Nothing here may break `golem init`.** A project must initialise without a
 * network, without an account, and without a subscription. So this step has no
 * failure path at all: every outcome — offline, lapsed, not a member, malformed
 * key, a sync that throws — becomes a NOTICE, and `golem init` carries on and
 * exits 0. A team link is an enhancement to a local-first tool, and an
 * enhancement that can fail an init is not an enhancement.
 *
 * **The unlinked path does nothing whatsoever.** Decision 64's invariant is that
 * a project with no `team.org_id` performs zero portal I/O, reads no cache and
 * looks up no token. Here that is structural rather than aspirational:
 * {@link teamInitStep} returns on the `unlinked` branch before
 * {@link TeamInitStepOptions.tokenPresent} or
 * {@link TeamInitStepOptions.syncTeamLayer} is so much as consulted, and both
 * are injected precisely so a test can prove they were never called.
 *
 * ## Why the sync is a seam and not an implementation
 *
 * Fetching the team layer is `team-layer-fetch` and syncing skills is
 * `team-skills-sync`. This step takes `syncTeamLayer` as an injection rather
 * than importing one, because building a portal client needs the portal config
 * and the credential store — and constructing either on the unlinked path would
 * undo the invariant this file exists to hold.
 *
 * **`team-layer-fetch` has since shipped and `golem init` passes a real sync**
 * (`syncTeamLayerForInit` in `./init.ts`). The `undefined` branch is kept for
 * callers that deliberately want the binding recorded and nothing fetched —
 * tests, and an embedder that resolves the layer itself — and it says so rather
 * than claiming the feature is unbuilt.
 *
 * What is injected still cannot fail this step: whatever it throws is
 * CLASSIFIED, never propagated, because "cannot reach" is not "not entitled"
 * and neither may fail an init.
 */

import {
  classifyPortalError,
  describeTeamOutcome,
  mayUseCachedTeamLayer,
  readTeamBinding,
  type TeamBinding,
  type TeamSettings,
} from "../portal/index.js";

export interface TeamInitStepOptions {
  readonly dryRun: boolean;
  /**
   * The already-resolved `team` settings section. Passed in rather than loaded
   * here so this step does no I/O of its own on the unlinked path — not even a
   * settings read it would otherwise have to be trusted to skip.
   */
  readonly team: TeamSettings;
  /**
   * Is there a portal token on this machine? **Must not touch the network.**
   *
   * Deliberately issuer-agnostic: confirming a token matches a specific issuer
   * needs the authorization-server metadata, and fetching that during `golem
   * init` would break "a project must initialise without a network". Presence
   * is enough for the only question this step asks — whether to name `golem
   * team link` or to try a sync.
   *
   * Only ever called when the project names a team.
   */
  readonly tokenPresent?: () => Promise<boolean>;
  /**
   * Fetch and apply the team layer, returning one line per thing that landed.
   * Filled in by `team-layer-fetch` / `team-skills-sync`; absent until then.
   *
   * Only ever called when the project names a team AND a token is present.
   */
  readonly syncTeamLayer?: (binding: TeamBinding) => Promise<readonly string[]>;
}

export type TeamInitOutcome =
  /** No team named: the free tier, and the default. */
  | { readonly kind: "unlinked" }
  /** A team named, but not in a shape that can be used. Degrades to unlinked. */
  | { readonly kind: "invalid"; readonly orgId: string; readonly reason: string }
  /** A team named, no token on this machine. Init still succeeds. */
  | { readonly kind: "no_token"; readonly orgId: string }
  /** A team named and a token present, but no sync is wired up yet. */
  | { readonly kind: "not_fetched"; readonly orgId: string }
  /** Synced. `applied` is what landed. */
  | { readonly kind: "applied"; readonly orgId: string; readonly applied: readonly string[] }
  /** A team named, a token present, and the sync did not produce a layer. */
  | { readonly kind: "degraded"; readonly orgId: string; readonly usedCache: boolean };

export interface TeamInitStepResult {
  readonly outcome: TeamInitOutcome;
  /**
   * Lines for `golem init` to print. **Never empty**, because "degrade, but
   * never silently" applies to the free path too: exactly one line either way,
   * so a solo user is told the command exists and is then left alone.
   */
  readonly notices: readonly string[];
}

/** The one mention an unlinked project ever gets from `golem init`. */
export const TEAM_LINK_HINT =
  "No team is linked to this project — Golem is complete without one. " +
  "`golem team link` adds org-wide settings and shared skills if you have a team.";

export async function teamInitStep(options: TeamInitStepOptions): Promise<TeamInitStepResult> {
  const state = readTeamBinding(options.team);

  if (state.kind === "unlinked") {
    // The Decision 64 invariant, and the reason this returns before touching
    // anything: no portal request, no cache read, no keychain lookup, and one
    // mention rather than a nag.
    return { outcome: { kind: "unlinked" }, notices: [TEAM_LINK_HINT] };
  }

  if (state.kind === "invalid") {
    return {
      outcome: { kind: "invalid", orgId: state.orgId, reason: state.reason },
      notices: [
        `Team ${state.orgId} is named in this project's settings but ${state.reason}. ` +
          "Carrying on with local configuration.",
      ],
    };
  }

  const { binding } = state;

  const hasToken = options.tokenPresent === undefined ? false : await safeTokenProbe(options);
  if (!hasToken) {
    // The gate's second row: named team, no token, init SUCCEEDS. No network is
    // touched to establish this — a keychain miss is the whole answer.
    return {
      outcome: { kind: "no_token", orgId: binding.orgId },
      notices: [
        `Team ${binding.orgId} is linked to this project, but this machine is not signed in ` +
          "to the portal — run `golem team link`. Nothing else is affected: Golem is using " +
          "local configuration.",
      ],
    };
  }

  if (options.dryRun) {
    return {
      outcome: { kind: "not_fetched", orgId: binding.orgId },
      notices: [
        `Team ${binding.orgId} is linked and this machine is signed in — a real run would ` +
          "fetch and apply the team layer here.",
      ],
    };
  }

  if (options.syncTeamLayer === undefined) {
    // Honest rather than reassuring: the binding is recorded and usable, and
    // the thing that consumes it has not shipped yet.
    return {
      outcome: { kind: "not_fetched", orgId: binding.orgId },
      notices: [
        `Team ${binding.orgId} is linked and this machine is signed in, but this run was ` +
          "given no way to fetch the team layer — Golem is using local configuration. " +
          "`golem team sync` fetches it.",
      ],
    };
  }

  if (!binding.sync) {
    return {
      outcome: { kind: "not_fetched", orgId: binding.orgId },
      notices: [
        `Team ${binding.orgId} is linked but \`team.sync\` is off, so its settings are not ` +
          "being applied on this machine.",
      ],
    };
  }

  try {
    const applied = await options.syncTeamLayer(binding);
    return {
      outcome: { kind: "applied", orgId: binding.orgId, applied },
      notices: [
        applied.length === 0
          ? `Team ${binding.orgId}: signed in and up to date — the team layer set nothing new.`
          : `Team ${binding.orgId}: applied ${applied.length} team setting${
              applied.length === 1 ? "" : "s"
            } — ${applied.join(", ")}.`,
      ],
    };
  } catch (err) {
    // The whole point. A 402 or a 403 is a verdict and must NOT reach for the
    // cache; a timeout is not a verdict and must. Either way `golem init`
    // succeeds and says which one happened, because someone believing they are
    // running under team policy when they are not is the actual hazard.
    const disposition = classifyPortalError(err);
    return {
      outcome: {
        kind: "degraded",
        orgId: binding.orgId,
        usedCache: mayUseCachedTeamLayer(disposition),
      },
      notices: [describeTeamOutcome(disposition, { orgId: binding.orgId })],
    };
  }
}

/**
 * A keychain that throws is a machine without a usable keychain, which is
 * "no token" — not a failed init. On Linux with no `secret-tool` this is the
 * normal answer rather than an exceptional one.
 */
async function safeTokenProbe(options: TeamInitStepOptions): Promise<boolean> {
  try {
    return options.tokenPresent === undefined ? false : await options.tokenPresent();
  } catch {
    return false;
  }
}
