/**
 * golem on / off / proxy — simplified surface for the pipeline toggle.
 *
 * R9.23: the daemon is always running once `golem init` finishes. `golem on`
 * and `golem off` toggle the pipeline (redaction/compression/brevity) via an
 * in-process admin endpoint — no restart, no wire changes, no dead sockets.
 * `golem proxy` shows status; all other proxy subcommands are removed.
 */

import { request } from "node:http";
import type { Command } from "commander";
import {
  reapOrphanedHeadroomWorkers,
  stopAllHeadroomWorkers,
} from "../../compression/headroom-adapter.js";
import {
  findProjectDir,
  loadConfig,
  migrateOnVersionChange,
  settingsFilePaths,
} from "../../config/index.js";
import { VERSION } from "../../index.js";
import {
  createProbeRunner,
  detectCapability,
  embedModelFor,
  OllamaClient,
  OllamaInferenceService,
} from "../../inference/index.js";
import type { InferenceService } from "../../interfaces/inference.js";
import { resolveUpstreamDisplay } from "../../providers/index.js";
import { ensureLoopbackCert } from "../../proxy/loopback-cert.js";
import { startLoopbackServe } from "../../proxy/loopback-serve.js";
import { openTelemetryStore } from "../../telemetry/index.js";
import { planQueryEmbedder, resolvePersistedEmbedder } from "../auto-index.js";
import { ollamaHasModel } from "../build-knowledge.js";
import { credentialEnvForProxy } from "../gateways.js";
import { InitError } from "../init.js";
import {
  CREDENTIALS_INJECTED_ENV,
  portInUse,
  proxyStatus,
  removeProxyPid,
  startDetached,
  stopProxy,
  waitForPortFree,
  writeProxyPid,
} from "../proxy-daemon.js";
import { buildProxyFromSettings } from "../proxy-runtime.js";
import {
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

/** POST to the proxy's admin endpoint — does NOT need a restart or reload. */
async function togglePipeline(dir: string, enabled: boolean, portOpt?: string): Promise<void> {
  const { port } = await resolvePort(dir, portOpt);
  if (!(await portInUse(port))) {
    throw new InitError(
      `proxy is not running on port ${port}. Start it first with \`golem init\` or ` +
        "via the SessionStart hook (reopen the project).",
    );
  }
  return new Promise((resolve, reject) => {
    const body = "";
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: `/__golem/pipeline/${enabled}`,
        method: "POST",
        headers: { "content-length": Buffer.byteLength(body) },
        timeout: 2000,
      },
      (res) => {
        res.resume();
        resolve();
      },
    );
    req.on("error", (err) => reject(new InitError(`could not reach the proxy: ${err.message}`)));
    req.on("timeout", () => {
      req.destroy();
      reject(new InitError("proxy did not respond in time — is it running?"));
    });
    req.end(body);
  });
}

/**
 * The SessionStart hook's auto-recovery: read the URL from `.claude/settings.json`.
 * If it points at Golem's port and nothing is listening, restart the daemon.
 * Also defined here so `golem on` can share the same recovery path.
 */
export async function ensureProxyRunning(
  dir: string,
  port: number,
): Promise<{ pid: number; port: number }> {
  const st = await proxyStatus(dir, port);
  if (st.running) return { pid: st.pid ?? 0, port: st.port ?? port };
  const wiring = await readWiringState(dir, proxyBaseUrl(port));
  if (wiring.owner !== "golem") {
    throw new InitError(
      `project is not wired to Golem — ${wiring.baseUrl ? `another gateway owns ANTHROPIC_BASE_URL (${wiring.baseUrl})` : "no ANTHROPIC_BASE_URL is set"}. Run \`golem init\` to wire it.`,
    );
  }
  // Daemon died — restart it
  const pid = await startDetached(
    dir,
    port,
    process.argv[1] ?? "",
    await credentialEnvForProxy(dir),
  );
  if (pid === null) throw new InitError(`proxy did not come up on port ${port}`);
  return { pid, port };
}

async function runProxyForeground(dir: string, portOpt?: string): Promise<void> {
  // R9.13: first start under a new version — rewrite retired setting names.
  for (const line of (await migrateOnVersionChange({ projectDir: dir, version: VERSION })).lines) {
    process.stderr.write(`golem config: ${line}\n`);
  }
  const { settings, warnings } = await loadConfig({ projectDir: dir });
  for (const warning of warnings) {
    process.stderr.write(`golem proxy: ${warning}\n`);
  }
  const { port } = await resolvePort(dir, portOpt);

  // R9.20: skip this entirely when the parent already resolved and injected them
  // (`startDetached` sets the marker alongside the credentials). The injection
  // below is `??=`, so a second resolution's results were discarded anyway — it
  // was pure duplicated cost, and at the measured 6668ms it was most of an ~18s
  // restart. A hand-run `golem proxy run` has no marker and resolves normally.
  if (process.env[CREDENTIALS_INJECTED_ENV] === undefined) {
    for (const [name, secret] of Object.entries(await credentialEnvForProxy(dir))) {
      process.env[name] ??= secret;
    }
  }

  if (await portInUse(port)) {
    process.stdout.write(`golem proxy: already running on port ${port}\n`);
    return;
  }

  // R10.3: reap Headroom sidecars stranded by an EARLIER daemon for this project
  // before starting our own. New daemons cannot strand them (the workers exit on
  // stdin EOF), but processes already running the old code never will on their
  // own — 24 of them had piled up here, the oldest five days old. Started now and
  // awaited just before `listen`, so it overlaps the credential/capability work
  // instead of adding to start-up latency, and still completes before this
  // process can spawn a sidecar of its own (which the sweep could not tell from a
  // stray one). Never throws: a failed sweep must not stop the proxy starting.
  const sweep = reapOrphanedHeadroomWorkers({
    projectDir: dir,
    log: (m) => process.stderr.write(`golem proxy: ${m}\n`),
  });

  const telemetry = openTelemetryStore(dir);
  const { JsonFileSliderStore } = await import("../../mcp/index.js");
  const sliderStore = new JsonFileSliderStore(settingsFilePaths({ projectDir: dir }).local);
  let inference: InferenceService | undefined;
  let facts: Awaited<ReturnType<typeof detectCapability>> | undefined;
  let ollamaClient: OllamaClient | undefined;
  try {
    const client = new OllamaClient({
      baseUrl: settings.inference.ollama_base_url,
      requestTimeoutMs: settings.inference.request_timeout_ms,
    });
    ollamaClient = client;
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
    // R10.4: pick the embedder by INDEX IDENTITY, not availability. The tier is
    // a runtime probe that degrades to CPU on any hiccup, which used to swap a
    // 1024-dim embedder for a 768-dim one under an index that could not accept
    // it — passing the old "is a model available?" guard and then throwing
    // EmbedderMismatchError on every single query. Decided ONCE, here.
    const plan = await planQueryEmbedder(
      await resolvePersistedEmbedder(dir, dir),
      embedModelFor(facts.tier, "text"),
      (model) => ollamaHasModel(settings.inference.ollama_base_url, model),
    );
    if (plan.action === "use-current") {
      localAnswerInference = inference;
    } else if (plan.action === "pin" && ollamaClient !== undefined) {
      // The index's embedder wins over the current tier's; chat stays on tier.
      localAnswerInference = new OllamaInferenceService(ollamaClient, facts, {
        embedModels: { text: plan.model, code: plan.model },
      });
      process.stdout.write(
        `golem proxy: local-answer querying with "${plan.model}" — the embedder this index was built with (the detected hardware tier would have used "${plan.currentModel}")\n`,
      );
    } else if (plan.action !== "lexical") {
      suppressLocalAnswer = true;
      const reason =
        plan.action === "disable" ? plan.reason : "the index's embedder could not be resolved";
      process.stderr.write(`golem proxy: local-answer disabled — ${reason}\n`);
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
  await sweep;
  const addr = await proxy.listen(port);
  await writeProxyPid(dir, {
    pid: process.pid,
    port: addr.port,
    ts: new Date().toISOString(),
    // Stamp the build we are actually running, so every later "is the proxy
    // running" check can also answer "is it THIS build" (see ProxyStatus.stale).
    version: VERSION,
  });
  const via = upstream.accountId === null ? "" : ` [account ${upstream.accountId}]`;
  const model = upstream.model === undefined ? "" : ` model ${upstream.model}`;
  process.stdout.write(
    `golem proxy listening on http://localhost:${addr.port} -> ${upstream.baseUrl}${via}${model} (slider level ${settings.slider.level})\n`,
  );

  // Loopback serve for green WebFetch
  let loopback: Awaited<ReturnType<typeof startLoopbackServe>> | null = null;
  try {
    const cert = await ensureLoopbackCert(dir);
    loopback = await startLoopbackServe({
      projectDir: dir,
      certPem: cert.chainPem,
      keyPem: cert.leafKeyPem,
      certPath: cert.caPath,
    });
    process.stdout.write(`golem proxy: loopback serve on https://127.0.0.1:${loopback.port}\n`);
  } catch (err) {
    process.stderr.write(
      `golem proxy: loopback serve unavailable (${
        err instanceof Error ? err.message : String(err)
      }); served WebFetches use the deny path\n`,
    );
  }

  const shutdown = (): void => {
    // Every sidecar, not just the semantic one: this handler used to stop
    // `semantic` alone, so the MEMORY sidecar leaked even on a clean POSIX
    // shutdown (R10.3). One teardown that the adapter keeps complete is the only
    // version of this that stays correct when a third sidecar appears.
    stopAllHeadroomWorkers();
    void Promise.allSettled([
      proxy.close(),
      telemetry.close(),
      removeProxyPid(dir),
      ...(loopback === null ? [] : [loopback.close()]),
    ]).finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export default function register(program: Command): void {
  // `golem on` — enable the pipeline on the running proxy
  program
    .command("on")
    .description("Enable the proxy pipeline (redaction, compression, brevity)")
    .option("--dir <path>", "project directory", process.cwd())
    .action(async (opts: { dir: string }) => {
      try {
        const { port } = await resolvePort(opts.dir);
        await ensureProxyRunning(opts.dir, port);
        await togglePipeline(opts.dir, true);
        process.stdout.write(`golem on — pipeline enabled on http://localhost:${port}\n`);
      } catch (err) {
        _fail(err);
      }
    });

  // `golem off` — disable the pipeline (proxy still forwards, no processing)
  program
    .command("off")
    .description("Disable the proxy pipeline (pass-through forwarding, no redaction/compression)")
    .option("--dir <path>", "project directory", process.cwd())
    .action(async (opts: { dir: string }) => {
      try {
        const { port } = await resolvePort(opts.dir);
        await ensureProxyRunning(opts.dir, port);
        await togglePipeline(opts.dir, false);
        process.stdout.write(
          `golem off — pipeline disabled on http://localhost:${port}; proxy still forwards requests raw\n`,
        );
      } catch (err) {
        _fail(err);
      }
    });

  const proxyCmd = program
    .command("proxy")
    .description("Golem proxy (Claude Code's ANTHROPIC_BASE_URL target) — status and lifecycle");

  proxyCmd
    .command("status", { isDefault: true })
    .description("Show whether the proxy is running and whether the pipeline is active")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; json: boolean }) => {
      try {
        const { port, upstream } = await resolvePort(opts.dir);
        const st = await proxyStatus(opts.dir, port);
        const ourBaseUrl = proxyBaseUrl(port);
        const wiring = await readWiringState(opts.dir, ourBaseUrl);

        if (opts.json) {
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
          process.stdout.write("golem proxy: not running\n");
          if (wiring.owner === "golem") {
            process.stdout.write(
              `  ⚠ Claude Code is wired to ${wiring.baseUrl} and nothing is listening there.\n    The SessionStart hook will restart it on the next project open.\n`,
            );
          }
          return;
        }
        process.stdout.write(
          `golem proxy: running (pid ${st.pid ?? "?"}) on port ${st.port ?? port} -> ${upstream}\n`,
        );
        // R9.23: pipeline state is an in-process toggle, not a separate binary.
        process.stdout.write(
          "  Pipeline is active. Run `golem off` to disable (pass-through); `golem on` to re-enable.\n",
        );
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

  proxyCmd
    .command("start")
    .description("Start the proxy in the foreground (detached daemon entry-point)")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--port <port>", "port number")
    .action(async (opts: { dir: string; port: string | undefined }) => {
      await runProxyForeground(opts.dir, opts.port);
    });

  proxyCmd
    .command("restart")
    .description("Reliably stop then start the proxy daemon (for crash recovery)")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--foreground", "restart in the foreground instead of detached", false)
    .action(async (opts: { dir: string; foreground: boolean }) => {
      try {
        const { port, upstream } = await resolvePort(opts.dir);
        await stopProxy(opts.dir);
        if (!(await waitForPortFree(port))) {
          _fail(
            new InitError(
              `port ${port} is still in use after stopping — something else is holding it.`,
            ),
          );
        }
        if (opts.foreground) {
          await runProxyForeground(opts.dir);
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
          `golem proxy restarted (pid ${pid}) on http://localhost:${port} -> ${upstream}\n`,
        );
      } catch (err) {
        _fail(err);
      }
    });

  /**
   * `golem proxy wire` / `unwire` — point Claude Code at the proxy, or stop.
   *
   * These were specified but never registered. `golem status` and the control
   * panel have been telling people to run `golem proxy wire` for releases —
   * a test even pins that it "names `golem proxy wire`, not the far heavier
   * `golem init`" — while the CLI answered "unknown command" and commander fell
   * through to `status`. The engine (`wireProxyEnv`/`unwireProxyEnv`, Decision
   * 56) was written and unit-tested the whole time; only the surface was
   * missing.
   *
   * Deliberately narrow, which is the point of offering it over `golem init`:
   * it edits ONLY the `ANTHROPIC_BASE_URL` / `ENABLE_TOOL_SEARCH` pair, touching
   * no skills, hooks, MCP registration or certificates. It also never clobbers a
   * base URL somebody else owns (§121-C) — a foreign gateway is reported and
   * left alone.
   */
  proxyCmd
    .command("wire")
    .description("Point Claude Code's ANTHROPIC_BASE_URL at this project's proxy")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--dry-run", "report what would change without writing", false)
    .action(async (opts: { dir: string; dryRun: boolean }) => {
      try {
        const { port } = await resolvePort(opts.dir);
        const baseUrl = proxyBaseUrl(port);
        const result = await wireProxyEnv(opts.dir, baseUrl, { dryRun: opts.dryRun });
        if (result.foreignBaseUrl !== undefined) {
          _fail(
            new InitError(
              `ANTHROPIC_BASE_URL is already set to ${result.foreignBaseUrl}, which Golem does ` +
                "not own — refusing to overwrite it. Clear it yourself first if that is intended.",
            ),
          );
        }
        if (!result.changed) {
          process.stdout.write(`golem proxy: already wired to ${baseUrl}\n`);
          return;
        }
        process.stdout.write(
          opts.dryRun
            ? `golem proxy: would wire ANTHROPIC_BASE_URL -> ${baseUrl} (nothing written)\n`
            : `golem proxy: wired ANTHROPIC_BASE_URL -> ${baseUrl}\n`,
        );
        // `env` is read once at startup (§13/§112b), so a wire that reports plain
        // success leaves the user proxied-in-settings and unproxied-in-fact.
        if (!opts.dryRun && result.needsReload) {
          process.stdout.write("  Reload the window (Developer: Reload Window) to pick it up.\n");
        }
      } catch (err) {
        _fail(err);
      }
    });

  proxyCmd
    .command("unwire")
    .description("Remove Golem's ANTHROPIC_BASE_URL wiring (Claude Code talks upstream directly)")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--dry-run", "report what would change without writing", false)
    .action(async (opts: { dir: string; dryRun: boolean }) => {
      try {
        const { port } = await resolvePort(opts.dir);
        const result = await unwireProxyEnv(opts.dir, proxyBaseUrl(port), {
          dryRun: opts.dryRun,
        });
        if (result.foreignBaseUrl !== undefined) {
          process.stdout.write(
            `golem proxy: ANTHROPIC_BASE_URL is ${result.foreignBaseUrl}, which Golem does not ` +
              "own — left untouched.\n",
          );
          return;
        }
        if (!result.changed) {
          process.stdout.write("golem proxy: nothing wired — no change\n");
          return;
        }
        process.stdout.write(
          opts.dryRun
            ? "golem proxy: would remove Golem's ANTHROPIC_BASE_URL wiring (nothing written)\n"
            : "golem proxy: removed Golem's ANTHROPIC_BASE_URL wiring\n",
        );
        if (!opts.dryRun && result.needsReload) {
          process.stdout.write("  Reload the window (Developer: Reload Window) to pick it up.\n");
        }
      } catch (err) {
        _fail(err);
      }
    });
}
