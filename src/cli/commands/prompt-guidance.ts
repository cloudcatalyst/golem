/**
 * golem prompt / guidance / hook — extracted from program.ts (R8.27).
 */

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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
  compactDir,
  compactDocument,
  readExamples,
  readLastSuggestion,
  renderCompactReport,
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
    .command("compact")
    .description(
      "P3a: propose a shorter CLAUDE.md (local model; code/paths/URLs byte-preserved; you review before it lands)",
    )
    .argument("[file]", "file to compact (default: CLAUDE.md in --dir)")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--role <role>", "local role: drafter (default) | summarizer | judge", "drafter")
    .option("--out <path>", "where to write the proposal (default .golem/compact/<name>)")
    .option("--apply", "replace the file with an ALREADY-REVIEWED proposal from a previous run")
    .option("--print", "also print the proposed text", false)
    .option("--json", "machine-readable output", false)
    .action(
      async (
        file: string | undefined,
        opts: {
          dir: string;
          role: string;
          out?: string;
          apply?: boolean;
          print: boolean;
          json: boolean;
        },
      ) => {
        try {
          const target = path.resolve(opts.dir, file ?? "CLAUDE.md");
          const proposalPath =
            opts.out !== undefined
              ? path.resolve(opts.dir, opts.out)
              : path.join(compactDir(opts.dir), path.basename(target));

          // `--apply` is the SECOND act, deliberately: it only ever copies a
          // proposal a human has had the chance to read, and it never rewrites.
          if (opts.apply === true) {
            let proposed: string;
            try {
              proposed = await readFile(proposalPath, "utf8");
            } catch {
              throw new InitError(
                `no reviewed proposal at ${proposalPath} — run \`golem prompt compact\` first, read the diff, then re-run with --apply`,
              );
            }
            const backup = `${proposalPath}.backup`;
            await writeFile(backup, await readFile(target, "utf8"), "utf8");
            await writeFile(target, proposed, "utf8");
            process.stdout.write(`applied: ${target}\nprevious version kept at: ${backup}\n`);
            return;
          }

          let original: string;
          try {
            original = await readFile(target, "utf8");
          } catch {
            throw new InitError(`cannot read ${target}`);
          }
          const roles = ["classifier", "drafter", "judge", "summarizer", "extractor"] as const;
          const role = opts.role as (typeof roles)[number];
          if (!roles.includes(role))
            throw new InitError(`invalid --role "${opts.role}" (expected ${roles.join(" | ")})`);

          const inference = await _buildInferenceForDir(opts.dir);
          if (inference === null) {
            process.stdout.write("local model unavailable — start Ollama, then retry.\n");
            return;
          }
          const result = await compactDocument(original, { inference, role });
          await mkdir(path.dirname(proposalPath), { recursive: true });
          await writeFile(proposalPath, result.compacted, "utf8");

          if (opts.json) {
            const { original: _o, ...rest } = result;
            process.stdout.write(`${JSON.stringify({ target, proposalPath, ...rest }, null, 2)}\n`);
            return;
          }
          process.stdout.write(renderCompactReport(result, target));
          if (opts.print) process.stdout.write(`\n${result.compacted}`);
          process.stdout.write(
            `\nproposal: ${proposalPath}\nreview:   git diff --no-index -- "${target}" "${proposalPath}"\napply:    golem prompt compact --apply\n\n— Golem never edits ${path.basename(target)} for you. Read the diff first: an instruction file shapes every future session.\n`,
          );
        } catch (err) {
          _fail(err);
        }
      },
    );

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
        // Decision 56: `bypass` is restored too. A project left with the
        // pipeline off is still WIRED to its port, so reopening it without the
        // shim would recreate the dead-socket defect this state exists to avoid.
        const desired = await readProxyDesired(cwd);
        if (desired !== "running" && desired !== "bypass") return;
        const { settings } = await loadConfig({ projectDir: cwd });
        if ((await proxyStatus(cwd, settings.proxy.port)).running) return;
        await startDetached(
          cwd,
          settings.proxy.port,
          process.argv[1] ?? "",
          {},
          desired === "bypass" ? { shim: true } : {},
        );
      } catch {
        /* fail-safe */
      }
    });

  program.addCommand(hookCmd);
}
