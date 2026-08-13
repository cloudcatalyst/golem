import { proxyStatus, startDetached, stopProxy } from "../cli/proxy-daemon.js";
import { proxyBaseUrl, readWiringState, type WiringState, wiringGap } from "../cli/proxy-wiring.js";
// `./slider-read.js`, not `./slider.js`: the write path imports cli/init.js and
// costs ~530ms to load, and collecting the surface only needs to READ the level.
// `setSliderLevel` is imported lazily in applyRuntime. (verification-notes §86)
import { getSliderInfo, SLIDER_LEVEL_NAMES } from "../cli/slider-read.js";
import { migrateSliderLevel } from "../interfaces/policy.js";
import {
  type ApplyControlOptions,
  type ApplyResult,
  type Control,
  type ControlGroup,
  coerceLevel,
  ENV_LOCKED,
  SLIDER_LEVELS,
} from "./control-surface-types.js";
import { ConfigError } from "./errors.js";
import { loadConfig } from "./loader.js";
import { settingMeta } from "./ui-model.js";

/** Slider level, active account, and the proxy daemon. */
export async function runtimeControlGroup(shared: {
  projectDir: string;
  userDir?: string;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<ControlGroup> {
  const [slider, { settings, provenance }] = await Promise.all([
    getSliderInfo(shared),
    loadConfig(shared),
  ]);
  const proxy = await proxyStatus(shared.projectDir, settings.proxy.port);

  const sliderMeta = settingMeta("slider.level");
  const sliderLocked = slider.layer === "env" ? ENV_LOCKED(slider.source) : undefined;
  const sliderControl: Control = {
    id: "runtime:slider",
    family: "runtime",
    label: sliderMeta?.label ?? "Savings level",
    summary: sliderMeta?.summary ?? "",
    ...(sliderMeta?.detail !== undefined && { detail: sliderMeta.detail }),
    kind: "enum",
    value: String(slider.level),
    options: SLIDER_LEVELS.map((level) => ({
      value: String(level),
      label: `${level} ${SLIDER_LEVEL_NAMES[level]}`,
    })),
    layer: slider.layer,
    ...(slider.source !== undefined && { source: slider.source }),
    // The slider is a personal, transient dial: it always writes local scope
    // (Decision 43), so it offers no scope choice.
    writableScopes: sliderLocked === undefined ? ["local"] : [],
    ...(sliderLocked !== undefined && { locked: sliderLocked }),
    ...(sliderMeta?.danger !== undefined && { danger: sliderMeta.danger }),
    restart: "proxy",
    advanced: false,
  };

  // Accounts: the synthetic default (clears default_target) plus each registered
  // gateway. Credentials are never read here — `useAccount` does the preflight.
  const registered = settings.proxy.gateways ?? [];
  const defaultId = settings.proxy.upstream_provider;
  const accountEntry = provenance["inference.default_target"];
  const accountLocked = accountEntry?.layer === "env" ? ENV_LOCKED(accountEntry.source) : undefined;
  const accountControl: Control = {
    id: "runtime:account",
    family: "runtime",
    label: "Active gateway",
    summary: "Which upstream gateway the proxy fronts",
    detail:
      "Switching runs a credential preflight and restarts a running proxy. Credentials live " +
      "in the OS store — add gateways with `golem gateway add` / `golem gateway login`.",
    kind: "enum",
    value: settings.inference.default_target ?? defaultId,
    options: [
      { value: defaultId, label: `${defaultId} (default upstream config)` },
      ...registered.map((g) => ({ value: g.id, label: `${g.id} (${g.provider})` })),
    ],
    layer: accountEntry?.layer ?? "default",
    ...(accountEntry?.source !== undefined && { source: accountEntry.source }),
    writableScopes: accountLocked === undefined ? ["project", "local", "user"] : [],
    ...(accountLocked !== undefined && { locked: accountLocked }),
    restart: "proxy",
    advanced: false,
  };

  // R8.32: "running" described the daemon, not the product. A proxy nothing is
  // wired to serves no traffic, so the toggle read `running` while redaction,
  // compression and telemetry were all being bypassed. Same read the CLI does.
  const wiring = await readWiringState(shared.projectDir, proxyBaseUrl(settings.proxy.port)).catch(
    (): WiringState => ({ owner: "none", baseUrl: null }),
  );
  const gap = proxy.running ? wiringGap(wiring, proxyBaseUrl(settings.proxy.port)) : null;
  const proxyControl: Control = {
    id: "runtime:proxy",
    family: "runtime",
    label: "Proxy daemon",
    summary: proxy.running
      ? `${gap === null ? "running" : "running but NOT in the request path"} on port ${proxy.port ?? settings.proxy.port}${proxy.pid !== undefined ? ` (pid ${proxy.pid})` : ""}`
      : `not running (port ${settings.proxy.port})`,
    detail:
      "Claude Code talks to this local proxy. Starting it detaches the daemon; stopping it " +
      "sends traffic nowhere until it is started again." +
      (gap === null ? "" : `\n\n⚠ ${gap.problem}${gap.remedy === null ? "" : ` ${gap.remedy}`}`),
    kind: "toggle",
    value: proxy.running,
    layer: "runtime",
    writableScopes: ["runtime"],
    advanced: false,
  };

  return {
    id: "runtime",
    title: "Runtime",
    summary: "Live state — not stored settings",
    tab: "runtime",
    controls: [sliderControl, accountControl, proxyControl],
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------
/**
 * Runtime controls decide their own storage (the slider always writes local
 * scope per Decision 43; the account writes project scope; the proxy writes
 * nothing), so the caller's `scope` is deliberately ignored here.
 */
export async function applyRuntime(
  name: string,
  value: unknown,
  _scope: string,
  options: ApplyControlOptions,
  shared: {
    projectDir: string;
    userDir?: string;
    env?: Readonly<Record<string, string | undefined>>;
  },
): Promise<ApplyResult> {
  switch (name) {
    case "slider": {
      const level = migrateSliderLevel(coerceLevel(value));
      // Lazy: the write path imports cli/init.js (it can activate a project on the
      // first level choice), which is exactly the ~530ms this module avoids paying
      // just to display a level.
      const { setSliderLevel } = await import("../cli/slider.js");
      // Forward the init probe: on an uninitialized project this call ACTIVATES it,
      // and `golemInit`'s default probe reads the developer's HOME (`~/.claude`).
      // Without a way to inject one, this path could not be tested anywhere Claude
      // Code is absent — which is every CI runner.
      const result = await setSliderLevel(level, {
        ...shared,
        ...(options.initProbe !== undefined && { probe: options.initProbe }),
      });
      return {
        id: "runtime:slider",
        value: String(result.effective.level),
        message:
          `slider level ${result.effective.level} (${result.effective.name})` +
          (result.justInitialized === true ? " — project initialized" : ""),
        file: result.file,
        ...(result.overriddenBy !== undefined && {
          overridden: `a higher layer wins — effective level is ${result.overriddenBy.level} from ${result.overriddenBy.layer}`,
        }),
      };
    }
    case "account": {
      const { settings } = await loadConfig(shared);
      const raw = typeof value === "string" ? value : String(value);
      // The synthetic default id and "none" both clear `inference.default_target`.
      const target =
        raw === "none" || raw === "" || raw === settings.proxy.upstream_provider ? null : raw;
      const result = await switchAccount(shared.projectDir, target, options);
      return {
        id: "runtime:account",
        value: result.active ?? settings.proxy.upstream_provider,
        message:
          result.active === null
            ? `switched to the default upstream config (${settings.proxy.upstream_provider})`
            : `switched to account ${result.active}`,
        restartHint: "a running proxy was restarted onto the new upstream",
      };
    }
    case "proxy": {
      const { settings } = await loadConfig(shared);
      if (value === true) {
        const script = options.cliPath;
        if (script === undefined || script === "") {
          throw new ConfigError(
            "cannot start the proxy: no CLI path available (start it with `golem proxy`)",
            { key: "runtime:proxy" },
          );
        }
        const pid = await startDetached(shared.projectDir, settings.proxy.port, script);
        if (pid === null) {
          throw new ConfigError(
            `the proxy did not come up on port ${settings.proxy.port} — run \`golem proxy\` to see why`,
            { key: "runtime:proxy" },
          );
        }
        return {
          id: "runtime:proxy",
          value: true,
          message: `proxy started on port ${settings.proxy.port} (pid ${pid})`,
        };
      }
      const stopped = await stopProxy(shared.projectDir);
      return {
        id: "runtime:proxy",
        value: false,
        message: stopped === null ? "proxy was not running" : `proxy stopped (pid ${stopped})`,
      };
    }
    default:
      throw new ConfigError(`unknown runtime control "${name}"`, { key: name });
  }
}
/**
 * `useGateway` lives in cli/gateways.ts, which pulls in the credential stores.
 * Imported lazily so merely *rendering* the panel never loads them (and so the
 * OS keychain is only consulted when a gateway is actually switched).
 *
 * Named `switchAccount`, not `useGatewayLazy`: a `use`-prefixed function trips
 * Biome's react/useHookAtTopLevel rule, which this file (now that the repo
 * compiles JSX) is checked by.
 */
export async function switchAccount(
  projectDir: string,
  id: string | null,
  options: ApplyControlOptions,
): Promise<{ readonly active: string | null }> {
  const { useGateway } = await import("../cli/gateways.js");
  return useGateway(projectDir, id, options.nowIso ?? new Date().toISOString(), {
    ...(options.assumeYes !== undefined && { assumeYes: options.assumeYes }),
    ...(options.env !== undefined && { env: options.env }),
  });
}
