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

import type { Command } from "commander";
import { findProjectDir, loadConfig } from "../../config/index.js";
import { createCredentialStore } from "../../credentials/index.js";
import {
  createPortalClient,
  discoverAuthorizationServer,
  linkPortal,
  PortalAuthError,
  portalStatus,
  portalTokenStore,
  printingBrowser,
  resolvePortalConfig,
  systemBrowser,
  unlinkPortal,
} from "../../portal/index.js";

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
  return { config, tokens };
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
    .option("--timeout <ms>", "override how long to wait for the browser round trip")
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; browser: boolean; timeout?: string; json: boolean }) => {
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

        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(
              {
                linked: true,
                storedIn: result.location,
                token: result.summary,
                user: identity.user,
                organizations: identity.organizations,
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
            const entitled = org.entitled === false ? "  (no live subscription)" : "";
            process.stdout.write(
              `  ${org.name}${org.slug === undefined ? "" : ` (${org.slug})`} — ${org.id}${entitled}\n`,
            );
          }
        }
        process.stdout.write(
          "\nNothing is bound to this project yet — `golem team link` only signs you in.\n",
        );
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
        const { config, tokens } = await portalContext(opts.dir);
        const status = await portalStatus({
          issuerUrl: config.issuerUrl,
          apiBaseUrl: config.apiBaseUrl,
          clientId: config.clientId,
          tokens,
        });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
          return;
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

  teamCmd
    .command("logout")
    .alias("unlink")
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
}
