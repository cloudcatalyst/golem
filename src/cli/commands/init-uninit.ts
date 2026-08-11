/**
 * golem init / uninit — extracted from program.ts (R8.27).
 */

import type { Command } from "commander";
import { findProjectDir, loadConfig, migrateOnVersionChange } from "../../config/index.js";
import { VERSION } from "../../index.js";
import { createProbeRunner, detectCapability, embedModelFor } from "../../inference/index.js";
import { loopbackCaPath } from "../../proxy/loopback-cert.js";
import { ollamaHasModel } from "../build-knowledge.js";
import { credentialEnvForProxy } from "../gateways.js";
import { golemInit, golemUninit, InitError, type InitReport } from "../init.js";
import { startDetached } from "../proxy-daemon.js";

const _DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();

function _fail(err: unknown): never {
  process.stderr.write(`golem: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(err instanceof InitError ? 2 : 1);
}

function printReport(report: InitReport): void {
  for (const action of report.actions) {
    process.stdout.write(`  ${action.kind.padEnd(8)} ${action.path} — ${action.detail}\n`);
  }
  if (report.dryRun) process.stdout.write("dry run: nothing was written.\n");
}

async function commandExists(cmd: string): Promise<boolean> {
  return (await createProbeRunner()({ command: cmd, args: ["--version"] })).ok;
}

async function ollamaEmbedReady(dir: string): Promise<boolean> {
  try {
    const { settings } = await loadConfig({ projectDir: dir });
    const facts = await detectCapability(createProbeRunner());
    const model = embedModelFor(facts.tier, "text");
    return await ollamaHasModel(settings.inference.ollama_base_url, model);
  } catch {
    return false;
  }
}

async function initSummary(dir: string): Promise<string> {
  const lines: string[] = ["\nDone."];
  lines.push("Proxy is running. Restart Claude Code in this project to pick up the wiring.");
  lines.push(
    "The status line is in your terminal; a VS Code panel installs automatically when VS Code",
    "is present — reload the window (Developer: Reload Window) to activate it.",
    "",
    "Usage:",
    "  golem on   — pipeline on (redaction, compression, brevity).",
    "  golem off  — pipeline off (proxy still forwards requests raw).",
    "  golem uninit — remove Golem from this project.",
  );
  const [hasUv, hasEmbedModel] = await Promise.all([commandExists("uv"), ollamaEmbedReady(dir)]);
  const hints: string[] = [];
  if (hasUv)
    hints.push(
      "• `uv` detected — enable semantic compression: set compression.headroom_sidecar=true and slider ≥3.",
    );
  if (hasEmbedModel)
    hints.push(
      "• Ollama + embedding model detected — knowledge search will use semantic embeddings.",
    );
  else
    hints.push(
      "• Knowledge search works now (built-in lexical); `ollama pull bge-m3` + run Ollama to upgrade to semantic.",
    );
  if (hints.length > 0) lines.push("", "Enhancements:", ...hints);
  return `${lines.join("\n")}\n`;
}

/**
 * Say plainly what was just trusted, why, and what it cannot do. Trust changes
 * should never be silent, even when they are the default — and the restart is
 * not optional: `NODE_EXTRA_CA_CERTS` is read once at startup (§112), so until
 * Claude Code restarts, served WebFetches keep using the deny path.
 */
function loopbackCertNotice(projectDir: string): string {
  return [
    "",
    "  WebFetch  Golem generated a loopback certificate authority and trusted it via",
    `            NODE_EXTRA_CA_CERTS (${loopbackCaPath(projectDir)}).`,
    "            Why: it lets a WebFetch served from Golem's cache render as a normal",
    "            (green) tool call instead of a denied one.",
    "            Scope: the CA carries a DNS name constraint, so it CANNOT issue a",
    "            certificate for api.anthropic.com or any other host — only for",
    "            127.0.0.1. It also cannot create sub-CAs.",
    "            Takes effect right away in most sessions (§125 — measured: a running",
    "            session picked the CA up without restarting). If served fetches still",
    "            show as denied, restart Claude Code. Either way nothing breaks: a",
    "            session without the trust behaves exactly as before.",
    "            Decline with: golem init --no-loopback-cert",
    "",
  ].join("\n");
}

export default function register(program: Command): void {
  program
    .command("init")
    .description("Wire this project's Claude Code to Golem (proxy, MCP server, /golem/* skills)")
    .option("--dir <path>", "project directory", process.cwd())
    .option("--dry-run", "show what would change without writing", false)
    .option("--foundry <url>", "front an Azure AI Foundry resource base URL")
    .option("--upstream <url>", "front a generic Anthropic-compatible gateway (e.g. OpenRouter)")
    .option(
      "--no-loopback-cert",
      "don't generate or trust Golem's loopback CA (cache-served WebFetches keep showing as denied/red)",
    )
    .action(
      async (opts: {
        dir: string;
        dryRun: boolean;
        foundry?: string;
        upstream?: string;
        loopbackCert: boolean;
      }) => {
        try {
          const report = await golemInit({
            projectDir: opts.dir,
            dryRun: opts.dryRun,
            ...(opts.foundry !== undefined ? { foundry: opts.foundry } : {}),
            ...(opts.upstream !== undefined ? { upstream: opts.upstream } : {}),
            // commander maps `--no-loopback-cert` onto `loopbackCert: false`
            ...(opts.loopbackCert === false ? { noLoopbackCert: true } : {}),
          });
          printReport(report);
          if (report.dryRun) return;
          if (opts.loopbackCert !== false) {
            process.stdout.write(loopbackCertNotice(opts.dir));
          }
          // R9.13: config migration after init
          for (const line of (
            await migrateOnVersionChange({ projectDir: opts.dir, version: VERSION })
          ).lines) {
            process.stdout.write(`  config   ${line}\n`);
          }
          // R9.23: always start the proxy daemon after wiring
          const { settings } = await loadConfig({ projectDir: opts.dir });
          const pid = await startDetached(
            opts.dir,
            settings.proxy.port,
            process.argv[1] ?? "",
            await credentialEnvForProxy(opts.dir),
          );
          if (pid === null) {
            process.stdout.write("golem proxy: failed to start — port in use or daemon crashed\n");
          } else {
            process.stdout.write(
              `golem proxy: started (pid ${pid}) on port ${settings.proxy.port}\n`,
            );
          }
          process.stdout.write(await initSummary(opts.dir));
        } catch (err) {
          _fail(err);
        }
      },
    );

  program
    .command("uninit")
    .description("Remove everything golem init added (keeps .golem/ project data)")
    .option("--dir <path>", "project directory", process.cwd())
    .option("--dry-run", "show what would change without writing", false)
    .action(async (opts: { dir: string; dryRun: boolean }) => {
      try {
        const { settings } = await loadConfig({ projectDir: opts.dir });
        const report = await golemUninit({
          projectDir: opts.dir,
          dryRun: opts.dryRun,
          proxyPort: settings.proxy.port,
        });
        printReport(report);
      } catch (err) {
        _fail(err);
      }
    });
}
