/**
 * `golem team` — sign this machine in to the hosted portal.
 *
 * `team-portal-auth`. Three subcommands and no more: this task ends at a stored
 * token and a working `GET /api/v1/me`. Choosing and recording a team is
 * `project-team-binding`, and fetching the team settings layer is
 * `team-layer-fetch`; neither is here.
 *
 * **Nothing printed by this file is a credential.** Every rendering path goes
 * through `describeTokenSet`, which returns issuer, scopes, expiry and a
 * boolean — the access and refresh tokens are never read into a string that
 * reaches stdout, stderr or `--json`. That is not a convention, it is the point
 * of ADR-0003: a credential in terminal scrollback is a credential in the next
 * bug report.
 */

import { stat } from "node:fs/promises";
import readline from "node:readline/promises";
import type { Command } from "commander";
import { findProjectDir, loadConfig } from "../../config/index.js";
import { defaultUserDir } from "../../config/paths.js";
import { createCredentialStore } from "../../credentials/index.js";
import {
  bindTeam,
  chooseOrganization,
  createPortalClient,
  describeCacheAge,
  discoverAuthorizationServer,
  linkPortal,
  PortalAuthError,
  type PortalIdentity,
  type PortalOrganization,
  portalStatus,
  portalTokenStore,
  printingBrowser,
  readTeamBinding,
  resolvePortalConfig,
  systemBrowser,
  type TeamSettings,
  type TeamSkillsTransport,
  teamApiBaseUrl,
  teamCachePath,
  unbindTeam,
  unlinkPortal,
} from "../../portal/index.js";
import { forgetManaged } from "../managed-files.js";
import { syncTeamSkills } from "../team-skills.js";

const _DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();

/**
 * Exit 2 for "you have not configured this yet", 1 for everything else.
 *
 * The split matters for scripting: `not_configured` and `not_linked` are states
 * a caller can fix without a human, and are the two a wrapper wants to branch on
 * rather than treat as a crash.
 */
function _fail(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`golem: ${message}\n`);
  const recoverable =
    err instanceof PortalAuthError && (err.kind === "not_configured" || err.kind === "not_linked");
  process.exit(recoverable ? 2 : 1);
}

async function portalContext(dir: string) {
  const { settings } = await loadConfig({ projectDir: dir });
  const config = resolvePortalConfig(settings.portal);
  const tokens = portalTokenStore(createCredentialStore());
  return { config, tokens, settings };
}

/**
 * What `golem team link` did about the PROJECT, as distinct from what it did
 * about the machine.
 *
 * Two separate outcomes on purpose: signing in can succeed while binding does
 * not (several teams and no `--org`), and reporting one as the other is how a
 * user ends up believing a repo is linked when only their keychain is.
 */
/** `golem team link`'s flags. Named so the action stays one line. */
interface LinkOptions {
  readonly dir: string;
  readonly browser: boolean;
  /** `--no-bind`: sign in without touching the project's settings. */
  readonly bind: boolean;
  readonly org?: string;
  readonly timeout?: string;
  readonly json: boolean;
}

type BindOutcome =
  | {
      readonly kind: "bound";
      readonly orgId: string;
      readonly name: string;
      readonly settingsFile: string;
      readonly entitled: boolean;
    }
  | { readonly kind: "skipped" }
  | { readonly kind: "no_organizations" }
  | { readonly kind: "ambiguous"; readonly candidates: readonly PortalOrganization[] }
  | { readonly kind: "unknown"; readonly requested: string };

function describeOrg(org: PortalOrganization): string {
  const slug = org.slug === undefined ? "" : ` (${org.slug})`;
  const lapsed = org.entitled === false ? "  (no live subscription)" : "";
  return `${org.name}${slug} — ${org.id}${lapsed}`;
}

/** The interactive half of "one team links silently; several prompt". */
async function promptForOrg(
  candidates: readonly PortalOrganization[],
): Promise<PortalOrganization | null> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write("\nYou are in more than one team. Which one is this project?\n");
    candidates.forEach((org, index) => {
      process.stdout.write(`  ${index + 1}) ${describeOrg(org)}\n`);
    });
    const answer = await rl.question(`Choose 1-${candidates.length} (or Enter to skip): `);
    const index = Number(answer.trim());
    if (!Number.isInteger(index) || index < 1 || index > candidates.length) return null;
    return candidates[index - 1] ?? null;
  } finally {
    rl.close();
  }
}

/**
 * Record the team in the project's COMMITTED settings.
 *
 * This is the whole of `project-team-binding` on the link path. A sign-in that
 * stops at a stored token leaves the project no better off than before: the
 * keychain knows who you are, and nothing knows which team this repo belongs
 * to. `interactive` is false for `--json` and for a non-TTY, where a prompt
 * would hang a script instead of asking a person.
 */
async function bindProjectTeam(options: {
  readonly dir: string;
  readonly identity: PortalIdentity;
  readonly requested?: string;
  readonly interactive: boolean;
  readonly portalUrl: string;
}): Promise<BindOutcome> {
  const choice = chooseOrganization(options.identity.organizations, options.requested);
  let org: PortalOrganization;
  switch (choice.kind) {
    case "chosen":
      org = choice.org;
      break;
    case "none":
      return { kind: "no_organizations" };
    case "unknown":
      return { kind: "unknown", requested: choice.requested };
    case "ambiguous": {
      if (!options.interactive) return { kind: "ambiguous", candidates: choice.candidates };
      const picked = await promptForOrg(choice.candidates);
      if (picked === null) return { kind: "ambiguous", candidates: choice.candidates };
      org = picked;
      break;
    }
  }
  const result = await bindTeam({
    projectDir: options.dir,
    orgId: org.id,
    portalUrl: options.portalUrl,
  });
  return {
    kind: "bound",
    orgId: result.orgId,
    name: org.name,
    settingsFile: result.settingsFile,
    entitled: org.entitled !== false,
  };
}

/** What `golem team status` says about the PROJECT, with no network at all. */
interface ProjectBindingView {
  readonly linked: boolean;
  readonly orgId: string | null;
  readonly summary: string;
  /** Human line about `~/.golem/teams/<org>.json`; null when unlinked. */
  readonly cache: string | null;
}

async function describeProjectBinding(team: TeamSettings): Promise<ProjectBindingView> {
  const state = readTeamBinding(team);
  if (state.kind === "unlinked") {
    // The free tier, stated as a fact rather than an absence — and NO cache is
    // consulted on this branch, which is the Decision 64 invariant in code.
    return {
      linked: false,
      orgId: null,
      summary: "none — this project is not linked to a team (Golem is complete without one)",
      cache: null,
    };
  }
  if (state.kind === "invalid") {
    return {
      linked: false,
      orgId: state.orgId,
      summary: `${state.orgId} — IGNORED, because ${state.reason}`,
      cache: null,
    };
  }
  const { binding } = state;
  const applied = binding.sync ? "" : " (team.sync is off, so its settings are not applied)";
  const cachePath = teamCachePath(defaultUserDir(), binding.orgId);
  let cache: string;
  try {
    const info = await stat(cachePath);
    cache = `${cachePath} — ${describeCacheAge(info.mtimeMs, Date.now())}`;
  } catch {
    cache = `${cachePath} — not fetched yet`;
  }
  return {
    linked: true,
    orgId: binding.orgId,
    summary: `${binding.orgId}${applied}`,
    cache,
  };
}

export default function register(program: Command): void {
  const teamCmd = program
    .command("team")
    .description(
      "Sign in to the hosted portal (team-portal-auth) — the token goes to the OS keychain",
    );

  teamCmd
    .command("link")
    .description(
      "Sign in to the portal in a browser (authorization code + PKCE over a loopback redirect)",
    )
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--no-browser", "print the sign-in URL instead of opening a browser")
    .option("--org <id-or-slug>", "which team to bind this project to (skips the prompt)")
    .option("--no-bind", "sign in only — do not write team.org_id into this project")
    .option("--timeout <ms>", "override how long to wait for the browser round trip")
    .option("--json", "machine-readable output", false)
    .action(async (opts: LinkOptions) => {
      try {
        const { config, tokens } = await portalContext(opts.dir);
        const timeoutMs = opts.timeout === undefined ? config.linkTimeoutMs : Number(opts.timeout);
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
          throw new Error(`--timeout must be a positive number of milliseconds`);
        }

        // Progress goes to STDERR so `--json` stdout stays parseable, and so a
        // user watching a browser open still sees what is happening.
        const narrate = opts.json
          ? (text: string) => process.stderr.write(text)
          : (text: string) => process.stdout.write(text);

        const result = await linkPortal({
          issuerUrl: config.issuerUrl,
          clientId: config.clientId,
          tokens,
          browser: opts.browser
            ? systemBrowser()
            : printingBrowser((text) => process.stderr.write(text)),
          timeoutMs,
          write: narrate,
        });

        // The gate for this task: a stored token that `GET /api/v1/me`
        // actually answers 200 to. Doing it here rather than leaving it to the
        // user means a link that "succeeded" but produced an unusable token
        // fails now, while the browser is still open.
        const client = createPortalClient({
          apiBaseUrl: config.apiBaseUrl,
          clientId: config.clientId,
          metadata: () => discoverAuthorizationServer(config.issuerUrl),
          tokens,
        });
        const identity = await client.me();

        // `project-team-binding`: bind the PROJECT, not just the machine. A
        // prompt is only offered to a real terminal — under `--json` or in a
        // pipeline, asking a question nobody can answer is a hang.
        const bind: BindOutcome = opts.bind
          ? await bindProjectTeam({
              dir: opts.dir,
              identity,
              ...(opts.org === undefined ? {} : { requested: opts.org }),
              interactive: !opts.json && process.stdin.isTTY === true,
              portalUrl: config.apiBaseUrl,
            })
          : { kind: "skipped" };

        // The token is stored either way, so the only outcome that can leave a
        // WRONG belief behind is an unbound project: exit 2 (the recoverable
        // code) says "one more decision needed" while the sign-in still
        // reports success. Exit 0 with no team recorded would read as linked.
        if (bind.kind === "ambiguous" || bind.kind === "unknown") process.exitCode = 2;

        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(
              {
                linked: true,
                storedIn: result.location,
                token: result.summary,
                user: identity.user,
                organizations: identity.organizations,
                team: bind,
              },
              null,
              2,
            )}\n`,
          );
          return;
        }

        process.stdout.write(
          `\nLinked. The token is in ${result.location.label}` +
            ` (${result.location.protection}).\n`,
        );
        process.stdout.write(`Signed in as ${identity.user.email ?? identity.user.id}.\n`);
        if (identity.organizations.length === 0) {
          process.stdout.write(
            "No organizations. Ask a portal admin to invite you, then re-run `golem team status`.\n",
          );
        } else {
          process.stdout.write("\nOrganizations:\n");
          for (const org of identity.organizations) {
            process.stdout.write(`  ${describeOrg(org)}\n`);
          }
        }

        switch (bind.kind) {
          case "bound":
            process.stdout.write(
              `\nThis project is now bound to ${bind.name} (${bind.orgId}).\n` +
                `Recorded in ${bind.settingsFile} — commit it, and a colleague who clones ` +
                `this repo is pointed at the same team.\n`,
            );
            if (!bind.entitled) {
              // Said now rather than at the next surprising moment. The link is
              // still correct; what is missing is the subscription behind it.
              process.stdout.write(
                "That team has no live subscription, so team settings will not be applied " +
                  "until it does — Golem carries on with local configuration.\n",
              );
            }
            break;
          case "ambiguous":
            process.stdout.write(
              "\nNothing was bound: you are in more than one team and none was chosen. " +
                "Re-run with `--org <id-or-slug>` to bind this project.\n",
            );
            break;
          case "unknown":
            process.stdout.write(
              `\nNothing was bound: no team of yours matches ${JSON.stringify(bind.requested)}. ` +
                "Pick one of the ids above with `--org`.\n",
            );
            break;
          case "no_organizations":
            process.stdout.write(
              "\nNothing was bound: you are not in any team yet. Golem is complete without " +
                "one — the team layer only adds org-wide settings and shared skills.\n",
            );
            break;
          case "skipped":
            process.stdout.write(
              "\nNothing was bound (`--no-bind`): this machine is signed in, but the project " +
                "still names no team. Run `golem team link --org <id>` to record one.\n",
            );
            break;
        }
      } catch (err) {
        _fail(err);
      }
    });

  teamCmd
    .command("status")
    .description("Show whether this machine is linked to the portal, and to which issuer")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; json: boolean }) => {
      try {
        const { config, tokens, settings } = await portalContext(opts.dir);
        const status = await portalStatus({
          issuerUrl: config.issuerUrl,
          apiBaseUrl: config.apiBaseUrl,
          clientId: config.clientId,
          tokens,
        });
        // The project half of the answer. Read from settings only — no request
        // is made, and the per-org cache is stat'd ONLY when this project names
        // a team, because an unlinked project must read no cache at all
        // (Decision 64).
        const project = await describeProjectBinding(settings.team);
        if (opts.json) {
          process.stdout.write(`${JSON.stringify({ ...status, team: project }, null, 2)}\n`);
          return;
        }
        process.stdout.write(`Team:    ${project.summary}\n`);
        if (project.cache !== null) {
          process.stdout.write(`Cache:   ${project.cache}\n`);
        }
        process.stdout.write(`Portal:  ${status.apiBaseUrl}\n`);
        process.stdout.write(`Issuer:  ${status.issuer}\n`);
        process.stdout.write(`Client:  ${status.clientId}\n`);
        if (!status.linked) {
          process.stdout.write("Linked:  no — run `golem team link`\n");
          return;
        }
        const token = status.token;
        process.stdout.write(`Linked:  yes (OS keychain)\n`);
        process.stdout.write(`Scopes:  ${token?.scopes.join(" ") || "(none reported)"}\n`);
        process.stdout.write(
          `Expires: ${token?.expiresAt ?? "not stated"}${token?.expired === true ? " — EXPIRED, will refresh on next use" : ""}\n`,
        );
        if (token?.hasRefreshToken === false) {
          process.stdout.write(
            "Refresh: none stored — you will be asked to sign in again when this expires\n",
          );
        }
      } catch (err) {
        _fail(err);
      }
    });

  // `golem team unlink` is the PROJECT-scope inverse of `link`, and it is
  // deliberately not the inverse of the token store. Before this task `unlink`
  // was an alias for `logout`; that alias is gone, because the two undo
  // different things at different scopes and one word cannot mean both. A
  // machine has one identity and may hold many projects, so forgetting the
  // token would unlink every repo on it — which is never what "unlink this
  // project" means.
  teamCmd
    .command("unlink")
    .description(
      "Remove THIS project's team binding and its managed team skills (the token is untouched)",
    )
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; json: boolean }) => {
      try {
        const result = await unbindTeam({
          projectDir: opts.dir,
          // Team skills are managed files: dropping the provenance record with
          // the file keeps `golem init` from later classifying a re-synced skill
          // as one the user hand-edited.
          forget: (relativePath) => forgetManaged(opts.dir, relativePath),
        });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          return;
        }
        if (result.orgId === null) {
          process.stdout.write("This project named no team — nothing to unlink.\n");
        } else {
          process.stdout.write(
            `Unlinked ${result.orgId}. Removed team.org_id from ${result.settingsFile}.\n`,
          );
        }
        for (const dir of result.removedSkillDirs) {
          process.stdout.write(`Removed managed team skills in ${dir}.\n`);
        }
        if (result.cacheKept !== null) {
          // Said out loud because a file left behind looks like a bug until you
          // know why it is there.
          process.stdout.write(
            `Kept ${result.cacheKept}: the cache is machine scope while the link is project ` +
              `scope, so another project on this machine may still be using that team's ` +
              `offline policy. It is stale at worst, and its timestamp says so.\n`,
          );
        }
        process.stdout.write(
          "Your portal sign-in is untouched — this only unlinks this project. " +
            "Run `golem team logout` to forget the token on this machine.\n",
        );
      } catch (err) {
        _fail(err);
      }
    });

  teamCmd
    .command("logout")
    .description("Forget the stored portal token on this machine")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; json: boolean }) => {
      try {
        const tokens = portalTokenStore(createCredentialStore());
        const { removed } = await unlinkPortal(tokens);
        if (opts.json) {
          process.stdout.write(`${JSON.stringify({ removed }, null, 2)}\n`);
          return;
        }
        if (removed.length === 0) {
          process.stdout.write("Nothing to forget — this machine was not linked.\n");
          return;
        }
        for (const where of removed) {
          process.stdout.write(`Forgot the portal token in ${where.label}.\n`);
        }
        // Said plainly because "logged out" that leaves a live token at the
        // authorization server is exactly the claim a user will rely on.
        process.stdout.write(
          "This is local only: the token is gone from this machine but was not revoked at " +
            "the portal. Revoke it there if it may have been exposed.\n",
        );
      } catch (err) {
        _fail(err);
      }
    });

  // `golem team skills` — `team-skills-sync`. The user-facing way to run the
  // sync that `golem init` will also run through `init-team.ts`'s
  // `syncTeamLayer` seam. It has no failure path of its own for an entitlement
  // outcome: a lapsed subscription or an offline laptop is a REPORT and exit 0,
  // because nothing in the team layer may break a local-first tool.
  teamCmd
    .command("skills")
    .description("Sync this project's team skills into .claude/skills/golem-team-<name>/")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--dry-run", "show what would change and write nothing", false)
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; dryRun: boolean; json: boolean }) => {
      try {
        const { settings } = await loadConfig({ projectDir: opts.dir });
        const state = readTeamBinding(settings.team);

        // Decision 64, at the earliest point it can be applied: an unlinked
        // project builds no portal client, so there is no keychain lookup and
        // no request to accidentally make. The transport stays undefined for
        // any state but `linked`, and `syncTeamSkills` refuses to invent one.
        let transport: TeamSkillsTransport | undefined;
        let unconfigured: string | null = null;
        if (state.kind === "linked") {
          try {
            const config = resolvePortalConfig(settings.portal);
            const client = createPortalClient({
              apiBaseUrl: teamApiBaseUrl(state.binding, config.apiBaseUrl),
              clientId: config.clientId,
              metadata: () => discoverAuthorizationServer(config.issuerUrl),
              tokens: portalTokenStore(createCredentialStore()),
            });
            transport = (reqPath) => client.request(reqPath);
          } catch (err) {
            // A project can commit `team.org_id` without a portal address —
            // a merge, or a team whose members were told to set `portal.url`
            // themselves. That is a configuration gap, not an entitlement
            // verdict, and it must not hard-fail a command every member runs:
            // no transport is built, the sync reports honestly, and the reason
            // is printed. Exit 0, nothing on disk touched.
            unconfigured = err instanceof Error ? err.message : String(err);
          }
        }

        const result = await syncTeamSkills({
          projectDir: opts.dir,
          team: settings.team,
          dryRun: opts.dryRun,
          ...(transport === undefined ? {} : { transport }),
        });

        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify({ ...result, dryRun: opts.dryRun, unconfigured }, null, 2)}\n`,
          );
          return;
        }
        if (unconfigured !== null) {
          process.stdout.write(`${unconfigured}\n`);
        }
        for (const action of result.actions) {
          process.stdout.write(`${action.kind.padEnd(8)} ${action.path} — ${action.detail}\n`);
        }
        for (const notice of result.notices) {
          process.stdout.write(`${notice}\n`);
        }
        if (result.outcome.kind === "unlinked") {
          process.stdout.write(
            "No team is linked to this project — Golem is complete without one. " +
              "`golem team link` adds org-wide settings and shared skills if you have a team.\n",
          );
        }
      } catch (err) {
        _fail(err);
      }
    });
}
