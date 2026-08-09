/**
 * golem proxy — extracted from program.ts (R8.27).
 */

import type { Command } from "commander";
import { findProjectDir, loadConfig, settingsFilePaths } from "../../config/index.js";
import {
  createProbeRunner,
  detectCapability,
  embedModelFor,
  OllamaClient,
  OllamaInferenceService,
} from "../../inference/index.js";
import type { InferenceService } from "../../interfaces/inference.js";
import { resolveUpstreamDisplay } from "../../providers/index.js";
import { openTelemetryStore } from "../../telemetry/index.js";
import { credentialEnvForProxy } from "../accounts.js";
import { resolvePersistedEmbedMode } from "../auto-index.js";
import { ollamaHasModel } from "../build-knowledge.js";
import { InitError } from "../init.js";
import {
  portInUse,
  proxyStatus,
  removeProxyPid,
  startDetached,
  stopProxy,
  waitForPortFree,
  writeProxyPid,
} from "../proxy-daemon.js";
import { buildProxyFromSettings } from "../proxy-runtime.js";
import { writeProxyDesired } from "../proxy-state.js";
import {
  ENV_BASE_URL,
  ENV_TOOL_SEARCH,
  proxyBaseUrl,
  readWiringState,
  unwireProxyEnv,
  wireProxyEnv,
  wiringGap,
} from "../proxy-wiring.js";

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
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new InitError(`invalid port "${portOpt}"`);
  }
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
  await writeProxyDesired(dir, "running", new Date().toISOString());
  const { port, upstream } = await resolvePort(dir, portOpt);
  await stopProxy(dir);
  await waitForPortFree(port);
  const credEnv = await credentialEnvForProxy(dir);
  const pid = await startDetached(dir, port, process.argv[1] ?? "", credEnv);
  if (pid === null) throw new InitError(`proxy did not come up on port ${port}`);
  return { pid, port, upstream };
}

/**
 * Decision 56: stop the pipeline but keep the port bound, by replacing the
 * running daemon with the redaction-only shim. Claude Code's
 * `ANTHROPIC_BASE_URL` cannot be un-set without a window reload
 * (verification-notes §112b), so leaving the socket dead is the defect; this is
 * the fix. Returns the shim's pid.
 */
async function startShimDetached(
  dir: string,
  portOpt?: string,
): Promise<{ pid: number; port: number }> {
  const { port } = await resolvePort(dir, portOpt);
  await stopProxy(dir);
  await waitForPortFree(port);
  const pid = await startDetached(
    dir,
    port,
    process.argv[1] ?? "",
    await credentialEnvForProxy(dir),
    { shim: true },
  );
  if (pid === null) {
    // Loud, not silent: falling back to a dead port is precisely the state this
    // command exists to prevent, so the user must be told the wiring is stale.
    throw new InitError(
      `the bypass shim did not come up on port ${port}. Claude Code is still wired to that port and will fail to connect — run \`golem proxy start --detach\` to restore the pipeline, or \`golem proxy unwire\` to send Claude Code direct.`,
    );
  }
  return { pid, port };
}

async function runProxyForeground(dir: string, portOpt?: string, shim = false): Promise<void> {
  const { settings, warnings } = await loadConfig({ projectDir: dir });
  // R9.6: config warnings — a renamed key, an unknown key, an unrecognized
  // GOLEM_* var — used to surface only in `golem status`, which nobody runs
  // after an upgrade that appears to work. The proxy is the thing that consumes
  // these settings, so it is the honest place to say the file names something
  // that no longer takes effect. Since R9.8 the detached daemon's stderr lands
  // in .golem/proxy.log rather than being discarded, so this actually reaches
  // someone.
  for (const warning of warnings) {
    process.stderr.write(`golem proxy: ${warning}\n`);
  }
  const { port } = await resolvePort(dir, portOpt);

  for (const [name, secret] of Object.entries(await credentialEnvForProxy(dir))) {
    process.env[name] ??= secret;
  }

  if (await portInUse(port)) {
    process.stdout.write(`golem proxy: already running on port ${port}\n`);
    return;
  }

  const telemetry = openTelemetryStore(dir);
  const { JsonFileSliderStore } = await import("../../mcp/index.js");
  const sliderStore = new JsonFileSliderStore(settingsFilePaths({ projectDir: dir }).local);
  let inference: InferenceService | undefined;
  let facts: Awaited<ReturnType<typeof detectCapability>> | undefined;
  try {
    const client = new OllamaClient({
      baseUrl: settings.inference.ollama_base_url,
      requestTimeoutMs: settings.inference.request_timeout_ms,
    });
    facts = await detectCapability(createProbeRunner());
    inference = new OllamaInferenceService(client, facts);
  } catch (err) {
    process.stderr.write(
      `golem proxy: local inference unavailable, local-answer sub-mode falls back to the hashing embedder (${
        err instanceof Error ? err.message : String(err)
      })\n`,
    );
  }
  let localAnswerInference: InferenceService | undefined;
  let suppressLocalAnswer = false;
  if (settings.knowledge.local_answer_enabled && inference !== undefined && facts !== undefined) {
    const persisted = await resolvePersistedEmbedMode(dir, dir);
    if (persisted === "semantic") {
      const model = embedModelFor(facts.tier, "text");
      if (await ollamaHasModel(settings.inference.ollama_base_url, model)) {
        localAnswerInference = inference;
      } else {
        suppressLocalAnswer = true;
        process.stderr.write(
          `golem proxy: local-answer disabled — the index was built with the semantic embed model "${model}", which isn't available now; run \`golem index\` to rebuild it lexically, or start Ollama and pull the model\n`,
        );
      }
    }
  }
  const { proxy, semantic, upstream } = buildProxyFromSettings(dir, settings, telemetry, {
    sliderStore,
    ...(localAnswerInference !== undefined ? { inference: localAnswerInference } : {}),
    ...(suppressLocalAnswer ? { suppressLocalAnswer: true } : {}),
    ...(shim ? { shim: true } : {}),
  });
  if (semantic !== undefined) {
    process.stdout.write(
      "golem proxy: Headroom semantic sidecar enabled (slider ≥3, opt-in, fail-open)\n",
    );
  }
  const addr = await proxy.listen(port);
  await writeProxyPid(dir, {
    pid: process.pid,
    port: addr.port,
    ts: new Date().toISOString(),
    ...(shim ? { shim: true } : {}),
  });
  const via = upstream.accountId === null ? "" : ` [account ${upstream.accountId}]`;
  const model = upstream.model === undefined ? "" : ` model ${upstream.model}`;
  process.stdout.write(
    shim
      ? `golem proxy: BYPASS SHIM listening on http://localhost:${addr.port} -> ${upstream.baseUrl}${via}${model} (pipeline off; redaction still on)\n`
      : `golem proxy listening on http://localhost:${addr.port} -> ${upstream.baseUrl}${via}${model} (slider level ${settings.slider.level})\n`,
  );
  const shutdown = (): void => {
    semantic?.stop();
    void Promise.allSettled([proxy.close(), telemetry.close(), removeProxyPid(dir)]).finally(() =>
      process.exit(0),
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export default function register(program: Command): void {
  const proxyCmd = program
    .command("proxy")
    .description("Golem proxy (Claude Code's ANTHROPIC_BASE_URL target)");

  proxyCmd
    .command("start", { isDefault: true })
    .description("Start the proxy (foreground; --detach runs it as a background daemon)")
    .option("--dir <path>", "project directory (for .golem/ config)", _DEFAULT_DIR)
    .option("--port <port>", "listen port (overrides config)")
    .option("--detach", "run in the background, surviving this shell", false)
    // Internal: how `proxy stop` re-launches the daemon as the Decision 56
    // bypass shim. Not for direct use — `golem proxy stop` is the surface.
    .option("--shim", "run as the redaction-only bypass shim (internal)", false)
    .action(async (opts: { dir: string; port?: string; detach: boolean; shim: boolean }) => {
      try {
        if (opts.shim) {
          await runProxyForeground(opts.dir, opts.port, true);
          return;
        }
        await writeProxyDesired(opts.dir, "running", new Date().toISOString());
        if (opts.detach) {
          const { port, upstream } = await resolvePort(opts.dir, opts.port);
          if (await portInUse(port)) {
            process.stdout.write(`golem proxy: already running on port ${port}\n`);
            return;
          }
          const pid = await startDetached(
            opts.dir,
            port,
            process.argv[1] ?? "",
            await credentialEnvForProxy(opts.dir),
          );
          if (pid === null) _fail(new InitError(`proxy did not come up on port ${port}`));
          process.stdout.write(
            `golem proxy started (pid ${pid}) on http://localhost:${port} -> ${upstream}\n`,
          );
          return;
        }
        await runProxyForeground(opts.dir, opts.port);
      } catch (err) {
        _fail(err);
      }
    });

  proxyCmd
    .command("stop")
    .description("Stop the pipeline, keeping the port served by a redaction-only shim")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--port <port>", "listen port (overrides config)")
    .option(
      "--hard",
      "also release the port — Claude Code will fail to connect until it is unwired or restarted",
      false,
    )
    .action(async (opts: { dir: string; port?: string; hard: boolean }) => {
      try {
        // --hard is the pre-Decision-56 behaviour, kept for "get off my port"
        // and made explicit about what it costs.
        if (opts.hard) {
          await writeProxyDesired(opts.dir, "stopped", new Date().toISOString());
          const pid = await stopProxy(opts.dir);
          process.stdout.write(
            pid === null
              ? "golem proxy: not running\n"
              : `golem proxy stopped (pid ${pid}); port released\n`,
          );
          const { port } = await resolvePort(opts.dir, opts.port);
          const wiring = await readWiringState(opts.dir, proxyBaseUrl(port));
          if (wiring.owner === "golem") {
            process.stdout.write(
              `golem proxy: Claude Code is still wired to ${wiring.baseUrl} and nothing is listening there.\n  \`golem proxy unwire\` sends it direct (needs a window reload), \`golem proxy start --detach\` brings the pipeline back.\n`,
            );
          }
          return;
        }
        await writeProxyDesired(opts.dir, "bypass", new Date().toISOString());
        const { pid, port } = await startShimDetached(opts.dir, opts.port);
        process.stdout.write(
          `golem proxy: pipeline OFF — bypass shim serving port ${port} (pid ${pid}).\n  Redaction still runs; compression, brevity and local-answer are off.\n  \`golem proxy start --detach\` restores the pipeline; \`golem proxy unwire\` takes Golem out of the path entirely.\n`,
        );
      } catch (err) {
        _fail(err);
      }
    });

  proxyCmd
    .command("unwire")
    .description("Remove Golem from .claude/settings.json so Claude Code talks direct")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--port <port>", "listen port (overrides config)")
    .option("--dry-run", "report what would change without writing", false)
    .action(async (opts: { dir: string; port?: string; dryRun: boolean }) => {
      try {
        const { port } = await resolvePort(opts.dir, opts.port);
        const result = await unwireProxyEnv(opts.dir, proxyBaseUrl(port), {
          dryRun: opts.dryRun,
        });
        if (result.foreignBaseUrl !== undefined) {
          process.stdout.write(
            `golem proxy: left ANTHROPIC_BASE_URL=${result.foreignBaseUrl} alone — Golem does not own it.\n`,
          );
          return;
        }
        if (!result.changed) {
          process.stdout.write("golem proxy: already unwired — Claude Code talks direct.\n");
          return;
        }
        process.stdout.write(
          `golem proxy: unwired${opts.dryRun ? " (dry run)" : ""} — removed ${ENV_BASE_URL} and ${ENV_TOOL_SEARCH} from .claude/settings.json.\n  Claude Code does NOT reload env settings — reload the window (or restart the CLI) for this to take effect.\n  \`golem proxy wire\` puts it back.\n`,
        );
      } catch (err) {
        _fail(err);
      }
    });

  proxyCmd
    .command("wire")
    .description("Point Claude Code back at the local proxy (inverse of unwire)")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--port <port>", "listen port (overrides config)")
    .option("--dry-run", "report what would change without writing", false)
    .action(async (opts: { dir: string; port?: string; dryRun: boolean }) => {
      try {
        const { port } = await resolvePort(opts.dir, opts.port);
        const result = await wireProxyEnv(opts.dir, proxyBaseUrl(port), { dryRun: opts.dryRun });
        if (result.foreignBaseUrl !== undefined) {
          _fail(
            new InitError(
              `.claude/settings.json already sets ${ENV_BASE_URL}=${result.foreignBaseUrl}. Another proxy or gateway owns this project's traffic — remove that setting before wiring Golem back in.`,
            ),
          );
        }
        if (!result.changed) {
          process.stdout.write(`golem proxy: already wired to http://localhost:${port}.\n`);
          return;
        }
        process.stdout.write(
          `golem proxy: wired${opts.dryRun ? " (dry run)" : ""} — Claude Code will use http://localhost:${port}.\n  Reload the window (or restart the CLI) for this to take effect.\n`,
        );
      } catch (err) {
        _fail(err);
      }
    });

  proxyCmd
    .command("restart")
    .description("Reliably stop then start the proxy as a background daemon")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--port <port>", "listen port (overrides config)")
    .option("--foreground", "restart in the foreground instead of detached", false)
    .action(async (opts: { dir: string; port?: string; foreground: boolean }) => {
      try {
        if (opts.foreground) {
          await writeProxyDesired(opts.dir, "running", new Date().toISOString());
          const { port } = await resolvePort(opts.dir, opts.port);
          await stopProxy(opts.dir);
          await waitForPortFree(port);
          await runProxyForeground(opts.dir, opts.port);
          return;
        }
        const { pid, port, upstream } = await restartProxyDetached(opts.dir, opts.port);
        process.stdout.write(
          `golem proxy restarted (pid ${pid}) on http://localhost:${port} -> ${upstream}\n`,
        );
      } catch (err) {
        _fail(err);
      }
    });

  proxyCmd
    .command("status")
    .description("Show whether the proxy is running")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; json: boolean }) => {
      try {
        const { port, upstream } = await resolvePort(opts.dir);
        const st = await proxyStatus(opts.dir, port);
        const ourBaseUrl = proxyBaseUrl(port);
        const wiring = await readWiringState(opts.dir, ourBaseUrl);
        if (opts.json) {
          // R8.32: `running` alone was never the question a caller is asking —
          // `in_path` is. Both are reported so the two can disagree visibly.
          process.stdout.write(
            `${JSON.stringify({
              ...st,
              upstream,
              wiring: wiring.owner,
              wiring_base_url: wiring.baseUrl,
              in_path: st.running && wiring.owner === "golem",
            })}\n`,
          );
          return;
        }
        if (!st.running) {
          // Decision 56: a dead port with live wiring is the defect — say so here
          // rather than leaving the user to discover it as a failed request.
          process.stdout.write("golem proxy: not running\n");
          if (wiring.owner === "golem") {
            process.stdout.write(
              `  ⚠ Claude Code is wired to ${wiring.baseUrl} and nothing is listening there.\n    \`golem proxy start --detach\` restores the pipeline; \`golem proxy unwire\` sends it direct.\n`,
            );
          }
          return;
        }
        process.stdout.write(
          st.shim === true
            ? `golem proxy: BYPASS shim${st.pid ? ` (pid ${st.pid})` : ""} on port ${st.port ?? port} -> ${upstream}\n  pipeline off; redaction still on. \`golem proxy start --detach\` restores it.\n`
            : `golem proxy: running${st.pid ? ` (pid ${st.pid})` : ""} on port ${st.port ?? port} -> ${upstream}\n`,
        );
        // R8.32: the daemon being up says nothing about whether traffic reaches
        // it. Reported after the pid line so the contradiction is impossible to
        // miss — a bare "running" here is exactly what hid the defect.
        const gap = wiringGap(wiring, ourBaseUrl);
        if (gap !== null) {
          process.stdout.write(
            `  ⚠ ${gap.problem}\n${gap.remedy === null ? "" : `    ${gap.remedy}\n`}`,
          );
        }
      } catch (err) {
        _fail(err);
      }
    });
}
