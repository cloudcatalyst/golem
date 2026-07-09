/**
 * CLI integration glue: assemble a real `GolemProxy` + request pipeline from
 * already-loaded settings, so `golem proxy` (main.ts `runProxyForeground`)
 * and tests that need a real proxy instance share one construction path.
 *
 * Deliberately excludes anything CLI-process-specific: `portInUse` checks,
 * pid-file writing, stdout logging, and SIGINT/SIGTERM/process.exit handling
 * all stay in `runProxyForeground` — this module only builds the objects.
 */

import { HeadroomSidecar } from "../compression/headroom-adapter.js";
import { NativeLosslessCompression } from "../compression/index.js";
import { type GolemSettings, policyFromSettings } from "../config/index.js";
import type { InferenceService } from "../interfaces/inference.js";
import { sliderPolicyForLevel } from "../interfaces/policy.js";
import type { SliderStore } from "../mcp/slider-store.js";
import { createGolemPipeline } from "../pipeline/index.js";
import { GolemProxy } from "../proxy/index.js";
import { recordPipelineEvent } from "../telemetry/index.js";
import type { TelemetryStore } from "../telemetry/types.js";

export interface ProxyBuild {
  readonly proxy: GolemProxy;
  /** Present only when `settings.compression.headroom_sidecar` is set (opt-in, slider ≥3). */
  readonly semantic?: HeadroomSidecar;
}

export interface BuildProxyOptions {
  /**
   * When present, the level is re-read from this store on EVERY request
   * instead of frozen at construction time — makes `golem_set_slider` /
   * `golem slider` double as the live per-task toggle (Decision 25).
   * `local_only_opt_in` always comes from the `settings` snapshot.
   */
  readonly sliderStore?: SliderStore;
  /** Local inference (Decision 25 Mode A/B). Absent disables both modes, fail-open. */
  readonly inference?: InferenceService;
}

/**
 * Build a `GolemProxy` wired to the A3 redaction→compression pipeline exactly
 * the way `golem proxy` wires it: `NativeLosslessCompression` rooted at `dir`,
 * the OPT-IN Headroom semantic sidecar when `compression.headroom_sidecar` is
 * set, and per-request `PipelineEvent`s recorded to `telemetry`. Does not
 * call `proxy.listen()` — the caller owns binding (port, ephemeral-for-tests,
 * etc.) and shutdown.
 */
export function buildProxyFromSettings(
  dir: string,
  settings: GolemSettings,
  telemetry: TelemetryStore,
  build: BuildProxyOptions = {},
): ProxyBuild {
  // OPT-IN semantic sidecar (Headroom) for slider ≥3 — off unless configured.
  // Started lazily on first ≥3 request; fails open so the proxy never depends on it.
  const semantic = settings.compression.headroom_sidecar ? new HeadroomSidecar() : undefined;
  const { sliderStore, inference } = build;
  const pipeline = createGolemPipeline({
    compression: NativeLosslessCompression.forProjectDir(dir),
    policy: async () => {
      if (sliderStore === undefined) return policyFromSettings(settings);
      const level = await sliderStore.get();
      return sliderPolicyForLevel(level, { localOnlyOptIn: settings.slider.local_only_opt_in });
    },
    projectId: dir,
    onEvent: (event) => {
      void recordPipelineEvent(telemetry, event, new Date().toISOString()).catch(() => {});
    },
    ...(semantic !== undefined ? { semantic } : {}),
    ...(inference !== undefined ? { inference } : {}),
  });
  const proxy = new GolemProxy({
    upstreamBaseUrl: settings.proxy.upstream_base_url,
    connectTimeoutMs: settings.proxy.connect_timeout_ms,
    headersTimeoutMs: settings.proxy.request_timeout_ms,
    bodyTimeoutMs: settings.proxy.request_timeout_ms,
    pipeline,
    onPipelineError: (err) => {
      process.stderr.write(
        `golem proxy: pipeline error — forwarded request unchanged (passthrough): ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    },
  });
  return semantic !== undefined ? { proxy, semantic } : { proxy };
}
