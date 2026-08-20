/**
 * R10.24 — the one implementation of "switch which upstream serves this project",
 * shared by `golem gateway use` and `golem target use`.
 *
 * Both commands write the same single leaf (`inference.default_target`, via
 * {@link useGateway}) and both must apply it the same way: restart a running
 * proxy, or say plainly that a restart is needed. It lives here because the two
 * commands were about to hold two copies of that sequence, and a selector whose
 * two entry points drift is exactly how "I switched and nothing happened"
 * happens.
 *
 * The distinction between the two commands is only which ids they advertise:
 * `gateway use` names gateways, `target use` names targets (a gateway *and* one
 * of its models). The writer accepts either.
 */

import { loadConfig } from "../../config/index.js";
import { resolveUpstreamDisplay } from "../../providers/index.js";
import { collectGateways, credentialEnvForProxy, useGateway } from "../gateways.js";
import { InitError } from "../init.js";
import { portInUse, startDetached, stopProxy, waitForPortFree } from "../proxy-daemon.js";

/**
 * The port (and display upstream) this project's proxy uses. Moved here from
 * `commands/gateway.ts` in R10.24 so `gateway use` and `target use` cannot
 * resolve it two different ways.
 */
export async function resolvePort(
  dir: string,
  portOpt?: string,
): Promise<{ port: number; upstream: string; compression: string }> {
  const { settings } = await loadConfig({ projectDir: dir });
  const port = portOpt === undefined ? settings.proxy.port : Number(portOpt);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new InitError(`invalid port "${portOpt}"`);
  return {
    port,
    upstream: resolveUpstreamDisplay(settings.proxy).baseUrl,
    compression: settings.compression.level,
  };
}

/** Stop, wait for the port, and start a fresh detached proxy. */
export async function restartProxyDetached(
  dir: string,
  portOpt?: string,
): Promise<{ pid: number; port: number; upstream: string }> {
  const { port, upstream } = await resolvePort(dir, portOpt);
  await stopProxy(dir);
  await waitForPortFree(port);
  const credEnv = await credentialEnvForProxy(dir);
  const pid = await startDetached(dir, port, process.argv[1] ?? "", credEnv);
  if (pid === null) throw new InitError(`proxy did not come up on port ${port}`);
  return { pid, port, upstream };
}

/**
 * Select `id` (a gateway id, a target id, or null to clear back to the top-level
 * config) and apply it. Returns the line to print.
 */
export async function selectTarget(
  dir: string,
  id: string | null,
  opts: { readonly restart: boolean; readonly yes: boolean },
): Promise<string> {
  const { active } = await useGateway(dir, id, new Date().toISOString(), {
    assumeYes: opts.yes,
  });
  const report = await collectGateways(dir);
  // Name the MODEL when one is selected: "active: openrouter" is not an answer to
  // "which model am I talking to" when the gateway fronts several (R10.24).
  const selection = report.active_target ?? active;
  const label =
    active === null
      ? "active upstream cleared — using the top-level (default) config"
      : `active upstream: ${selection}`;
  const activeUrl = report.gateways.find((g) => g.active)?.base_url;
  const dest = activeUrl !== undefined ? ` -> ${activeUrl}` : "";
  const { port } = await resolvePort(dir);
  const running = await portInUse(port);
  if (opts.restart && running) {
    const { pid } = await restartProxyDetached(dir);
    return `${label} — proxy restarted (pid ${pid})${dest}\n`;
  }
  if (running) return `${label} (restart the proxy to apply: golem proxy restart)\n`;
  return `${label}.\n`;
}
