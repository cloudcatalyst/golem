/**
 * golem account — extracted from program.ts (R8.27).
 */

import type { Command } from "commander";
import { findProjectDir, loadConfig } from "../../config/index.js";
import {
  resolveUpstreamDisplay,
  UPSTREAM_AUTH_SCHEMES,
  UPSTREAM_PROVIDERS,
} from "../../providers/index.js";
import {
  addAccount,
  collectAccounts,
  credentialEnvForProxy,
  loginAccount,
  logoutAccount,
  type NewAccount,
  removeAccount,
  renderAccounts,
  useAccount,
} from "../accounts.js";
import { InitError } from "../init.js";
import { portInUse, startDetached, stopProxy, waitForPortFree } from "../proxy-daemon.js";

const _DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();

function _fail(err: unknown): never {
  process.stderr.write(`golem: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(err instanceof InitError ? 2 : 1);
}

async function resolvePort(
  dir: string,
  portOpt?: string,
): Promise<{ port: number; upstream: string; sliderLevel: number }> {
  const { settings } = await loadConfig({ projectDir: dir });
  const port = portOpt === undefined ? settings.proxy.port : Number(portOpt);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new InitError(`invalid port "${portOpt}"`);
  return {
    port,
    upstream: resolveUpstreamDisplay(settings.proxy).baseUrl,
    sliderLevel: settings.slider.level,
  };
}

async function restartProxyDetached(
  dir: string,
  portOpt?: string,
): Promise<{ pid: number; port: number; upstream: string }> {
  const { port, upstream } = await resolvePort(dir, portOpt);
  await stopProxy(dir);
  await waitForPortFree(port);
  const credEnv = await credentialEnvForProxy(dir);
  const pid = await startDetached(dir, port, process.argv[1] ?? "", credEnv);
  if (pid === null) throw new InitError(`proxy did not come up on port ${port}`);
  return { pid, port, upstream };
}

export default function register(program: Command): void {
  const accountCmd = program
    .command("account")
    .description("Switch between configured upstream accounts/providers (R6.2, spec Decision 21d)");

  accountCmd
    .command("list")
    .alias("show")
    .description(
      "List configured accounts, which is active, and whether each has a stored credential",
    )
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; json: boolean }) => {
      try {
        const report = await collectAccounts(opts.dir);
        process.stdout.write(
          opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderAccounts(report),
        );
      } catch (err) {
        _fail(err);
      }
    });

  accountCmd
    .command("use")
    .description(
      "Switch the active account (use 'none' to clear and revert to the top-level config)",
    )
    .argument("<id>", "an account id from proxy.accounts, or 'none' to clear")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--no-restart", "do not auto-restart a running proxy to apply the switch")
    .option(
      "--yes",
      "switch even if the account's credential does not resolve (fail-closed override)",
      false,
    )
    .action(async (id: string, opts: { dir: string; restart: boolean; yes: boolean }) => {
      try {
        const target = id === "none" ? null : id;
        const { active } = await useAccount(opts.dir, target, new Date().toISOString(), {
          assumeYes: opts.yes,
        });
        const label =
          active === null
            ? "active account cleared — using the top-level (default) upstream config"
            : `active account: ${active}`;
        const report = await collectAccounts(opts.dir);
        const activeUrl = report.accounts.find((a) => a.active)?.base_url;
        const dest = activeUrl !== undefined ? ` -> ${activeUrl}` : "";
        const { port } = await resolvePort(opts.dir);
        const running = await portInUse(port);
        if (opts.restart && running) {
          const { pid } = await restartProxyDetached(opts.dir);
          process.stdout.write(`${label} — proxy restarted (pid ${pid})${dest}\n`);
        } else if (running)
          process.stdout.write(`${label} (restart the proxy to apply: golem proxy restart)\n`);
        else process.stdout.write(`${label}.\n`);
      } catch (err) {
        _fail(err);
      }
    });

  accountCmd
    .command("login")
    .description(
      "Store an account's credential in the OS credential store — prompt, verify against the upstream, then save (Decision 46)",
    )
    .argument("<id>", "an account id from proxy.accounts, or the default provider id")
    .option("--dir <path>", "project directory", process.cwd())
    .option("--no-probe", "store without verifying the key against the upstream first")
    .option(
      "--store <backend>",
      "where to store: 'keychain' (default, the OS store) or 'file' (UNENCRYPTED plaintext, explicit opt-in)",
      "keychain",
    )
    .action(async (id: string, opts: { dir: string; probe: boolean; store: string }) => {
      try {
        const storeTarget = opts.store === "file" ? ("file" as const) : ("keychain" as const);
        if (storeTarget === "file")
          process.stdout.write(
            "warning: storing UNENCRYPTED plaintext on disk (protected only by file permissions).\n",
          );
        const piped = process.stdin.isTTY ? "" : (await readStdin()).trim();
        const result = await loginAccount(opts.dir, id, new Date().toISOString(), {
          probe: opts.probe,
          store: storeTarget,
          ...(piped !== "" ? { secret: piped } : {}),
        });
        process.stdout.write(
          `stored credential for "${result.account}" — ${result.stored_in} (probe: ${result.probe}).\n${result.request_url !== undefined ? `requests will go to: ${result.request_url}\n` : ""}It resolves automatically on every proxy start; nothing to export.\n`,
        );
      } catch (err) {
        _fail(err);
      }
    });

  accountCmd
    .command("logout")
    .description("Remove an account's stored credential from the OS credential store")
    .argument("<id>", "an account id from proxy.accounts, or the default provider id")
    .option("--dir <path>", "project directory", process.cwd())
    .action(async (id: string, opts: { dir: string }) => {
      try {
        const result = await logoutAccount(opts.dir, id, new Date().toISOString());
        if (result.removed.length === 0)
          process.stdout.write(`no stored credential found for "${result.account}".\n`);
        else
          process.stdout.write(
            `removed credential for "${result.account}" from: ${result.removed.join(", ")}.\n`,
          );
      } catch (err) {
        _fail(err);
      }
    });

  accountCmd
    .command("add")
    .description(
      "Register a new account in proxy.accounts (non-secret config only — set the key with 'account login')",
    )
    .argument("<id>", "new account id (e.g. kimi, work)")
    .requiredOption("--provider <name>", `provider (${UPSTREAM_PROVIDERS.join(" | ")})`)
    .requiredOption("--base-url <url>", "upstream base URL")
    .option("--model <id>", "model id the upstream expects")
    .option(
      "--auth-scheme <scheme>",
      `credential header scheme (${UPSTREAM_AUTH_SCHEMES.join(" | ")})`,
    )
    .option("--dir <path>", "project directory", process.cwd())
    .option("--login", "prompt for the credential right after registering", false)
    .action(
      async (
        id: string,
        opts: {
          provider: string;
          baseUrl: string;
          model?: string;
          authScheme?: string;
          dir: string;
          login: boolean;
        },
      ) => {
        try {
          const provider = opts.provider as NewAccount["provider"];
          if (!UPSTREAM_PROVIDERS.includes(provider))
            throw new InitError(
              `unknown provider "${opts.provider}"; valid: ${UPSTREAM_PROVIDERS.join(", ")}`,
            );
          const authScheme = opts.authScheme as NewAccount["auth_scheme"];
          if (authScheme !== undefined && !UPSTREAM_AUTH_SCHEMES.includes(authScheme))
            throw new InitError(
              `unknown auth scheme "${opts.authScheme}"; valid: ${UPSTREAM_AUTH_SCHEMES.join(", ")}`,
            );
          await addAccount(
            opts.dir,
            {
              id,
              provider,
              base_url: opts.baseUrl,
              ...(opts.model !== undefined ? { model: opts.model } : {}),
              ...(authScheme !== undefined ? { auth_scheme: authScheme } : {}),
            },
            new Date().toISOString(),
          );
          process.stdout.write(
            `registered account "${id}" (${provider} ${opts.baseUrl}). Next: golem account login ${id}  (set its key), then  golem account use ${id}.\n`,
          );
          if (opts.login) {
            const result = await loginAccount(opts.dir, id, new Date().toISOString(), {});
            process.stdout.write(
              `stored credential for "${result.account}" — ${result.stored_in} (probe: ${result.probe}).\n`,
            );
          }
        } catch (err) {
          _fail(err);
        }
      },
    );

  accountCmd
    .command("remove")
    .description("Remove an account from proxy.accounts, deleting its stored credential first")
    .argument("<id>", "an account id from proxy.accounts")
    .option("--dir <path>", "project directory", process.cwd())
    .option("--keep-credential", "de-register the account but leave its stored credential", false)
    .action(async (id: string, opts: { dir: string; keepCredential: boolean }) => {
      try {
        const result = await removeAccount(opts.dir, id, new Date().toISOString(), {
          keepCredential: opts.keepCredential,
        });
        const credential = opts.keepCredential
          ? `Its stored credential was KEPT — remove it with: golem account logout ${id}.`
          : result.credential_removed.length > 0
            ? `Logged out first — credential removed from: ${result.credential_removed.join(", ")}.`
            : "No stored credential to remove.";
        process.stdout.write(
          `removed account "${result.account}" from proxy.accounts${result.was_active ? " (was active — reverted to the default upstream)" : ""}. ${credential}\n`,
        );
      } catch (err) {
        _fail(err);
      }
    });
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
