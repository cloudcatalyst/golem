/**
 * Extract program.ts into command modules + slimmed program.ts.
 * Each module gets a register(program) function with helpers inlined.
 * Run: node scripts/extract-commands.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, accessSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const CLI = join(ROOT, "src", "cli");
const SRC = join(ROOT, "src");
const OUT = join(CLI, "commands");
mkdirSync(OUT, { recursive: true });

const text = readFileSync(join(CLI, "program.ts"), "utf8");
const lines = text.split("\n");

function exists(p) { try { accessSync(p); return true; } catch { return false; } }

// Helper: resolve import path from commands/ dir
function imp(mod) {
  if (mod.startsWith("cli:")) return `../${mod.slice(4)}`;
  const ts = join(SRC, mod.replace(/\.js$/, ".ts"));
  return exists(ts) ? `../../${mod}` : `../${mod}`;
}

// Groups: 0-indexed [start, end). Boundary verified against original program.ts.
const GROUPS = [
  { id: "init-uninit", start: 219, end: 369 },
  { id: "wiki", start: 369, end: 555 },
  { id: "proxy", start: 699, end: 803 },
  { id: "mcp-serve", start: 803, end: 988 },
  { id: "status-update", start: 987, end: 1103 },
  { id: "slider-dials-stats", start: 1102, end: 1366 },
  { id: "bench", start: 1365, end: 1776 },
  { id: "checkpoint", start: 1775, end: 1992 },
  { id: "ext-models", start: 1991, end: 2085 },
  { id: "account", start: 2084, end: 2321 },
  { id: "note-dashboard-watch", start: 2320, end: 2452 },
  { id: "tasks", start: 2451, end: 2819 },
  { id: "autonomy", start: 2818, end: 2983 },
  { id: "prompt-guidance", start: 2982, end: 3140 },
  { id: "config", start: 3138, end: 3276 },
  { id: "local-ollama", start: 3275, end: 3618 },
];

// Symbol → module path mapping (from src/)
const MODS = {
  findProjectDir: "config/index.js", loadConfig: "cli:config/index.js", settingsFilePaths: "cli:config/index.js",
  InitError: "cli:init.js", InitReport: "cli:init.js", VERSION: "cli:index.js",
  resolveUpstreamDisplay: "providers/index.js", upstreamAssumesCaching: "providers/index.js",
  UPSTREAM_AUTH_SCHEMES: "providers/index.js", UPSTREAM_PROVIDERS: "providers/index.js",
  resolveEffectiveCompression: "compression/effective-level.js",
  createProbeRunner: "inference/index.js", detectCapability: "inference/index.js",
  embedModelFor: "inference/index.js", OllamaClient: "inference/index.js",
  OllamaInferenceService: "inference/index.js", OllamaNativeClient: "inference/index.js",
  resolveTierAvailability: "inference/index.js", roleWarning: "inference/index.js",
  HardwareTier: "interfaces/inference.js", Role: "interfaces/inference.js",
  InferenceService: "interfaces/inference.js", KnowledgeBase: "interfaces/knowledge.js",
  migrateSliderLevel: "interfaces/policy.js", SliderLevel: "interfaces/policy.js",
  openTelemetryStore: "telemetry/index.js", readTelemetryEvents: "telemetry/index.js",
  buildCostBenchmark: "telemetry/index.js", renderCostBenchmark: "telemetry/index.js",
  BenchWindow: "telemetry/index.js", ToolUsageStats: "telemetry/index.js",
  TelemetryEvent: "telemetry/index.js", ModelCatalog: "telemetry/index.js",
  loadModelCatalog: "telemetry/model-catalog.js", BUILTIN_MODEL_CATALOG: "telemetry/model-catalog.js",
  fetchModelCatalog: "telemetry/model-catalog.js", mergeCatalogs: "telemetry/model-catalog.js",
  writeModelCatalog: "telemetry/model-catalog.js",
  aggregateCacheStats: "telemetry/cache-report.js", renderCacheReport: "telemetry/cache-report.js",
  brevityReportRows: "telemetry/usage-report.js",
  createTask: "tasks/index.js", escalateTask: "tasks/index.js",
  FileTaskStore: "tasks/index.js", PlanTaskStore: "tasks/index.js",
  isResumable: "tasks/index.js", buildResumeArgv: "tasks/index.js",
  runQueueLocally: "tasks/index.js",
  checkForUpdate: "update/index.js", detectInstallMethod: "update/index.js",
  FileWikiStore: "wiki/index.js", FederatedWikiReader: "wiki/index.js",
  fetchRawPage: "knowledge/index.js", startDashboard: "dashboard/index.js",
  AUTONOMY_LEVEL_HELP: "autonomy/index.js", AUTONOMY_LEVELS: "autonomy/index.js",
  parseAutonomyLevel: "autonomy/index.js", readActionLog: "autonomy/index.js",
  readAutonomyState: "autonomy/index.js", setAutonomyGateEnabled: "autonomy/index.js",
  writeAutonomyLevel: "autonomy/index.js",
  appendExample: "prompt/index.js", readExamples: "prompt/index.js",
  readLastSuggestion: "prompt/index.js", translatePrompt: "prompt/index.js",
  writeLastSuggestion: "prompt/index.js",
  addEventHook: "hooks/index.js", removeEventHook: "hooks/index.js",
  GUIDANCE_FEATURES: "hooks/index.js", guidanceFeature: "hooks/index.js",
  guidanceRulePath: "hooks/index.js", removeGuidanceRule: "hooks/index.js",
  writeGuidanceRule: "hooks/index.js", GuidanceScope: "hooks/index.js",
  defaultRevalidate: "hooks/index.js", buildHookCommand: "hooks/index.js",
  collectControlSurface: "config/control-surface.js", SettingsScope: "config/write-setting.js",
  createCheckpoint: "checkpoint/index.js", listCheckpoints: "checkpoint/index.js",
  planRestore: "checkpoint/index.js", resolveCheckpoint: "checkpoint/index.js",
  restoreCheckpoint: "checkpoint/index.js", dropCheckpoint: "checkpoint/index.js",
  pruneCheckpoints: "checkpoint/index.js", DEFAULT_KEEP: "checkpoint/ledger.js",
  readContextLedger: "proxy/index.js",
  benchEdits: "tools/index.js", EDIT_CASES: "tools/index.js",
  isEditFormat: "tools/index.js", renderEditBench: "tools/index.js",
  golemToolCensus: "tools/index.js", renderToolBench: "tools/index.js",
  SHRINK_MODES: "tools/index.js", shrinkCatalog: "tools/index.js",
  isSchemaMode: "tools/index.js", isExternalMode: "tools/index.js",
  resolveCavemanShrink: "tools/index.js", compareCatalogs: "tools/index.js",
  SELECTION_CASES: "tools/index.js", ARGUMENT_CASES: "tools/index.js",
  extractFileFacts: "knowledge/index.js", hasParseError: "knowledge/index.js",
  RETRIEVAL_CASES: "knowledge/index.js", benchRepoMap: "knowledge/index.js",
  renderRepoMapBench: "knowledge/index.js", buildRepoMap: "knowledge/index.js",
  checkWiki: "cli:wiki.js", defaultUserWikiDir: "cli:wiki.js", golemWikiInit: "cli:wiki.js",
  resolveWikiDir: "cli:wiki.js", wikiSourcePrefix: "cli:wiki.js",
  defaultUserDir: "config/paths.js",
  distillOne: "cli:distill.js", pendingDrafts: "cli:distill.js", renderPendingDrafts: "cli:distill.js",
  synthesizeWeeklyReport: "cli:synthesize.js",
  listPendingPromotions: "cli:promote.js", renderPendingPromotions: "cli:promote.js",
  runPromote: "cli:promote.js", draftTargetRelPath: "cli:promote.js",
  portInUse: "cli:proxy-daemon.js", proxyStatus: "cli:proxy-daemon.js",
  removeProxyPid: "cli:proxy-daemon.js", startDetached: "cli:proxy-daemon.js",
  stopProxy: "cli:proxy-daemon.js", waitForPortFree: "cli:proxy-daemon.js",
  writeProxyPid: "cli:proxy-daemon.js", credentialEnvForProxy: "cli:proxy-daemon.js",
  buildProxyFromSettings: "cli:proxy-runtime.js",
  readProxyDesired: "cli:proxy-state.js", writeProxyDesired: "cli:proxy-state.js",
  ensureProjectIndexed: "cli:auto-index.js", resolvePersistedEmbedMode: "cli:auto-index.js",
  embedderSignature: "cli:auto-index.js", writeManifest: "cli:auto-index.js",
  buildKnowledgeStack: "cli:build-knowledge.js", ollamaHasModel: "cli:build-knowledge.js",
  mcpCompressionService: "cli:mcp-compression.js", statsSourceForCli: "cli:mcp-compression.js",
  golemInit: "cli:init.js", golemUninit: "cli:init.js",
  collectStatus: "cli:status.js", renderStatus: "cli:status.js",
  collectGolemState: "cli:statusline.js", parseSessionInput: "cli:statusline.js",
  renderStatusLine: "cli:statusline.js",
  golemDirExists: "cli:local-model.js",
  getSliderInfo: "cli:slider.js", SLIDER_LEVEL_NAMES: "cli:slider.js", setSliderLevel: "cli:slider.js",
  collectStats: "cli:stats.js", collectWindowedStats: "cli:stats.js",
  renderBrevityReport: "cli:stats.js", renderStats: "cli:stats.js",
  addAccount: "cli:accounts.js", collectAccounts: "cli:accounts.js",
  loginAccount: "cli:accounts.js", logoutAccount: "cli:accounts.js",
  removeAccount: "cli:accounts.js", renderAccounts: "cli:accounts.js",
  useAccount: "cli:accounts.js",
  getConfig: "cli:config.js", listConfig: "cli:config.js",
  renderConfigGet: "cli:config.js", renderConfigList: "cli:config.js",
  renderConfigSet: "cli:config.js", renderConfigUnset: "cli:config.js",
  setConfig: "cli:config.js", unsetConfig: "cli:config.js",
  collectDevices: "cli:devices.js", devicesJson: "cli:devices.js", renderDevices: "cli:devices.js",
  collectLocalModel: "cli:local-config.js", renderLocalCoderWrite: "cli:local-config.js",
  renderLocalModel: "cli:local-config.js", renderLocalUrlWrite: "cli:local-config.js",
  setLocalBaseUrl: "cli:local-config.js", setLocalCoderEnabled: "cli:local-config.js",
  appendNote: "cli:notes.js", listNotes: "cli:notes.js", renderNotes: "cli:notes.js",
  distillNoteCapture: "cli:distill-note.js",
  collectOllamaStatus: "cli:ollama.js", renderOllamaStatus: "cli:ollama.js",
  renderSetupResult: "cli:ollama.js", runOllamaSetup: "cli:ollama.js",
  SetupRefusedError: "cli:ollama.js",
  collectExt: "cli:ext.js", renderExt: "cli:ext.js",
  renderModelCatalog: "cli:models.js", renderRefreshResult: "cli:models.js",
  renderCheckpointList: "cli:checkpoint.js", confirmDestructive: "cli:checkpoint.js",
  renderRestorePlan: "cli:checkpoint.js", renderRestoreResult: "cli:checkpoint.js",
  renderPlanIndex: "cli:plan-index.js", renderPlanSummary: "cli:plan-index.js",
  splicePlanIndex: "cli:plan-index.js", groupPlanTasks: "cli:plan-index.js",
  findScopedTask: "cli:task.js", findTask: "cli:task.js",
  listScopedTasks: "cli:task.js", renderScopedTaskList: "cli:task.js",
  renderTask: "cli:task.js", spawnResume: "cli:task.js", storeForScope: "cli:task.js",
  buildTaskGrounding: "cli:task-grounding.js",
  runWatch: "cli:watch.js",
  collectSessionStateReport: "cli:session-report.js",
  renderContextLedger: "cli:context.js",
  collectControlSurface: "config/control-surface.js",
};

// Build import lines for a body
function importsFor(body) {
  const byMod = {};
  for (const [sym, mod] of Object.entries(MODS)) {
    if (body.includes(sym)) {
      (byMod[mod] = byMod[mod] || []).push(sym);
    }
  }
  // Always import findProjectDir (used by DEFAULT_DIR which the script adds)
  const out = ['import { Command } from "commander";', 'import { findProjectDir } from "../../config/index.js";'];
  for (const [mod, syms] of Object.entries(byMod)) {
    if (mod === "config/index.js") continue; // findProjectDir already imported
    out.push(`import { ${syms.join(", ")} } from "${imp(mod)}";`);
  }
  return out;
}

// Helper definitions (no template literals — use string concat to avoid escaping issues)
const HELPERS = {
  fail: [
    "function fail(err: unknown): never {",
    '  process.stderr.write("golem: " + (err instanceof Error ? err.message : String(err)) + "\\n");',
    "  process.exit(2);",
    "}",
  ].join("\n"),
  resolvePort: [
    "async function resolvePort(dir: string, portOpt?: string) {",
    '  const { loadConfig } = await import("../../config/index.js");',
    '  const { resolveUpstreamDisplay } = await import("../../providers/index.js");',
    '  const { settings } = await loadConfig({ projectDir: dir });',
    '  const port = portOpt === undefined ? settings.proxy.port : Number(portOpt);',
    '  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("invalid port");',
    '  return { port, upstream: resolveUpstreamDisplay(settings.proxy).baseUrl, sliderLevel: settings.slider.level };',
    "}",
  ].join("\n"),
  restartProxyDetached: [
    "async function restartProxyDetached(dir: string, portOpt?: string) {",
    '  const { writeProxyDesired, stopProxy, waitForPortFree, startDetached, credentialEnvForProxy } = await import("../proxy-daemon.js");',
    '  await writeProxyDesired(dir, "running", new Date().toISOString());',
    "  const { port, upstream } = await resolvePort(dir, portOpt);",
    "  await stopProxy(dir);",
    "  await waitForPortFree(port);",
    "  const credEnv = await credentialEnvForProxy(dir);",
    '  const pid = await startDetached(dir, port, process.argv[1] ?? "", credEnv);',
    '  if (pid === null) throw new Error("proxy did not come up");',
    "  return { pid, port, upstream };",
    "}",
  ].join("\n"),
  readStdin: [
    "async function readStdin() {",
    '  if (process.stdin.isTTY) return "";',
    "  const chunks = [];",
    "  for await (const c of process.stdin) chunks.push(c);",
    '  return Buffer.concat(chunks).toString("utf8");',
    "}",
  ].join("\n"),
  buildInferenceForDir: [
    "async function buildInferenceForDir(dir) {",
    "  try {",
    '    const { loadConfig } = await import("../../config/index.js");',
    '    const { createProbeRunner, detectCapability, OllamaClient, OllamaInferenceService } = await import("../../inference/index.js");',
    '    const { settings } = await loadConfig({ projectDir: dir });',
    "    const client = new OllamaClient({ baseUrl: settings.inference.ollama_base_url, requestTimeoutMs: settings.inference.request_timeout_ms });",
    "    const facts = await detectCapability(createProbeRunner());",
    "    return new OllamaInferenceService(client, facts);",
    "  } catch { return null; }",
    "}",
  ].join("\n"),
};

// Helpers per group
const GROUP_HELPERS = {
  "init-uninit": ["fail"],
  "wiki": ["fail"],
  "proxy": ["fail", "resolvePort", "restartProxyDetached"],
  "mcp-serve": ["fail"],
  "status-update": ["fail"],
  "slider-dials-stats": ["fail"],
  "bench": ["fail"],
  "checkpoint": ["fail"],
  "ext-models": ["fail"],
  "account": ["fail", "resolvePort", "restartProxyDetached", "readStdin"],
  "note-dashboard-watch": ["fail"],
  "tasks": ["fail", "buildInferenceForDir"],
  "autonomy": ["fail"],
  "prompt-guidance": ["fail", "buildInferenceForDir"],
  "config": ["fail"],
  "local-ollama": ["fail", "buildInferenceForDir", "readStdin"],
};

// Generate each module
for (const g of GROUPS) {
  const body = lines.slice(g.start, g.end).join("\n");
  const imports = importsFor(body);
  const helpers = (GROUP_HELPERS[g.id] || []).map(h => HELPERS[h]).filter(Boolean);

  const moduleText = [
    ...imports,
    "",
    "const DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();",
    "",
    ...helpers,
    "",
    "export default function register(program: Command): void {",
    body,
    "}",
    "",
  ].join("\n");

  writeFileSync(join(OUT, `${g.id}.ts`), moduleText, "utf8");
  console.log(`Wrote ${g.id}.ts`);
}

// Write slimmed program.ts
const regImports = GROUPS.map(g => {
  const sn = g.id.replace(/-/g, "_");
  return `import register_${sn} from "./commands/${g.id}.js";`;
}).join("\n");

const regCalls = GROUPS.map(g => {
  const sn = g.id.replace(/-/g, "_");
  return `register_${sn}(program);`;
}).join("\n");

const slimmed = [
  '/**',
  ' * Command registration only — action handler logic lives in src/cli/commands/.',
  ' * Extracted from a 3618-line file (R8.27).',
  ' */',
  'import { Command } from "commander";',
  'import { findProjectDir } from "../config/index.js";',
  'import { VERSION } from "../index.js";',
  'import { buildHookCommand, defaultRevalidate } from "../hooks/index.js";',
  'import { fetchRawPage } from "../knowledge/index.js";',
  'import { readProxyDesired, proxyStatus, startDetached } from "../proxy-daemon.js";',
  'import { loadConfig } from "../config/index.js";',
  '',
  'const DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();',
  '',
  'const program = new Command();',
  '',
  'program',
  '  .name("golem")',
  '  .description("Golem \\u2014 universal pre-LLM processing layer (golem.run)")',
  '  .version(VERSION);',
  '',
  'program.addHelpText("after",',
  '  \`\\nControl panel:\\n  golem                     open the interactive control panel\\n  golem --dir <path>        open it for another project\\n  golem --no-pet            hide the pet in the header\\n  golem --advanced          show advanced controls on open\`,',
  ');',
  '',
  regImports,
  '',
  regCalls,
  '',
  'program.addCommand(',
  '  buildHookCommand({',
  '    buildKnowledge: async (projectDir) => {',
  '      try { return (await import("./build-knowledge.js")).buildKnowledgeStack({ projectDir }).then(s => s.knowledge); } catch { return null; }',
  '    },',
  '    revalidate: defaultRevalidate,',
  '    revalidateEnabled: async (projectDir) => {',
  '      try { return (await loadConfig({ projectDir })).settings.knowledge.webcache_revalidate; } catch { return false; }',
  '    },',
  '    skeletonEnabled: async (projectDir) => {',
  '      try { return (await loadConfig({ projectDir })).settings.knowledge.read_skeleton_enabled; } catch { return true; }',
  '    },',
  '    fetchRaw: fetchRawPage,',
  '    fetchRawEnabled: async (projectDir) => {',
  '      try { return (await loadConfig({ projectDir })).settings.knowledge.webcache_fetch_raw; } catch { return true; }',
  '    },',
  '  }),',
  ');',
  '',
  'export async function runCli(argv: readonly string[] = process.argv): Promise<void> {',
  '  await program.parseAsync([...argv]);',
  '}',
].join("\n");

writeFileSync(join(CLI, "program.ts"), slimmed, "utf8");
console.log(`\nRewrote program.ts (${slimmed.split("\n").length} lines)`);