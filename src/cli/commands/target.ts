/**
 * golem target — the target registry CLI (R9.1).
 *
 * `list` / `show` report; `add` registers non-secret identity; `test` probes a
 * target's credential against its own endpoint. Credentials stay with
 * `golem account login` — a target names an account, it never holds a key.
 */

import type { Command } from "commander";
import {
  TARGET_TRUST_LEVELS,
  type TargetTrust,
  UPSTREAM_AUTH_SCHEMES,
  UPSTREAM_PROVIDERS,
} from "../../providers/index.js";
import { InitError } from "../init.js";
import {
  addTarget,
  collectTargets,
  type NewTarget,
  renderTargets,
  showTarget,
  testTarget,
} from "../targets.js";

function _fail(err: unknown): never {
  process.stderr.write(`golem: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(err instanceof InitError ? 2 : 1);
}

export default function register(program: Command): void {
  const targetCmd = program
    .command("target")
    .description(
      "Inspect and register the targets Golem can reach — local and upstream models (R9.1)",
    );

  targetCmd
    .command("list")
    .description(
      "List every configured target: provider, endpoint, model, trust, and whether a credential resolves",
    )
    .option("--dir <path>", "project directory", process.cwd())
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; json: boolean }) => {
      try {
        const report = await collectTargets(opts.dir);
        process.stdout.write(
          opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderTargets(report),
        );
      } catch (err) {
        _fail(err);
      }
    });

  targetCmd
    .command("show")
    .description("Show one target in full (fails closed on an unknown id — never substitutes)")
    .argument("<id>", "a target id from proxy.targets or proxy.accounts")
    .option("--dir <path>", "project directory", process.cwd())
    .option("--json", "machine-readable output", false)
    .action(async (id: string, opts: { dir: string; json: boolean }) => {
      try {
        const row = await showTarget(opts.dir, id);
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(row, null, 2)}\n`);
          return;
        }
        const lines = [
          `target:   ${row.id}${row.is_default ? "  (default)" : ""}`,
          `provider: ${row.provider}`,
          `endpoint: ${row.base_url}`,
          `model:    ${row.model ?? "(forwards the client's own id)"}`,
          `trust:    ${row.trust}`,
          `account:  ${row.account ?? "(inherits the client's auth)"}`,
          `key:      ${row.key_set ? `set — ${row.key_location ?? "stored"}` : "not set"}`,
          `source:   ${row.origin}`,
        ];
        for (const w of row.warnings) lines.push(`warning:  ${w}`);
        process.stdout.write(`${lines.join("\n")}\n`);
      } catch (err) {
        _fail(err);
      }
    });

  targetCmd
    .command("add")
    .description(
      "Register a target in proxy.targets (non-secret config only — credentials stay with 'account login')",
    )
    .argument("<id>", "new target id (e.g. coder, cheap)")
    .requiredOption("--provider <name>", `provider (${UPSTREAM_PROVIDERS.join(" | ")})`)
    .requiredOption("--base-url <url>", "endpoint base URL")
    .option("--model <id>", "model id to send (omit to forward the client's own)")
    .option("--account <id>", "proxy.accounts id whose stored credential backs this target")
    .option(
      "--auth-scheme <scheme>",
      `credential header scheme (${UPSTREAM_AUTH_SCHEMES.join(" | ")})`,
    )
    .option(
      "--trust <level>",
      `how much context this target is trusted with (${TARGET_TRUST_LEVELS.join(" | ")}); omit for a conservative default`,
    )
    .option("--dir <path>", "project directory", process.cwd())
    .action(
      async (
        id: string,
        opts: {
          provider: string;
          baseUrl: string;
          model?: string;
          account?: string;
          authScheme?: string;
          trust?: string;
          dir: string;
        },
      ) => {
        try {
          const provider = opts.provider as NewTarget["provider"];
          if (!UPSTREAM_PROVIDERS.includes(provider))
            throw new InitError(
              `unknown provider "${opts.provider}"; valid: ${UPSTREAM_PROVIDERS.join(", ")}`,
            );
          const authScheme = opts.authScheme as NonNullable<NewTarget["auth_scheme"]>;
          if (opts.authScheme !== undefined && !UPSTREAM_AUTH_SCHEMES.includes(authScheme))
            throw new InitError(
              `unknown auth scheme "${opts.authScheme}"; valid: ${UPSTREAM_AUTH_SCHEMES.join(", ")}`,
            );
          const trust = opts.trust as TargetTrust;
          if (opts.trust !== undefined && !TARGET_TRUST_LEVELS.includes(trust))
            throw new InitError(
              `unknown trust level "${opts.trust}"; valid: ${TARGET_TRUST_LEVELS.join(", ")}`,
            );
          const result = await addTarget(
            opts.dir,
            {
              id,
              provider,
              base_url: opts.baseUrl,
              ...(opts.model !== undefined ? { model: opts.model } : {}),
              ...(opts.account !== undefined ? { account: opts.account } : {}),
              ...(opts.authScheme !== undefined ? { auth_scheme: authScheme } : {}),
              ...(opts.trust !== undefined ? { trust } : {}),
            },
            new Date().toISOString(),
          );
          const note = result.overrides_account
            ? ` It overrides the account-derived target of the same id (that account's credential still backs it).`
            : "";
          process.stdout.write(
            `registered target "${id}" (${provider} ${opts.baseUrl}).${note}\n` +
              `Nothing routes on it yet — the registry is inert until proxy routing (R9.2) and coder dispatch (R9.3) land.\n`,
          );
        } catch (err) {
          _fail(err);
        }
      },
    );

  targetCmd
    .command("test")
    .description("Probe a target's stored credential against its own endpoint")
    .argument("<id>", "a target id from proxy.targets or proxy.accounts")
    .option("--dir <path>", "project directory", process.cwd())
    .option("--json", "machine-readable output", false)
    .action(async (id: string, opts: { dir: string; json: boolean }) => {
      try {
        const result = await testTarget(opts.dir, id);
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          return;
        }
        const lines = [`target ${result.target}: ${result.verdict}`];
        if (result.detail !== undefined) lines.push(`  ${result.detail}`);
        if (result.request_url !== undefined) lines.push(`  requests go to: ${result.request_url}`);
        if (result.config_warning !== undefined) lines.push(`  warning: ${result.config_warning}`);
        process.stdout.write(`${lines.join("\n")}\n`);
      } catch (err) {
        _fail(err);
      }
    });
}
