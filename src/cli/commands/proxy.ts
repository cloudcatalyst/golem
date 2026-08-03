import { Command } from "commander";
import { findProjectDir } from "../../config/index.js";

const DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();

function fail(err: unknown): never {
  process.stderr.write("golem: " + (err instanceof Error ? err.message : String(err)) + "\n");
  process.exit(2);
}
async function resolvePort(dir: string, portOpt?: string) {
  const { loadConfig } = await import("../../config/index.js");
  const { resolveUpstreamDisplay } = await import("../../providers/index.js");
  const { settings } = await loadConfig({ projectDir: dir });
  const port = portOpt === undefined ? settings.proxy.port : Number(portOpt);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("invalid port");
  return { port, upstream: resolveUpstreamDisplay(settings.proxy).baseUrl, sliderLevel: settings.slider.level };
}
async function restartProxyDetached(dir: string, portOpt?: string) {
  const { stopProxy, waitForPortFree, startDetached } = await import("../proxy-daemon.js");
  const { writeProxyDesired } = await import("../proxy-state.js");
  const { credentialEnvForProxy } = await import("../accounts.js");
  await writeProxyDesired(dir, "running", new Date().toISOString());
  const { port, upstream } = await resolvePort(dir, portOpt);
  await stopProxy(dir);
  await waitForPortFree(port);
  const credEnv = await credentialEnvForProxy(dir);
  const pid = await startDetached(dir, port, process.argv[1] ?? "", credEnv);
  if (pid === null) throw new Error("proxy did not come up");
  return { pid, port, upstream };
}

export default function register(program: Command): void {

}
