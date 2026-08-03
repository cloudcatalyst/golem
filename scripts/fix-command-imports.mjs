/**
 * Post-extraction fixer: corrects import paths in all command modules.
 * Run: node scripts/fix-command-imports.mjs (after scripts/extract-commands.mjs)
 */
import { readFileSync, writeFileSync, readdirSync, accessSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const DIR = join(ROOT, "src", "cli", "commands");
const CLI = join(ROOT, "src", "cli");

function exists(p) { try { accessSync(p); return true; } catch { return false; } }

// Map of module path from src/ -> correct relative path from commands/ dir
const SRC_PATHS = {
  "config/index.js": "../../config/index.js",
  "config/paths.js": "../../config/paths.js",
  "config/control-surface.js": "../../config/control-surface.js",
  "config/write-setting.js": "../../config/write-setting.js",
  "providers/index.js": "../../providers/index.js",
  "inference/index.js": "../../inference/index.js",
  "interfaces/inference.js": "../../interfaces/inference.js",
  "interfaces/policy.js": "../../interfaces/policy.js",
  "interfaces/knowledge.js": "../../interfaces/knowledge.js",
  "hooks/index.js": "../../hooks/index.js",
  "telemetry/index.js": "../../telemetry/index.js",
  "telemetry/cache-report.js": "../../telemetry/cache-report.js",
  "telemetry/usage-report.js": "../../telemetry/usage-report.js",
  "telemetry/model-catalog.js": "../../telemetry/model-catalog.js",
  "tasks/index.js": "../../tasks/index.js",
  "update/index.js": "../../update/index.js",
  "wiki/index.js": "../../wiki/index.js",
  "knowledge/index.js": "../../knowledge/index.js",
  "dashboard/index.js": "../../dashboard/index.js",
  "autonomy/index.js": "../../autonomy/index.js",
  "prompt/index.js": "../../prompt/index.js",
  "compression/effective-level.js": "../../compression/effective-level.js",
  "tools/index.js": "../../tools/index.js",
  "checkpoint/index.js": "../../checkpoint/index.js",
  "checkpoint/ledger.js": "../../checkpoint/ledger.js",
  "proxy/index.js": "../../proxy/index.js",
  "index.js": "../../index.js",
};

// Map of CLI module name -> correct relative path from commands/ dir
const CLI_PATHS = {
  "init.js": "../init.js",
  "status.js": "../status.js",
  "statusline.js": "../statusline.js",
  "local-model.js": "../local-model.js",
  "slider.js": "../slider.js",
  "stats.js": "../stats.js",
  "mcp-compression.js": "../mcp-compression.js",
  "dials.js": "../dials.js",
  "context.js": "../context.js",
  "config.js": "../config.js",
  "accounts.js": "../accounts.js",
  "ext.js": "../ext.js",
  "models.js": "../models.js",
  "notes.js": "../notes.js",
  "distill-note.js": "../distill-note.js",
  "watch.js": "../watch.js",
  "session-report.js": "../session-report.js",
  "task.js": "../task.js",
  "task-grounding.js": "../task-grounding.js",
  "plan-index.js": "../plan-index.js",
  "checkpoint.js": "../checkpoint.js",
  "local-config.js": "../local-config.js",
  "devices.js": "../devices.js",
  "ollama.js": "../ollama.js",
  "auto-index.js": "../auto-index.js",
  "build-knowledge.js": "../build-knowledge.js",
  "proxy-daemon.js": "../proxy-daemon.js",
  "proxy-runtime.js": "../proxy-runtime.js",
  "proxy-state.js": "../proxy-state.js",
  "distill.js": "../distill.js",
  "synthesize.js": "../synthesize.js",
  "promote.js": "../promote.js",
  "wiki.js": "../wiki.js",
  "raw-fetch.js": "../raw-fetch.js",
};

const files = readdirSync(DIR).filter(f => f.endsWith(".ts"));

for (const f of files) {
  const path = join(DIR, f);
  let text = readFileSync(path, "utf8");
  let changed = false;
  const lines = text.split("\n");
  const newLines = [];

  for (const line of lines) {
    const m = line.match(/from "([^"]+)"/);
    if (m) {
      const target = m[1];
      if (target.startsWith("node:") || !target.startsWith(".")) {
        newLines.push(line);
        continue;
      }
      // Resolve the path
      // paths like "../../X" -> check if it's a src/ or cli/ module
      if (target.startsWith("../../")) {
        const mod = target.slice("../../".length);
        // Check if it's a cli module (should be ../)
        if (CLI_PATHS[mod]) {
          newLines.push(line.replace(`"${target}"`, `"${CLI_PATHS[mod]}"`));
          changed = true;
          continue;
        }
        // Check if it's valid src path
        if (SRC_PATHS[mod]) {
          newLines.push(line);
          continue;
        }
        // Try to find the file
        const tsCheck = join(ROOT, "src", mod.replace(/\.js$/, ".ts"));
        if (exists(tsCheck)) {
          newLines.push(line);
          continue;
        }
        // Fallback: might be wrong path entirely
        console.log(`  ${f}: unknown src path ${target}`);
        newLines.push(line);
      } else if (target.startsWith("../")) {
        const mod = target.slice("../".length);
        // Check if it's a src module (should be ../../)
        if (SRC_PATHS[mod]) {
          newLines.push(line.replace(`"${target}"`, `"${SRC_PATHS[mod]}"`));
          changed = true;
          continue;
        }
        // Check if it's a valid cli module
        if (CLI_PATHS[mod]) {
          newLines.push(line);
          continue;
        }
        // Try to find the file
        const tsCheck = join(CLI, mod.replace(/\.js$/, ".ts"));
        if (exists(tsCheck)) {
          newLines.push(line);
          continue;
        }
        // Might be a type-only import that's wrong
        console.log(`  ${f}: unknown cli path ${target}`);
        newLines.push(line);
      } else {
        newLines.push(line);
      }
    } else {
      newLines.push(line);
    }
  }

  if (changed) {
    writeFileSync(path, newLines.join("\n"), "utf8");
    console.log(`Fixed ${f}`);
  }
}

// Fix program.ts paths
const progPath = join(CLI, "program.ts");
let progText = readFileSync(progPath, "utf8");
progText = progText.replace(/from "\.\.\/proxy-daemon\.js"/g, 'from "./proxy-daemon.js"');
progText = progText.replace(/from "\.\.\/proxy-state\.js"/g, 'from "./proxy-state.js"');
writeFileSync(progPath, progText, "utf8");
console.log("Fixed program.ts paths");

console.log("Done");