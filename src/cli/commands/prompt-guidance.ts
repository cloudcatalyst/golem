/**
 * golem prompt / guidance / hook — extracted from program.ts (R8.27).
 */

import { access } from "node:fs/promises";
import type { Command } from "commander";
import { findProjectDir, loadConfig } from "../../config/index.js";
import {
  buildHookCommand,
  defaultRevalidate,
  GUIDANCE_FEATURES,
  type GuidanceScope,
  guidanceFeature,
  guidanceRulePath,
  removeGuidanceRule,
  writeGuidanceRule,
} from "../../hooks/index.js";
import {
  createProbeRunner,
  detectCapability,
  OllamaClient,
  OllamaInferenceService,
} from "../../inference/index.js";
import { fetchRawPage } from "../../knowledge/index.js";
import {
  appendExample,
  readExamples,
  readLastSuggestion,
  translatePrompt,
  writeLastSuggestion,
} from "../../prompt/index.js";
import { buildKnowledgeStack } from "../build-knowledge.js";
import { InitError } from "../init.js";
import { proxyStatus, startDetached } from "../proxy-daemon.js";
import { readProxyDesired } from "../proxy-state.js";

const _DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();

function _fail(err: unknown): never {
  process.stderr.write(`golem: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(err instanceof InitError ? 2 : 1);
}

async function _buildInferenceForDir(dir: string) {
  try {
    const { settings } = await loadConfig({ projectDir: dir });
    const client = new OllamaClient({
      baseUrl: settings.inference.ollama_base_url,
      requestTimeoutMs: settings.inference.request_timeout_ms,
    });
    const facts = await detectCapability(createProbeRunner());
    return new OllamaInferenceService(client, facts);
  } catch {
    return null;
  }
}

const unknownFeature = (name: string): never => {
  process.stderr.write(
    `golem: no guidance feature "${name}" (try: ${GUIDANCE_FEATURES.map((x) => x.name).join(", ")})\n`,
  );
  process.exit(2);
};

const ruleFileExists = async (
  dir: string,
  name: string,
  scope: GuidanceScope,
): Promise<boolean> => {
  try {
    await access(guidanceRulePath(dir, name, scope));
    return true;
  } catch {
    return false;
  }
};

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

export default function register(program: Command): void {
  const promptCmd = program
    .command("prompt")
    .description("Prompt translation (spike): rewrite a raw note into a clearer prompt");

  promptCmd
    .command("translate")
    .description(
      "Suggest a clearer prompt for a raw note (local model; you decide whether to use it)",
    )
    .argument("<note...>", "the raw note to translate")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .action(async (note: string[], opts: { dir: string }) => {
      try {
        const inference = await _buildInferenceForDir(opts.dir);
        if (inference === null) {
          process.stdout.write("local model unavailable — start Ollama, then retry.\n");
          return;
        }
        const raw = note.join(" ");
        const examples = await readExamples(opts.dir);
        const result = await translatePrompt(raw, { inference, examples });
        if (result.translated === null) {
          process.stdout.write(`could not translate: ${result.error ?? "unknown error"}\n`);
          return;
        }
        await writeLastSuggestion(opts.dir, raw, result.translated);
        process.stdout.write(
          `suggested prompt (grounded in ${result.examplesUsed} accepted example(s)):\n\n${result.translated}\n\n— Golem never sends this. Copy it if you like it; run \`golem prompt accept\` to teach your style.\n`,
        );
      } catch (err) {
        _fail(err);
      }
    });

  promptCmd
    .command("accept")
    .description("Record the last suggested translation as an accepted style example")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .action(async (opts: { dir: string }) => {
      try {
        const last = await readLastSuggestion(opts.dir);
        if (last === null) {
          process.stdout.write("nothing to accept — run `golem prompt translate <note>` first.\n");
          return;
        }
        await appendExample(opts.dir, { ...last, ts: new Date().toISOString() });
        process.stdout.write("recorded — future translations will lean toward this style.\n");
      } catch (err) {
        _fail(err);
      }
    });

  const guidanceCmd = program
    .command("guidance")
    .description("Manage the Golem guidance rules that direct Claude to use features");

  guidanceCmd
    .command("list", { isDefault: true })
    .description("List guidance features and whether each is enabled for this project")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .action(async (opts: { dir: string }) => {
      process.stdout.write("Golem guidance features (.claude/rules/golem-<name>.md):\n\n");
      for (const g of GUIDANCE_FEATURES) {
        const project = await ruleFileExists(opts.dir, g.name, "project");
        const user = await ruleFileExists(opts.dir, g.name, "user");
        const state = project ? "on (project)" : user ? "on (user)" : "off";
        const tag = g.seededByDefault ? "default" : "opt-in ";
        process.stdout.write(`  [${tag}] ${g.name.padEnd(20)} ${state.padEnd(13)} ${g.summary}\n`);
      }
      process.stdout.write(
        "\nEnable:  golem guidance enable <name> [--user]\nDisable: golem guidance disable <name> [--user]\nShow:    golem guidance show <name>\n",
      );
    });

  guidanceCmd
    .command("show")
    .description("Print one guidance rule's body")
    .argument("<name>", `feature (${GUIDANCE_FEATURES.map((g) => g.name).join(", ")})`)
    .action((name: string) => {
      const g = guidanceFeature(name);
      if (g === null) unknownFeature(name);
      else process.stdout.write(`${g.snippet}\n`);
    });

  guidanceCmd
    .command("enable")
    .description("Write a guidance rule file so Claude uses this feature")
    .argument("<name>", "feature name")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option(
      "--user",
      "personal scope (gitignored .local.md) instead of committed project scope",
      false,
    )
    .action(async (name: string, opts: { dir: string; user: boolean }) => {
      try {
        const g = guidanceFeature(name);
        if (g === null) return unknownFeature(name);
        const scope: GuidanceScope = opts.user ? "user" : "project";
        const action = await writeGuidanceRule(opts.dir, g, scope);
        process.stdout.write(`${action.kind}: ${action.path} — ${action.detail}\n`);
        process.stdout.write("restart Claude Code (or reload) to pick up the rule.\n");
      } catch (err) {
        _fail(err);
      }
    });

  guidanceCmd
    .command("disable")
    .description("Remove a guidance rule file so Claude no longer uses this feature")
    .argument("<name>", "feature name")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option(
      "--user",
      "only remove the personal (.local.md) rule; default removes both scopes",
      false,
    )
    .action(async (name: string, opts: { dir: string; user: boolean }) => {
      try {
        if (guidanceFeature(name) === null) return unknownFeature(name);
        const action = await removeGuidanceRule(opts.dir, name, opts.user ? "user" : "both");
        process.stdout.write(
          action.kind === "skip"
            ? `${name} was not enabled — nothing to remove.\n`
            : `removed: ${action.path}\n`,
        );
      } catch (err) {
        _fail(err);
      }
    });

  // hook command group — built via buildHookCommand, registered as a subcommand
  const hookCmd = buildHookCommand({
    buildKnowledge: async (projectDir) => {
      try {
        return (await buildKnowledgeStack({ projectDir })).knowledge;
      } catch {
        return null;
      }
    },
    revalidate: defaultRevalidate,
    revalidateEnabled: async (projectDir) => {
      try {
        return (await loadConfig({ projectDir })).settings.knowledge.webcache_revalidate;
      } catch {
        return false;
      }
    },
    skeletonEnabled: async (projectDir) => {
      try {
        return (await loadConfig({ projectDir })).settings.knowledge.read_skeleton_enabled;
      } catch {
        return true;
      }
    },
    fetchRaw: fetchRawPage,
    fetchRawEnabled: async (projectDir) => {
      try {
        return (await loadConfig({ projectDir })).settings.knowledge.webcache_fetch_raw;
      } catch {
        return true;
      }
    },
  });

  hookCmd
    .command("session-start")
    .description("SessionStart handler: auto-start the proxy if it was running for this project")
    .action(async () => {
      try {
        let cwd = process.cwd();
        try {
          const j = JSON.parse(await readStdin()) as { cwd?: unknown };
          if (typeof j.cwd === "string" && j.cwd.length > 0) cwd = j.cwd;
        } catch {
          /* no/!json payload */
        }
        if ((await readProxyDesired(cwd)) !== "running") return;
        const { settings } = await loadConfig({ projectDir: cwd });
        if ((await proxyStatus(cwd, settings.proxy.port)).running) return;
        await startDetached(cwd, settings.proxy.port, process.argv[1] ?? "");
      } catch {
        /* fail-safe */
      }
    });

  program.addCommand(hookCmd);
}
