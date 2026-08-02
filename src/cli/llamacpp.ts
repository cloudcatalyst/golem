/**
 * R8.18 — `golem llamacpp models | setup | status | start | stop`.
 *
 * The second module in this codebase allowed to install software (spec Decision 26 gave
 * the first, `golem ollama setup`, its rules) and it inherits every one of them: it is
 * never invoked automatically, `golem init` must not import it, it asks before it fetches
 * anything, and Golem ships none of the bytes it downloads.
 *
 * What it adds beyond the Ollama precedent is **choice made visible**. There is no
 * default model here: `models` prints the ladder with each entry's fit against *this*
 * machine's free RAM, and `setup` refuses a combination that would swap rather than
 * discovering it at 2 tokens/sec. That is the "fit for purpose, fit for hardware" rule
 * from R8.18's brief, and it is why the selection — not the catalog — is the feature.
 *
 * `setup` ends by writing the `inference.providers` entry (R8.15) and reading `/props`
 * back, so a successful run leaves the local coder pointed at the model that is actually
 * loaded, with the context window the server actually has.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { loadConfig, writeSetting } from "../config/index.js";
import {
  checkDiskSpace,
  checkFit,
  contextForVram,
  createLlamacppDeps,
  defaultModelsDir,
  detectMachineFacts,
  ensureBinaries,
  ensureModelFiles,
  FLOOR_GGUF_MODEL_ID,
  findServerBinary,
  GGUF_CATALOG,
  type GgufModel,
  ggufModel,
  isProcessAlive,
  LLAMACPP_DEFAULT_PORT,
  LLAMACPP_RELEASE_TAG,
  type LlamacppDeps,
  llamacppInstallDir,
  type MachineFacts,
  type ModelChoice,
  type ModelPreference,
  modelBytes,
  planServer,
  rankModels,
  readLlamacppPid,
  readServerProps,
  resolveAsset,
  type ServerProps,
  startServer,
  stopServer,
} from "../inference/index.js";
import type { ProviderEntry } from "../inference/providers.js";
import type { Role } from "../interfaces/inference.js";

/** The provider id `setup` writes. Stable, so re-running replaces rather than duplicates. */
export const LLAMACPP_PROVIDER_ID = "llamacpp";

export class LlamacppRefusedError extends Error {}

export interface LlamacppCommandOptions {
  readonly projectDir: string;
  /** Test injection (forwarded to loadConfig). */
  readonly userDir?: string;
  readonly deps?: LlamacppDeps;
  readonly onLine?: (line: string) => void;
}

async function resolveContext(opts: LlamacppCommandOptions): Promise<{
  readonly projectDir: string;
  readonly deps: LlamacppDeps;
  readonly modelsDir: string;
  readonly port: number;
  readonly configuredModelId?: string;
}> {
  const projectDir = path.resolve(opts.projectDir);
  const { settings } = await loadConfig({
    projectDir,
    ...(opts.userDir !== undefined && { userDir: opts.userDir }),
  });
  const deps =
    opts.deps ??
    createLlamacppDeps({
      ...(opts.onLine !== undefined ? { onLine: opts.onLine } : {}),
      ...(opts.userDir !== undefined ? { userDir: opts.userDir } : {}),
    });
  const inference = settings.inference as typeof settings.inference & {
    readonly llamacpp_models_dir?: string;
    readonly llamacpp_model?: string;
    readonly llamacpp_port?: number;
  };
  return {
    projectDir,
    deps,
    modelsDir: inference.llamacpp_models_dir ?? defaultModelsDir(opts.userDir),
    port: inference.llamacpp_port ?? LLAMACPP_DEFAULT_PORT,
    ...(inference.llamacpp_model !== undefined
      ? { configuredModelId: inference.llamacpp_model }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// `golem llamacpp models` — the ladder, measured against this machine
// ---------------------------------------------------------------------------

export interface ModelRow {
  readonly id: string;
  readonly title: string;
  readonly quant: string;
  readonly downloadBytes: number;
  readonly residentBytes: number;
  readonly fits: boolean;
  readonly moe: boolean;
  readonly paramsB: number;
  readonly activeParamsB: number;
  readonly roles: readonly Role[];
  readonly proven: boolean;
  readonly note: string;
}

export interface ModelsReport {
  readonly facts: MachineFacts;
  readonly contextTokens: number;
  readonly usableRamBytes: number;
  readonly rows: readonly ModelRow[];
  /** What Golem would pick for the drafter role, or undefined when nothing fits. */
  readonly recommended?: ModelChoice;
  readonly modelsDir: string;
  readonly configuredModelId?: string;
}

const RAM_HEADROOM_FRACTION = 0.85;

export async function collectModels(
  opts: LlamacppCommandOptions & { readonly prefer?: ModelPreference },
): Promise<ModelsReport> {
  const ctx = await resolveContext(opts);
  const facts = await detectMachineFacts({ deps: ctx.deps, modelsDir: ctx.modelsDir });
  const contextTokens = contextForVram(facts.vramBytes);
  const usableRamBytes = Math.floor(facts.freeRamBytes * RAM_HEADROOM_FRACTION);

  const rows = GGUF_CATALOG.map((model): ModelRow => {
    const verdict = checkFit([model], facts, contextTokens);
    return {
      id: model.id,
      title: model.title,
      quant: model.quant,
      downloadBytes: modelBytes(model),
      residentBytes: verdict.requiredBytes,
      fits: verdict.fits,
      moe: model.moe,
      paramsB: model.paramsB,
      activeParamsB: model.activeParamsB,
      roles: model.roles,
      proven: model.proven,
      note: model.note,
    };
  });

  const recommended = rankModels({
    role: "drafter",
    usableRamBytes,
    contextTokens,
    ...(opts.prefer !== undefined ? { prefer: opts.prefer } : {}),
  })[0];

  return {
    facts,
    contextTokens,
    usableRamBytes,
    rows,
    ...(recommended !== undefined ? { recommended } : {}),
    modelsDir: ctx.modelsDir,
    ...(ctx.configuredModelId !== undefined ? { configuredModelId: ctx.configuredModelId } : {}),
  };
}

export function renderModels(report: ModelsReport, json: boolean): string {
  if (json) return `${JSON.stringify(report, null, 2)}\n`;
  const lines: string[] = [];
  lines.push(
    `This machine: ${gb(report.facts.totalRamBytes)} RAM (${gb(report.facts.freeRamBytes)} free, ` +
      `${gb(report.usableRamBytes)} usable), ${gb(report.facts.vramBytes)} VRAM, ` +
      `${gb(report.facts.freeDiskBytes)} free where models land.`,
  );
  lines.push(
    `Context window planned for this VRAM: ${report.contextTokens.toLocaleString("en-US")} tokens.`,
    "",
  );
  for (const row of report.rows) {
    const marks = [
      row.fits ? "fits" : "TOO BIG",
      row.moe ? `MoE ${row.paramsB}B/${row.activeParamsB}B active` : `dense ${row.paramsB}B`,
      `${gb(row.downloadBytes)} download`,
      `~${gb(row.residentBytes)} resident`,
      row.proven ? null : "unproven",
      row.id === report.configuredModelId ? "CONFIGURED" : null,
    ].filter((m): m is string => m !== null);
    lines.push(`${row.id}  [${marks.join(" · ")}]`);
    lines.push(`    ${row.title} — roles: ${row.roles.join(", ")}`);
    lines.push(`    ${row.note}`);
    lines.push("");
  }
  if (report.recommended === undefined) {
    lines.push(
      "No catalog model fits this machine's free RAM right now — that is a real answer, not",
      "a failure. Free memory and re-run, or name the floor model explicitly:",
      `  golem llamacpp setup --model ${FLOOR_GGUF_MODEL_ID}`,
    );
  } else {
    lines.push(`Recommended for drafting: ${report.recommended.model.id}`);
    lines.push(`  ${report.recommended.reason}`);
    lines.push("", `  golem llamacpp setup --model ${report.recommended.model.id}`);
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// `golem llamacpp status`
// ---------------------------------------------------------------------------

export interface LlamacppStatusReport {
  readonly installed: boolean;
  readonly installDir: string;
  readonly releaseTag: string;
  readonly backend: string;
  readonly running: boolean;
  readonly pid?: number;
  readonly port: number;
  readonly modelId?: string;
  readonly props?: ServerProps;
  readonly providerConfigured: boolean;
  readonly modelsDir: string;
}

export async function collectLlamacppStatus(
  opts: LlamacppCommandOptions,
): Promise<LlamacppStatusReport> {
  const ctx = await resolveContext(opts);
  const { settings } = await loadConfig({
    projectDir: ctx.projectDir,
    ...(opts.userDir !== undefined && { userDir: opts.userDir }),
  });
  const facts = await detectMachineFacts({ deps: ctx.deps, modelsDir: ctx.modelsDir });
  const asset = resolveAsset(facts);
  const installDir = llamacppInstallDir(LLAMACPP_RELEASE_TAG, opts.userDir);
  const serverPath = await findServerBinary(installDir, ctx.deps.platform);
  const pidInfo = await readLlamacppPid(opts.userDir);
  const alive = pidInfo !== null && isProcessAlive(pidInfo.pid);
  const port = pidInfo?.port ?? ctx.port;
  const props = alive
    ? await readServerProps({ deps: ctx.deps, baseUrl: `http://127.0.0.1:${port}` })
    : null;

  return {
    installed: serverPath !== null,
    installDir,
    releaseTag: LLAMACPP_RELEASE_TAG,
    backend: asset.backend,
    running: alive && props !== null,
    ...(pidInfo !== null ? { pid: pidInfo.pid } : {}),
    port,
    ...(pidInfo?.modelId !== undefined && pidInfo.modelId !== ""
      ? { modelId: pidInfo.modelId }
      : ctx.configuredModelId !== undefined
        ? { modelId: ctx.configuredModelId }
        : {}),
    ...(props !== null ? { props } : {}),
    providerConfigured:
      settings.inference.providers?.some((p) => p.id === LLAMACPP_PROVIDER_ID) === true,
    modelsDir: ctx.modelsDir,
  };
}

export function renderLlamacppStatus(report: LlamacppStatusReport, json: boolean): string {
  if (json) return `${JSON.stringify(report, null, 2)}\n`;
  const lines: string[] = [];
  lines.push(
    `llama.cpp ${report.releaseTag} (${report.backend}): ` +
      `${report.installed ? `installed at ${report.installDir}` : "not installed"}`,
  );
  if (report.running) {
    lines.push(
      `Server: running (pid ${report.pid}) on port ${report.port}` +
        `${report.modelId !== undefined ? `, model ${report.modelId}` : ""}`,
    );
    if (report.props !== undefined) {
      lines.push(
        report.props.contextWindow === undefined
          ? "Live context window from /props: not reported by this build"
          : `Live context window from /props: ${report.props.contextWindow.toLocaleString("en-US")} tokens`,
      );
    }
  } else if (report.pid !== undefined) {
    lines.push(
      `Server: recorded pid ${report.pid} is not answering — stale. Run \`golem llamacpp start\`.`,
    );
  } else {
    lines.push("Server: not running");
  }
  lines.push(`Models directory: ${report.modelsDir}`);
  lines.push(
    `inference.providers entry "${LLAMACPP_PROVIDER_ID}": ` +
      `${report.providerConfigured ? "present" : "absent — roles still resolve from the Ollama tier catalog"}`,
  );
  if (!report.installed) {
    lines.push("", "Run `golem llamacpp models` to see what fits, then `golem llamacpp setup`.");
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// `golem llamacpp setup`
// ---------------------------------------------------------------------------

export interface SetupOutcome {
  readonly kind: "cancelled" | "completed" | "refused";
  readonly model?: GgufModel;
  readonly downloadedBytes?: number;
  readonly serverPath?: string;
  readonly pid?: number;
  readonly port?: number;
  readonly props?: ServerProps | null;
  readonly providerWritten?: boolean;
  readonly logPath?: string;
  readonly problem?: string;
  readonly rationale?: string;
}

export interface LlamacppSetupOptions extends LlamacppCommandOptions {
  readonly yes: boolean;
  /** Catalog id. Omitted means "recommend one for this machine". */
  readonly modelId?: string;
  readonly prefer?: ModelPreference;
  readonly modelsDir?: string;
  readonly port?: number;
  readonly contextTokens?: number;
  /** Fetch and install only — do not start the server. */
  readonly noStart?: boolean;
  /** Skip the speculative-decoding draft model (saves ~1 GB). */
  readonly noDraft?: boolean;
  readonly isTTY?: boolean;
  readonly confirm?: (question: string) => Promise<boolean>;
  /** How long to wait for the first (slow) model load. */
  readonly waitMs?: number;
  readonly scope?: "user" | "project";
}

async function defaultConfirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}

/**
 * Nothing-to-a-running-server, in one consented command.
 *
 * Ordered so the cheap refusals happen before the expensive work: pick the model, prove
 * it fits *free* RAM, prove the download fits the target volume, and only then ask for
 * consent — because a prompt the user cannot act on is worse than no prompt.
 */
export async function runLlamacppSetup(opts: LlamacppSetupOptions): Promise<SetupOutcome> {
  const ctx = await resolveContext(opts);
  const modelsDir = opts.modelsDir ?? ctx.modelsDir;
  const port = opts.port ?? ctx.port;
  const deps = ctx.deps;

  const facts = await detectMachineFacts({ deps, modelsDir });
  const contextTokens = opts.contextTokens ?? contextForVram(facts.vramBytes);
  const usableRamBytes = Math.floor(facts.freeRamBytes * RAM_HEADROOM_FRACTION);

  // 1. Which model? A named id is honoured even when unproven — the user asked for it.
  let model: GgufModel | undefined;
  if (opts.modelId !== undefined) {
    model = ggufModel(opts.modelId);
    if (model === undefined) {
      return {
        kind: "refused",
        problem:
          `no catalog model with id "${opts.modelId}". Run \`golem llamacpp models\` for the ` +
          `list (ids are stable), or add your own \`inference.providers\` entry by hand.`,
      };
    }
  } else {
    const choice = rankModels({
      role: "drafter",
      usableRamBytes,
      contextTokens,
      ...(opts.prefer !== undefined ? { prefer: opts.prefer } : {}),
    })[0];
    if (choice === undefined) {
      return {
        kind: "refused",
        problem:
          `no catalog model fits ${gb(usableRamBytes)} of usable RAM at a ` +
          `${contextTokens.toLocaleString("en-US")}-token context. That is the honest answer: ` +
          `loading something that swaps is slower than not loading it. Free memory, lower ` +
          `--context, or name the floor model (\`--model ${FLOOR_GGUF_MODEL_ID}\`).`,
      };
    }
    model = choice.model;
    deps.onLine(`Selected ${model.id} — ${choice.reason}`);
  }

  // 2. Does it fit RAM? Reported with arithmetic either way.
  const fit = checkFit([model], facts, contextTokens);
  deps.onLine(fit.explanation);
  if (!fit.fits) {
    return { kind: "refused", problem: fit.explanation };
  }

  // 3. Does it fit the disk it is going to?
  const asset = resolveAsset(facts);
  const disk = checkDiskSpace(fit.downloadBytes, facts);
  deps.onLine(disk.explanation);
  if (!disk.fits) return { kind: "refused", problem: disk.explanation };

  // 4. Consent, with the whole bill named.
  if (!opts.yes) {
    const isTTY = opts.isTTY ?? process.stdin.isTTY === true;
    if (!isTTY) {
      throw new LlamacppRefusedError(
        "stdin is not a TTY — re-run with --yes to download " +
          `llama.cpp ${LLAMACPP_RELEASE_TAG} (${asset.backend}) and ${gb(fit.downloadBytes)} of ` +
          `model weights non-interactively`,
      );
    }
    const accepted = await (opts.confirm ?? defaultConfirm)(
      `This downloads llama.cpp ${LLAMACPP_RELEASE_TAG} (${asset.backend}) from GitHub and ` +
        `${gb(fit.downloadBytes)} of ${model.title} weights from Hugging Face into ${modelsDir}, ` +
        `verifying the sha256 of every file. Nothing else is installed. Continue?`,
    );
    if (!accepted) return { kind: "cancelled" };
  }

  // 5. Binaries, then weights. Both resumable, both verified, both skipped if present.
  const binaries = await ensureBinaries({ deps, facts });
  const files = await ensureModelFiles({
    deps,
    model,
    modelsDir,
    ...(opts.noDraft === true ? { skipKinds: ["draft"] as const } : {}),
  });
  const downloadedBytes = binaries.downloadedBytes + files.downloadedBytes;

  // Record the choice BEFORE starting: the weights on disk are the expensive state, and
  // a server that fails to start must still leave `golem llamacpp start` able to find
  // them. Writing this only on success would throw away 20 GB of context on a bad flag.
  await persistChoice(opts, { modelId: model.id, modelsDir, port });

  if (opts.noStart === true) {
    return {
      kind: "completed",
      model,
      downloadedBytes,
      serverPath: binaries.serverPath,
      providerWritten: false,
    };
  }

  // 6. Start it, then believe the server rather than the plan.
  const plan = planServer({
    command: binaries.serverPath,
    model,
    filePaths: files.filePaths,
    facts,
    port,
    contextTokens,
    alias: model.id,
  });
  deps.onLine(plan.rationale);
  const started = await startServer({
    deps,
    plan,
    modelId: model.id,
    ...(opts.waitMs !== undefined ? { waitMs: opts.waitMs } : {}),
  });

  const providerWritten = await writeProviderEntry({
    projectDir: ctx.projectDir,
    ...(opts.userDir !== undefined ? { userDir: opts.userDir } : {}),
    scope: opts.scope ?? "user",
    modelId: model.id,
    port,
    ...(started.props?.contextWindow !== undefined
      ? { contextWindow: started.props.contextWindow }
      : {}),
    roles: model.roles,
  });

  return {
    kind: "completed",
    model,
    downloadedBytes,
    serverPath: binaries.serverPath,
    pid: started.pid,
    port,
    props: started.props,
    providerWritten,
    logPath: started.logPath,
    rationale: plan.rationale,
  };
}

/** Remember the choice so `start`/`status` do not have to be told it again. */
async function persistChoice(
  opts: LlamacppSetupOptions,
  choice: { readonly modelId: string; readonly modelsDir: string; readonly port: number },
): Promise<void> {
  const scope = opts.scope ?? "user";
  const write = {
    projectDir: opts.projectDir,
    ...(opts.userDir !== undefined ? { userDir: opts.userDir } : {}),
  };
  await writeSetting(scope, "inference.llamacpp_model", choice.modelId, write);
  await writeSetting(scope, "inference.llamacpp_models_dir", choice.modelsDir, write);
  await writeSetting(scope, "inference.llamacpp_port", choice.port, write);
}

/**
 * Write the `inference.providers` entry for the running server.
 *
 * Replaces any existing `llamacpp` entry rather than merging into it — the same
 * whole-replacement rule R8.15 chose for the user override file, so a re-run cannot
 * leave half of a previous model's claims behind. The context window comes from
 * `/props` and is omitted when the server did not answer, because an invented window is
 * worse than an unknown one.
 */
export async function writeProviderEntry(opts: {
  readonly projectDir: string;
  readonly userDir?: string;
  readonly scope: "user" | "project";
  readonly modelId: string;
  readonly port: number;
  readonly contextWindow?: number;
  readonly roles: readonly Role[];
}): Promise<boolean> {
  const { settings } = await loadConfig({
    projectDir: opts.projectDir,
    ...(opts.userDir !== undefined && { userDir: opts.userDir }),
  });
  const entry: ProviderEntry = {
    id: LLAMACPP_PROVIDER_ID,
    api: "openai-completions",
    base_url: `http://127.0.0.1:${opts.port}/v1`,
    models: [
      {
        id: opts.modelId,
        roles: opts.roles,
        ...(opts.contextWindow !== undefined && opts.contextWindow > 0
          ? { context_window: opts.contextWindow }
          : {}),
      },
    ],
  };
  const others = (settings.inference.providers ?? []).filter((p) => p.id !== LLAMACPP_PROVIDER_ID);
  await writeSetting(opts.scope, "inference.providers", [...others, entry], {
    projectDir: opts.projectDir,
    ...(opts.userDir !== undefined ? { userDir: opts.userDir } : {}),
  });
  return true;
}

export function renderSetupOutcome(outcome: SetupOutcome): string {
  if (outcome.kind === "cancelled") {
    return "Cancelled — nothing was downloaded, installed or started.\n";
  }
  if (outcome.kind === "refused") {
    return `golem: ${outcome.problem ?? "setup refused"}\n`;
  }
  const lines: string[] = [];
  lines.push(
    `Installed llama.cpp ${LLAMACPP_RELEASE_TAG} and ${outcome.model?.title ?? "the model"}` +
      `${outcome.downloadedBytes === 0 ? " (everything was already present)" : ` — ${gb(outcome.downloadedBytes ?? 0)} downloaded`}.`,
  );
  if (outcome.pid === undefined) {
    lines.push("Server not started (--no-start). Start it with `golem llamacpp start`.");
    return `${lines.join("\n")}\n`;
  }
  lines.push(`Server: pid ${outcome.pid} on port ${outcome.port}.`);
  if (outcome.props === null || outcome.props === undefined) {
    lines.push(
      "The server did not answer /props before the wait expired. A first load of a large",
      `model can take several minutes — check the log (${outcome.logPath ?? "see ~/.golem/llamacpp/logs"})`,
      "and then `golem llamacpp status`.",
    );
  } else {
    lines.push(
      outcome.props.contextWindow === undefined
        ? "The server answered /props but reported no context window — check the log."
        : `Live context window: ${outcome.props.contextWindow.toLocaleString("en-US")} tokens (read from /props).`,
    );
    lines.push(
      `Wrote the "${LLAMACPP_PROVIDER_ID}" inference.providers entry — the local coder now ` +
        `resolves to ${outcome.model?.id ?? "this model"}.`,
    );
    lines.push("", "Verify with: golem devices    and    golem local status");
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// `golem llamacpp start` / `stop`
// ---------------------------------------------------------------------------

export interface StartOutcome {
  readonly kind: "started" | "already-running" | "refused";
  readonly pid?: number;
  readonly port?: number;
  readonly props?: ServerProps | null;
  readonly problem?: string;
  readonly logPath?: string;
  readonly rationale?: string;
}

export async function runLlamacppStart(
  opts: LlamacppCommandOptions & {
    readonly modelId?: string;
    readonly port?: number;
    readonly contextTokens?: number;
    readonly waitMs?: number;
  },
): Promise<StartOutcome> {
  const ctx = await resolveContext(opts);
  const deps = ctx.deps;
  const port = opts.port ?? ctx.port;

  const existing = await readLlamacppPid(opts.userDir);
  if (existing !== null && isProcessAlive(existing.pid)) {
    const props = await readServerProps({ deps, baseUrl: `http://127.0.0.1:${existing.port}` });
    return { kind: "already-running", pid: existing.pid, port: existing.port, props };
  }

  const modelId = opts.modelId ?? ctx.configuredModelId;
  if (modelId === undefined) {
    return {
      kind: "refused",
      problem:
        "no model configured. Run `golem llamacpp setup` (it records the choice), or pass " +
        "`--model <id>` — `golem llamacpp models` lists the ids.",
    };
  }
  const model = ggufModel(modelId);
  if (model === undefined) {
    return { kind: "refused", problem: `no catalog model with id "${modelId}"` };
  }

  const facts = await detectMachineFacts({ deps, modelsDir: ctx.modelsDir });
  const installDir = llamacppInstallDir(LLAMACPP_RELEASE_TAG, opts.userDir);
  const serverPath = await findServerBinary(installDir, deps.platform);
  if (serverPath === null) {
    return {
      kind: "refused",
      problem: `no llama-server under ${installDir} — run \`golem llamacpp setup\` first.`,
    };
  }

  // Files must already be on disk: `start` never downloads. A missing file is a clear
  // refusal pointing at `setup`, not a surprise 20 GB fetch from a lifecycle command.
  const filePaths: Record<string, string> = {};
  for (const file of model.files) {
    filePaths[file.path] = path.join(ctx.modelsDir, ...model.repo.split("/"), file.path);
  }
  const weights = model.files.find((f) => f.kind === "weights");
  if (weights !== undefined) {
    const weightsPath = filePaths[weights.path];
    if (weightsPath === undefined || !existsSync(weightsPath)) {
      return {
        kind: "refused",
        problem:
          `${weights.path} is not under ${ctx.modelsDir}. Run \`golem llamacpp setup --model ` +
          `${model.id}\` to fetch it (downloads resume, so an interrupted attempt continues).`,
      };
    }
    // Optional companions that were skipped at setup must not be passed to the server.
    for (const file of model.files) {
      const p = filePaths[file.path];
      if (file.kind !== "weights" && (p === undefined || !existsSync(p)))
        delete filePaths[file.path];
    }
  }

  const plan = planServer({
    command: serverPath,
    model,
    filePaths,
    facts,
    port,
    ...(opts.contextTokens !== undefined ? { contextTokens: opts.contextTokens } : {}),
    alias: model.id,
  });
  deps.onLine(plan.rationale);
  const started = await startServer({
    deps,
    plan,
    modelId: model.id,
    ...(opts.waitMs !== undefined ? { waitMs: opts.waitMs } : {}),
  });
  return {
    kind: "started",
    pid: started.pid,
    port: started.port,
    props: started.props,
    logPath: started.logPath,
    rationale: plan.rationale,
  };
}

export function renderStartOutcome(outcome: StartOutcome): string {
  switch (outcome.kind) {
    case "already-running":
      return (
        `llama-server is already running (pid ${outcome.pid}) on port ${outcome.port}` +
        `${outcome.props?.contextWindow !== undefined ? `, context ${outcome.props.contextWindow.toLocaleString("en-US")}` : ""}.\n`
      );
    case "refused":
      return `golem: ${outcome.problem ?? "could not start"}\n`;
    default:
      return outcome.props === null || outcome.props === undefined
        ? `Started llama-server (pid ${outcome.pid}) on port ${outcome.port}, but it has not answered ` +
            `/props yet — a first load takes minutes. Log: ${outcome.logPath ?? ""}\n`
        : `Started llama-server (pid ${outcome.pid}) on port ${outcome.port}, context ` +
            `${outcome.props.contextWindow?.toLocaleString("en-US") ?? "unreported"} tokens.\n`;
  }
}

export async function runLlamacppStop(opts: LlamacppCommandOptions): Promise<number | null> {
  return await stopServer(opts.userDir);
}

function gb(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}
