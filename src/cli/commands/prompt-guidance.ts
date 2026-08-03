import { Command } from "commander";
import { findProjectDir } from "../../config/index.js";

const DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();

function fail(err: unknown): never {
  process.stderr.write("golem: " + (err instanceof Error ? err.message : String(err)) + "\n");
  process.exit(2);
}
async function buildInferenceForDir(dir: string) {
  try {
    const { loadConfig } = await import("../../config/index.js");
    const { createProbeRunner, detectCapability, OllamaClient, OllamaInferenceService } = await import("../../inference/index.js");
    const { settings } = await loadConfig({ projectDir: dir });
    const client = new OllamaClient({ baseUrl: settings.inference.ollama_base_url, requestTimeoutMs: settings.inference.request_timeout_ms });
    const facts = await detectCapability(createProbeRunner());
    return new OllamaInferenceService(client, facts);
  } catch { return null; }
}

export default function register(program: Command): void {

}
