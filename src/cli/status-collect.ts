/**
 * WS-E E3 — `golem status` collection.
 *
 * The I/O-and-assembly half of the status engine. Collects, without side effects:
 *   - the effective config with per-key provenance (E1 loader),
 *   - whether this project is wired to Golem (init.ts file checks),
 *   - whether the proxy answers on the configured port (short HTTP probe),
 *   - the effective slider level.
 *
 * Split out of `./status.ts`, which remains the public surface and re-exports
 * everything below that was exported before the split.
 */

import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { resolveEffectiveCompression } from "../compression/effective-level.js";
import { unreachableHeadroomConfigKeys } from "../compression/headroom-adapter.js";
import { loadConfig } from "../config/index.js";
import { STALE_AFTER_MS } from "../hooks/snooze-nudge.js";
import { selectTarget } from "../inference/target-dispatcher.js";
import { KNOWN_WORKERS, unknownWorkerWarnings } from "../inference/workers.js";
import {
  listTargets,
  resolveDefaultTargetId,
  resolveUpstreamDisplay,
  upstreamAssumesCaching,
  withDefaultTarget,
} from "../providers/index.js";
// Narrow modules rather than `../proxy/index.js`: that barrel reaches server.ts,
// which imports `undici` (~270ms), and both of these only read a JSON file.
import { type LimitPrediction, readLimitState } from "../proxy/limit-prediction.js";
import { loopbackCaPath } from "../proxy/loopback-cert.js";
import { readLoopbackServeState } from "../proxy/loopback-serve.js";
import { readServedModel, servedModelFor } from "../proxy/served-model.js";
import { readCachedUpdateCheck, semverGt } from "../update/index.js";
import { getDialInfo } from "./dials.js";
import { golemInitStatus } from "./init.js";
import {
  type LocalModelInfo,
  type ProviderEntry as LocalProviderEntry,
  probeAndCacheLocalModelInfo,
} from "./local-model.js";
import { proxyLogPath, proxyStatus } from "./proxy-daemon.js";
import {
  claudeLocalSettingsPath,
  claudeSettingsPath,
  ENV_EXTRA_CA,
  proxyBaseUrl,
  readWiringState,
  samePath,
  type WiringState,
} from "./proxy-wiring.js";
import { getSliderInfo } from "./slider.js";
import type { ConfigKeyStatus, StatusOptions, StatusReport } from "./status.js";
import {
  dialJson,
  effectiveCompressionJson,
  sliderJson,
  sliderLevelFromDial,
} from "./status-render.js";
import { inspectVscodeExtension, staleExtensionWarning } from "./vscode-extension.js";

/**
 * R9.12 — answer the colour question honestly, separating "configured" from
 * "in effect". `trusted` reads THIS process's environment, which is the only
 * evidence that survives §112's read-once-at-startup rule.
 */
async function webFetchGreenStatus(
  projectDir: string,
): Promise<NonNullable<StatusReport["webfetch_green"]>> {
  const caPath = loopbackCaPath(projectDir);
  const same = (value: string | undefined): boolean =>
    value !== undefined && value.length > 0 && samePath(value, caPath);

  const readCaFrom = async (file: string): Promise<string | undefined> => {
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as { env?: Record<string, unknown> };
      const value = raw.env?.[ENV_EXTRA_CA];
      return typeof value === "string" && value.length > 0 ? value : undefined;
    } catch {
      // no settings file / unreadable → nothing wired here
      return undefined;
    }
  };

  // R9.22: init writes the trust into `.claude/settings.local.json`, which also
  // OUTRANKS the committed file in Claude Code's ladder (notes §13) — so read it
  // first and let it decide. The committed file is still consulted behind it, for
  // a project initialized before the move and for a value the user put there.
  const wiredValue =
    (await readCaFrom(claudeLocalSettingsPath(projectDir))) ??
    (await readCaFrom(claudeSettingsPath(projectDir)));

  const inProcess = process.env[ENV_EXTRA_CA];
  const foreign = [wiredValue, inProcess].find((v) => v !== undefined && v.length > 0 && !same(v));

  return {
    endpoint: (await readLoopbackServeState(projectDir)) !== null,
    wired: same(wiredValue),
    trusted: same(inProcess),
    ...(foreign !== undefined ? { foreign_ca: foreign } : {}),
  };
}

const DEFAULT_PROBE_TIMEOUT_MS = 1_500;

/**
 * True when an HTTP server answers at all on `127.0.0.1:port` — any status
 * code counts (the proxy forwards upstream, so even an upstream error reply
 * proves the proxy itself is alive). Never rejects.
 */
export function probeProxy(
  port: number,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/", method: "GET", timeout: timeoutMs },
      (res) => {
        res.resume(); // drain; we only care that something answered
        resolve(true);
        req.destroy();
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

export async function collectStatus(options: StatusOptions): Promise<StatusReport> {
  const projectDir = path.resolve(options.projectDir);
  const { settings, provenance, warnings } = await loadConfig({
    projectDir,
    ...(options.userDir !== undefined && { userDir: options.userDir }),
    ...(options.env !== undefined && { env: options.env }),
  });

  // R9.16: cheap (a few file hashes) and only ever read here.
  const vscode = await inspectVscodeExtension(
    options.vscodeExtensionsDir === undefined ? {} : { extensionsDir: options.vscodeExtensionsDir },
  );

  const sliderOpts = {
    projectDir,
    ...(options.userDir !== undefined && { userDir: options.userDir }),
    ...(options.env !== undefined && { env: options.env }),
  };
  // R6.2 display: the ACTIVE account/provider/model the proxy fronts (not just
  // the top-level base URL). No network, no secret — see resolveUpstreamDisplay.
  // Resolved before the reads below because the last-served-model lookup is
  // scoped to this account (a snapshot from the previous upstream must not be
  // reported as the current model).
  // R9.23: default_target moved from proxy to inference — merge it so the
  // display reflects the actual default target (e.g. openrouter:deepseek/...).
  const upstream = resolveUpstreamDisplay(withDefaultTarget(settings));

  const localProbe = options.localProbe ?? probeAndCacheLocalModelInfo;
  const [init, reachable, daemon, slider, brevityDial, compressionDial, localInfo, servedModel] =
    await Promise.all([
      golemInitStatus(projectDir, settings.proxy.port),
      probeProxy(settings.proxy.port, options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS),
      // Which BUILD is answering, not just whether something is. A daemon serves
      // the code and config it started with, so a rebuild since then has not
      // reached it — and every other field here would still look healthy.
      proxyStatus(projectDir, settings.proxy.port),
      getSliderInfo(sliderOpts),
      // Decision 52: the slider is a preset over two dials, so status must report
      // BOTH and say which of them the slider is actually driving.
      getDialInfo("brevity", sliderOpts),
      getDialInfo("compression", sliderOpts),
      localProbe(
        projectDir,
        settings.inference.ollama_base_url,
        settings.inference.providers as readonly LocalProviderEntry[],
      ).catch((): LocalModelInfo => ({ reachable: false })),
      servedModelFor(projectDir, upstream.accountId).catch(() => null),
    ]);

  // R9.2: per-target rows, each carrying what that target last served. Read from
  // the same snapshot the proxy writes, so status never has to reach the daemon.
  // R9.23: default_target moved to inference — merge it so
  // resolveDefaultTargetId and listTargets see the live value.
  const proxyWithDefault = withDefaultTarget(settings);
  const allServed = await readServedModel(projectDir).catch(() => null);
  const defaultTargetId = resolveDefaultTargetId(proxyWithDefault);
  const targetRows = listTargets(proxyWithDefault).map((t) => {
    const seen = allServed?.targets?.[t.id];
    return {
      id: t.id,
      provider: t.provider,
      base_url: t.baseUrl,
      model: t.model ?? null,
      trust: t.trust,
      account: t.accountId,
      is_default: t.id === defaultTargetId,
      ...(seen !== undefined
        ? { last_served_model: seen.model, last_served_at: seen.servedAtIso }
        : {}),
    };
  });

  // R9.4: which target each tool worker drafts on by default. A target id that
  // resolves to nothing is a misconfiguration worth naming, not something to
  // paper over — the worker fails closed on it rather than quietly using the
  // local model. Built generically so a new worker needs no change here.
  //
  // R10.8: a row for EVERY known worker, not only the ones with a
  // `worker_targets` entry, and each carries the `route` that produced it. The
  // old shape could only answer "which workers did you configure"; the question
  // a user actually has is "where does the next `coder` draft go", and the
  // unconfigured worker — which now lands on `inference.default_target` or the
  // harness upstream rather than silently on the local model — is precisely the
  // one that used to have no row at all. Asked through the dispatcher's own
  // `selectTarget`, so status cannot predict one destination while dispatch
  // picks another.
  const workerRows = KNOWN_WORKERS.map((worker) => {
    const { id, route } = selectTarget(
      { settings: proxyWithDefault, workerTargets: settings.inference.worker_targets },
      { worker },
    );
    const row = targetRows.find((t) => t.id === id);
    return {
      worker,
      target: id,
      route,
      ...(row?.model != null ? { model: row.model } : {}),
      ...(row === undefined ? { target_unknown: true } : {}),
      // R9.10: say plainly whether this worker is actually running locally,
      // rather than leaving every surface to infer it from the trust level.
      ...(row !== undefined ? { local: row.trust === "local" } : {}),
    };
  });

  // R8.32: `init.claudeSettingsWired` is a bare boolean, so it cannot tell "no
  // wiring at all" from "another gateway owns it" — and those have different
  // remedies (the second one is not ours to fix). Read the owner properly.
  const wiring = await readWiringState(projectDir, proxyBaseUrl(settings.proxy.port)).catch(
    (): WiringState => ({ owner: "none", baseUrl: null }),
  );

  // Update status from the cached check only (no network — never hang status).
  // Recompute "available" against the version we're actually running.
  const cachedUpdate = await readCachedUpdateCheck(path.join(projectDir, ".golem", "state"));

  // Usage-limit prediction freshness (read-only; snooze P2a). A stale reading
  // means the proxy has stopped seeing the rate-limit headers (the auto-park is
  // blind) — surfaced both as a field and, when stale, a warning.
  const nowMs = options.now?.() ?? Date.now();
  const limitState = await (options.readLimit ?? readLimitState)(projectDir).catch(() => null);
  const baseLimits =
    limitState === null ? undefined : buildLimits(limitState, nowMs, settings.snooze.enforce);
  // R9.2: name the target this reading came from, and every target it says
  // nothing about. Without that, one target's utilization reads as coverage for
  // all of them — and the auto-park is blind for the rest without saying so.
  const limits =
    baseLimits === undefined
      ? undefined
      : {
          ...baseLimits,
          ...(limitState?.targetId !== undefined && limitState.targetId !== null
            ? { source_target: limitState.targetId }
            : {}),
          ...(targetRows.length > 1
            ? {
                unmonitored_targets: targetRows
                  .filter((t) => t.id !== limitState?.targetId)
                  .map((t) => t.id),
              }
            : {}),
        };

  // §103: what the compression dial will ACTUALLY do on this upstream. The dial —
  // not the slider — is the input-side level the pipeline reads (Decision 52), and
  // it may be pinned away from the slider, so predict from the dial's effective
  // value. The provider override wins over the URL heuristic exactly as it does in
  // the pipeline; `undefined` means "use the heuristic" and must not be passed.
  const assumeCaching = upstreamAssumesCaching(upstream.provider);
  const effective = resolveEffectiveCompression({
    level: sliderLevelFromDial(compressionDial.effective, slider.level),
    upstreamBaseUrl: upstream.baseUrl,
    ...(assumeCaching !== undefined && { assumeCachingUpstream: assumeCaching }),
    headroomSidecar: settings.compression.headroom_sidecar,
    forceSemanticOnCaching: settings.compression.force_semantic_on_caching,
  });

  const config: Record<string, ConfigKeyStatus> = {};
  for (const [dotted, entry] of Object.entries(provenance)) {
    const [section, key] = dotted.split(".", 2) as [string, string];
    const sectionValues = (settings as unknown as Record<string, Record<string, unknown>>)[section];
    config[dotted] = {
      value: sectionValues?.[key],
      layer: entry.layer,
      ...(entry.source !== undefined && { source: entry.source }),
    };
  }

  const unreachableKeys = unreachableHeadroomConfigKeys(settings.compression.headroom_config);
  return {
    version: options.version,
    project_dir: projectDir,
    initialized: {
      overall: init.initialized,
      claude_settings: init.claudeSettingsWired,
      mcp_registered: init.mcpRegistered,
      skills: init.skillsInstalled,
      golem_settings: init.golemSettingsPresent,
    },
    webfetch_green: await webFetchGreenStatus(projectDir),
    proxy: {
      port: settings.proxy.port,
      url: `http://localhost:${settings.proxy.port}`,
      reachable,
      wiring: wiring.owner,
      wiring_base_url: wiring.baseUrl,
      in_path: reachable && wiring.owner === "golem",
      // R9.8: a detached daemon's warnings used to go to `stdio: "ignore"`.
      // They now land here, so name the file — a diagnostic nobody can find is
      // the same as no diagnostic.
      log: proxyLogPath(projectDir),
      // "Reachable" answered "is something listening", never "is it the build
      // you just installed". A daemon keeps serving its startup code and config,
      // so those are different questions and both get reported.
      ...(daemon.version !== undefined ? { running_version: daemon.version } : {}),
      ...(daemon.stale === true ? { stale: true } : {}),
    },
    upstream: {
      provider: upstream.provider,
      account: upstream.accountId,
      base_url: upstream.baseUrl,
      default_model: upstream.model ?? null,
      ...(servedModel !== null
        ? { last_served_model: servedModel.model, last_served_at: servedModel.servedAtIso }
        : {}),
    },
    // R9.2: only when the proxy is actually serving more than one target —
    // otherwise the `upstream` block above already answers the question and a
    // one-row table would be noise.
    ...(targetRows.length > 1 ? { targets: targetRows } : {}),
    slider: sliderJson(slider),
    dials: { brevity: dialJson(brevityDial), compression: dialJson(compressionDial) },
    effective_compression: effectiveCompressionJson(effective),
    ...(unreachableKeys.length > 0 ? { unreachable_headroom_config: unreachableKeys } : {}),
    config,
    local_model: {
      reachable: localInfo.reachable,

      ...(localInfo.coderModel !== undefined ? { model: localInfo.coderModel } : {}),
      base_url: settings.inference.ollama_base_url,
    },
    // R9.10: top-level, because a worker's target need not be local.
    ...(workerRows.length > 0 ? { workers: workerRows } : {}),
    ...(cachedUpdate !== null
      ? {
          update: {
            available:
              cachedUpdate.latest !== null && semverGt(cachedUpdate.latest, options.version),
            current: options.version,
            latest: cachedUpdate.latest,
          },
        }
      : {}),
    ...(limits !== undefined ? { limits } : {}),
    warnings: [
      ...(cachedUpdate?.latest != null && semverGt(cachedUpdate.latest, options.version)
        ? [...updateWarnings(cachedUpdate.latest, slider.level), ...warnings]
        : slider.level === 0
          ? [...warnings, REDACTION_OFF_WARNING]
          : warnings),
      ...(limits?.stale ? [LIMIT_STALE_WARNING] : []),
      // R9.4: a `worker_targets` key naming no worker would otherwise be silently
      // ignored — the failure mode the map shape trades per-key schema docs for.
      ...unknownWorkerWarnings(settings.inference.worker_targets),
      // R9.16: a deployed extension older than the one we ship renders stale
      // facts — it named the coder's model as the local one long after the coder
      // had moved. Status names it; only `golem init` fixes it (a read-only
      // diagnostic that rewrote an install would be its own surprise).
      ...(vscode.state === "stale" ? [staleExtensionWarning(vscode)] : []),
    ],
    ...(vscode.state !== "unknown" ? { vscode } : {}),
  };
}

/**
 * Build the {@link StatusReport}["limits"] view from a persisted prediction.
 * `stale` uses the same {@link STALE_AFTER_MS} threshold the snooze auto-park
 * trigger uses, so `golem status` and the trigger agree on when the feed is cold.
 */
function buildLimits(
  pred: LimitPrediction,
  nowMs: number,
  enforced: boolean,
): StatusReport["limits"] {
  const observedMs = Date.parse(pred.observedAtIso);
  const ageMs = Number.isFinite(observedMs)
    ? Math.max(0, nowMs - observedMs)
    : Number.POSITIVE_INFINITY;
  return {
    five_hour_utilization: pred.fiveHour.utilization,
    ...(pred.sevenDay !== undefined ? { seven_day_utilization: pred.sevenDay.utilization } : {}),
    reset_at: pred.fiveHour.resetAtIso,
    observed_at: pred.observedAtIso,
    age_minutes: Number.isFinite(ageMs) ? Math.round(ageMs / 60_000) : -1,
    stale: ageMs > STALE_AFTER_MS,
    enforced,
  };
}

/** Warning shown when the rate-limit feed has gone cold (auto-park is blind). */
export const LIMIT_STALE_WARNING =
  "Usage-limit prediction is STALE — Golem hasn't seen fresh rate-limit headers " +
  "recently, so the snooze auto-park is BLIND. The active account/upstream may not " +
  "emit `anthropic-ratelimit-unified-*` headers (common after an account switch). " +
  "Watch Claude Code's own limit indicator and park manually if needed.";

/** Warning lines when a newer version is known (plus the level-0 redaction one). */
function updateWarnings(latest: string, sliderLevel: number): string[] {
  const w = [`A newer Golem is available (${latest}). Run \`golem update\`.`];
  if (sliderLevel === 0) w.push(REDACTION_OFF_WARNING);
  return w;
}

/** Shown whenever the slider is at level 0 (passthrough): redaction is disabled. */
export const REDACTION_OFF_WARNING =
  "Slider level 0 (passthrough) is a FULL BYPASS: redaction is OFF, so secrets/PII " +
  "reach the upstream unredacted. Use level 1 to keep redaction on.";
