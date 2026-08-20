import { proxyStatus, startDetached, stopProxy } from "../cli/proxy-daemon.js";
import { proxyBaseUrl, readWiringState, type WiringState, wiringGap } from "../cli/proxy-wiring.js";
// costs ~530ms to load, and collecting the surface only needs to READ the level.
// `setSliderLevel` is imported lazily in applyRuntime. (verification-notes §86)
import { coerceCompressionLevel, compressionName } from "../interfaces/policy.js";
import {
  type ApplyControlOptions,
  type ApplyResult,
  COMPRESSION_CHOICES,
  type Control,
  type ControlGroup,
  ENV_LOCKED,
} from "./control-surface-types.js";
import { ConfigError } from "./errors.js";
import { loadConfig } from "./loader.js";
import { settingMeta } from "./ui-model.js";

/** Compression level, active account, and the proxy daemon. */
export async function runtimeControlGroup(shared: {
  projectDir: string;
  userDir?: string;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<ControlGroup> {
  const { settings, provenance } = await loadConfig(shared);
  const proxy = await proxyStatus(shared.projectDir, settings.proxy.port);

  // R11.1 / ADR-0004: the panel's headline runtime control is the compression
  // DIAL. It used to be the slider, whose value the two dials then followed —
  // two controls for one thing, on the one surface that shows them side by side.
  const compMeta = settingMeta("compression.level");
  const compEntry = provenance["compression.level"];
  const compLocked = compEntry?.layer === "env" ? ENV_LOCKED(compEntry.source) : undefined;
  const compressionControl: Control = {
    id: "runtime:compression",
    family: "runtime",
    label: compMeta?.label ?? "Compression",
    summary: compMeta?.summary ?? "",
    ...(compMeta?.detail !== undefined && { detail: compMeta.detail }),
    kind: "enum",
    value: String(settings.compression.level),
    options: COMPRESSION_CHOICES.map((level: string) => ({
      value: String(level),
      label: `${level} ${compressionName(coerceCompressionLevel(level))}`,
    })),
    layer: compEntry?.layer ?? "default",
    ...(compEntry?.source !== undefined && { source: compEntry.source }),
    // A dial is personal and transient: it writes local scope (Decision 43), so
    // it offers no scope choice.
    writableScopes: compLocked === undefined ? ["local"] : [],
    ...(compLocked !== undefined && { locked: compLocked }),
    ...(compMeta?.danger !== undefined && { danger: compMeta.danger }),
    // R11.1: the proxy re-reads the dials live, so setting this needs no restart.
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
    controls: [compressionControl, accountControl, proxyControl],
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
    case "compression": {
      // R11.1 / ADR-0004 — the panel writes the DIAL. It used to write the slider
      // through `setSliderLevel`, which imported cli/init.js because choosing a
      // level could ACTIVATE an uninitialized project; a dial write has no such
      // side effect, so this path no longer needs the ~530ms import (or the init
      // probe that made it testable).
      const { setDial } = await import("../cli/dials.js");
      const raw = typeof value === "string" ? value : String(value);
      const result = await setDial("compression", raw, shared);
      return {
        id: "runtime:compression",
        value: result.info.effective,
        message: `compression ${result.info.setting} (${result.info.label})`,
        file: result.file,
        ...(result.overriddenBy !== undefined && {
          overridden: `a higher layer wins — the effective value comes from ${result.overriddenBy.layer}`,
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
