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

async function runProxyForeground(dir: string, portOpt?: string): Promise<void> {
  const { settings } = await loadConfig({ projectDir: dir });
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
  });
  if (semantic !== undefined) {
    process.stdout.write(
      "golem proxy: Headroom semantic sidecar enabled (slider ≥3, opt-in, fail-open)\n",
    );
  }
  const addr = await proxy.listen(port);
  await writeProxyPid(dir, { pid: process.pid, port: addr.port, ts: new Date().toISOString() });
  const via = upstream.accountId === null ? "" : ` [account ${upstream.accountId}]`;
  const model = upstream.model === undefined ? "" : ` model ${upstream.model}`;
  process.stdout.write(
    `golem proxy listening on http://localhost:${addr.port} -> ${upstream.baseUrl}${via}${model} (slider level ${settings.slider.level})\n`,
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
    .action(async (opts: { dir: string; port?: string; detach: boolean }) => {
      try {
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
    .description("Stop the running proxy")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .action(async (opts: { dir: string }) => {
      try {
        await writeProxyDesired(opts.dir, "stopped", new Date().toISOString());
        const pid = await stopProxy(opts.dir);
        process.stdout.write(
          pid === null ? "golem proxy: not running\n" : `golem proxy stopped (pid ${pid})\n`,
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
        if (opts.json) {
          process.stdout.write(`${JSON.stringify({ ...st, upstream })}\n`);
          return;
        }
        process.stdout.write(
          st.running
            ? `golem proxy: running${st.pid ? ` (pid ${st.pid})` : ""} on port ${st.port ?? port} -> ${upstream}\n`
            : "golem proxy: not running\n",
        );
      } catch (err) {
        _fail(err);
      }
    });
}
