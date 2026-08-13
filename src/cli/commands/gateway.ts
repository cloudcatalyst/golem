/**
 * golem gateway — extracted from program.ts (R8.27), renamed from account in R9.23.
 */

import type { Command } from "commander";
import { findProjectDir, loadConfig } from "../../config/index.js";
import {
  isKeylessProvider,
  resolveUpstreamDisplay,
  UPSTREAM_AUTH_SCHEMES,
  UPSTREAM_PROVIDERS,
} from "../../providers/index.js";
import {
  addGateway,
  collectGateways,
  credentialEnvForProxy,
  loginGateway,
  logoutGateway,
  type NewGateway,
  removeGateway,
  renderGateways,
  useGateway,
} from "../gateways.js";
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
  const gatewayCmd = program
    .command("gateway")
    .description("Switch between configured upstream gateways (R6.2, spec Decision 21d)");

  gatewayCmd
    .command("list")
    .alias("show")
    .description(
      "List configured gateways, which is active, and whether each has a stored credential",
    )
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; json: boolean }) => {
      try {
        const report = await collectGateways(opts.dir);
        process.stdout.write(
          opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderGateways(report),
        );
      } catch (err) {
        _fail(err);
      }
    });

  gatewayCmd
    .command("use")
    .description(
      "Switch the active gateway (use 'none' to clear and revert to the top-level config)",
    )
    .argument("<id>", "a gateway id from proxy.gateways, or 'none' to clear")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--no-restart", "do not auto-restart a running proxy to apply the switch")
    .option(
      "--yes",
      "switch even if the gateway's credential does not resolve (fail-closed override)",
      false,
    )
    .action(async (id: string, opts: { dir: string; restart: boolean; yes: boolean }) => {
      try {
        const target = id === "none" ? null : id;
        const { active } = await useGateway(opts.dir, target, new Date().toISOString(), {
          assumeYes: opts.yes,
        });
        const label =
          active === null
            ? "active gateway cleared — using the top-level (default) upstream config"
            : `active gateway: ${active}`;
        const report = await collectGateways(opts.dir);
        const activeUrl = report.gateways.find((a) => a.active)?.base_url;
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

  gatewayCmd
    .command("login")
    .description(
      "Store a gateway's credential in the OS credential store — prompt, verify against the upstream, then save (Decision 46)",
    )
    .argument("<id>", "a gateway id from proxy.gateways, or the default provider id")
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
        const result = await loginGateway(opts.dir, id, new Date().toISOString(), {
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

  gatewayCmd
    .command("logout")
    .description("Remove a gateway's stored credential from the OS credential store")
    .argument("<id>", "a gateway id from proxy.gateways, or the default provider id")
    .option("--dir <path>", "project directory", process.cwd())
    .action(async (id: string, opts: { dir: string }) => {
      try {
        const result = await logoutGateway(opts.dir, id, new Date().toISOString());
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

  gatewayCmd
    .command("add")
    .description(
      "Register a new gateway in proxy.gateways (non-secret config only — set the key with 'gateway login')",
    )
    .argument("<id>", "new gateway id (e.g. kimi, work)")
    .requiredOption("--provider <name>", `provider (${UPSTREAM_PROVIDERS.join(" | ")})`)
    .requiredOption("--base-url <url>", "upstream base URL")
    .option("--models <ids>", "comma-separated model ids the gateway serves")
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
          models?: string;
          authScheme?: string;
          dir: string;
          login: boolean;
        },
      ) => {
        try {
          const provider = opts.provider as NewGateway["provider"];
          if (!UPSTREAM_PROVIDERS.includes(provider))
            throw new InitError(
              `unknown provider "${opts.provider}"; valid: ${UPSTREAM_PROVIDERS.join(", ")}`,
            );
          const authScheme = opts.authScheme as NewGateway["auth_scheme"];
          if (authScheme !== undefined && !UPSTREAM_AUTH_SCHEMES.includes(authScheme))
            throw new InitError(
              `unknown auth scheme "${opts.authScheme}"; valid: ${UPSTREAM_AUTH_SCHEMES.join(", ")}`,
            );
          await addGateway(
            opts.dir,
            {
              id,
              provider,
              base_url: opts.baseUrl,
              ...(opts.models !== undefined
                ? {
                    models: opts.models
                      .split(",")
                      .map((m) => m.trim())
                      .filter((m) => m !== ""),
                  }
                : {}),
              ...(authScheme !== undefined ? { auth_scheme: authScheme } : {}),
            },
            new Date().toISOString(),
          );
          // R10.8: a self-hosted model server has no key to set, so telling the
          // user to run `gateway login` next is a step that cannot succeed and
          // teaches them the tool does not know what it just registered.
          process.stdout.write(
            isKeylessProvider(provider)
              ? `registered gateway "${id}" (${provider} ${opts.baseUrl}). ` +
                  `${provider} serves unauthenticated by default, so there is no key to set — ` +
                  `next: golem gateway use ${id}. ` +
                  `(If you started it with an API key, add --auth-scheme bearer and run golem gateway login ${id}.)\n`
              : `registered gateway "${id}" (${provider} ${opts.baseUrl}). Next: golem gateway login ${id}  (set its key), then  golem gateway use ${id}.\n`,
          );
          if (opts.login) {
            const result = await loginGateway(opts.dir, id, new Date().toISOString(), {});
            process.stdout.write(
              `stored credential for "${result.account}" — ${result.stored_in} (probe: ${result.probe}).\n`,
            );
          }
        } catch (err) {
          _fail(err);
        }
      },
    );

  gatewayCmd
    .command("remove")
    .description("Remove a gateway from proxy.gateways, deleting its stored credential first")
    .argument("<id>", "a gateway id from proxy.gateways")
    .option("--dir <path>", "project directory", process.cwd())
    .option("--keep-credential", "de-register the gateway but leave its stored credential", false)
    .action(async (id: string, opts: { dir: string; keepCredential: boolean }) => {
      try {
        const result = await removeGateway(opts.dir, id, new Date().toISOString(), {
          keepCredential: opts.keepCredential,
        });
        const credential = opts.keepCredential
          ? `Its stored credential was KEPT'— remove it with: golem gateway logout ${id}.`
          : result.credential_removed.length > 0
            ? `Logged out first — credential removed from: ${result.credential_removed.join(", ")}.`
            : "No stored credential to remove.";
        process.stdout.write(
          `removed gateway "${result.account}" from proxy.gateways${result.was_active ? " (was active — reverted to the default upstream)" : ""}. ${credential}\n`,
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
