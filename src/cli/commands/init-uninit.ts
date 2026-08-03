/**
 * golem init / uninit — extracted from program.ts (R8.27).
 */

import type { Command } from "commander";
import { findProjectDir, loadConfig } from "../../config/index.js";
import { createProbeRunner, detectCapability, embedModelFor } from "../../inference/index.js";
import { credentialEnvForProxy } from "../accounts.js";
import { ollamaHasModel } from "../build-knowledge.js";
import { golemInit, golemUninit, InitError, type InitReport } from "../init.js";
import { startDetached } from "../proxy-daemon.js";
import { writeProxyDesired } from "../proxy-state.js";

const _DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();

function _fail(err: unknown): never {
  process.stderr.write(`golem: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(err instanceof InitError ? 2 : 1);
}

function printReport(report: InitReport): void {
  for (const action of report.actions) {
    process.stdout.write(`  ${action.kind.padEnd(6)} ${action.path} — ${action.detail}\n`);
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

async function initSummary(dir: string, proxyStarted: boolean): Promise<string> {
  const lines: string[] = ["\nDone."];
  lines.push(
    proxyStarted
      ? "Proxy is running. Restart Claude Code in this project to pick up the wiring."
      : "Start the proxy with `golem proxy start --detach`, then restart Claude Code here.",
  );
  lines.push(
    "The status line is in your terminal; a VS Code panel installs automatically when VS Code",
    "is present — reload the window (Developer: Reload Window) to activate it.",
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

export default function register(program: Command): void {
  program
    .command("init")
    .description("Wire this project's Claude Code to Golem (proxy, MCP server, /golem/* skills)")
    .option("--dir <path>", "project directory", process.cwd())
    .option("--dry-run", "show what would change without writing", false)
    .option("--foundry <url>", "front an Azure AI Foundry resource base URL")
    .option("--upstream <url>", "front a generic Anthropic-compatible gateway (e.g. OpenRouter)")
    .option("--start-proxy", "start the proxy daemon after wiring", false)
    .action(
      async (opts: {
        dir: string;
        dryRun: boolean;
        foundry?: string;
        upstream?: string;
        startProxy: boolean;
      }) => {
        try {
          const report = await golemInit({
            projectDir: opts.dir,
            dryRun: opts.dryRun,
            ...(opts.foundry !== undefined ? { foundry: opts.foundry } : {}),
            ...(opts.upstream !== undefined ? { upstream: opts.upstream } : {}),
          });
          printReport(report);
          if (report.dryRun) return;
          if (opts.startProxy) {
            const { settings } = await loadConfig({ projectDir: opts.dir });
            await writeProxyDesired(opts.dir, "running", new Date().toISOString());
            const pid = await startDetached(
              opts.dir,
              settings.proxy.port,
              process.argv[1] ?? "",
              await credentialEnvForProxy(opts.dir),
            );
            process.stdout.write(
              pid === null
                ? "golem proxy: failed to start — run `golem proxy start --detach` manually\n"
                : `golem proxy: started (pid ${pid}) on port ${settings.proxy.port}\n`,
            );
          }
          process.stdout.write(await initSummary(opts.dir, opts.startProxy));
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
