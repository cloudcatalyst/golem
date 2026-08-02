/**
 * R8.18 — a curated table of GGUF models, and the function that picks one **for this
 * machine and this job**.
 *
 * The point is not the table, it is the selection. Golem runs on whatever a developer
 * already has, so "the local model" cannot be one model: a 64 GB workstation and a
 * 16 GB laptop want different weights for the same request, and a throwaway
 * classification wants different weights from an agent that will run for an hour.
 * `selectModel` is therefore the entry point and `DEFAULT_*` is only a floor.
 *
 * **Active parameters, not file size, set the speed.** A mixture-of-experts model with
 * 3B active runs faster than a dense 14B while knowing far more, because
 * `--n-cpu-moe` keeps the experts in RAM and only attention touches the GPU. So the
 * ladder below is not sorted by bytes — a 19 GB MoE outranks an 8 GB dense model on a
 * machine with the RAM to hold it. Sorting a model catalog by download size is the
 * intuitive mistake this whole module exists to avoid.
 *
 * Deliberately **short**, for the reason little-coder gives for keeping its own
 * `models.json` short: community fine-tunes get re-uploaded, renamed and deleted
 * constantly, so a catalog that chases them breaks. Only stable publishers appear here
 * (`ggml-org`, `Qwen`, `unsloth`). Anything else is the user's own
 * `inference.providers` entry (R8.15), which no Golem release can invalidate.
 *
 * Every byte count is **recorded from the live repo on 2026-08-01**
 * (verification-notes §113), never estimated: these numbers decide whether a model
 * fits, and a guessed size would make "this fits" a fabricated fact of exactly the
 * kind `availability.ts` exists to prevent.
 *
 * Golem ships none of these bytes (Decision 53) — this is a list of names, sizes and
 * URLs, and fetching one is a separate, consented act.
 */

import type { Role } from "../interfaces/inference.js";

/**
 * llama.cpp's `--spec-type` — *how* a draft file is used for speculative decoding.
 *
 * Not cosmetic and not optional: passing an MTP head to `--model-draft` while the type
 * defaults to simple drafting **segfaults the server at load** (§114). Only the values
 * Golem has verified are listed; `--spec-type` accepts more (`draft-eagle3`,
 * `draft-dflash`, the `ngram-*` family) and each needs its own verification before a
 * catalog entry may claim it.
 */
export type SpecDraftType = "draft-mtp";

/** One downloadable file within a model entry. */
export interface GgufFile {
  /** Path within the Hugging Face repo. */
  readonly path: string;
  readonly bytes: number;
  /**
   * `weights` is the model. `draft` is a speculative-decoding draft model (Qwen's
   * MTP), which buys tokens/sec for ~1 GB. `mmproj` is the vision projector — without
   * it the model is text-only and rejects images with a 4xx.
   */
  readonly kind: "weights" | "draft" | "mmproj";
  /**
   * For `kind: "draft"`, the `--spec-type` that knows how to use this file. **A draft
   * file without one is downloaded but never passed to the server**, because the
   * failure mode of guessing is a crash rather than a warning.
   */
  readonly specType?: SpecDraftType;
}

/** What a caller is optimising for. The "fit for purpose" half. */
export type ModelPreference = "speed" | "balanced" | "quality";

export interface GgufModel {
  /** Stable Golem-side id, used on the CLI and as the provider model id. */
  readonly id: string;
  readonly title: string;
  /** Hugging Face repo, `owner/name`. */
  readonly repo: string;
  readonly quant: string;
  readonly files: readonly GgufFile[];
  /**
   * Mixture-of-experts. The load-bearing property on consumer hardware: with
   * `--n-cpu-moe` the experts live in RAM and only attention needs VRAM, so an MoE
   * runs well on a GPU far too small to hold it. A dense model of the same size
   * cannot do this and will be slower, not faster.
   */
  readonly moe: boolean;
  /** Total parameters (B) — the rough capability proxy. */
  readonly paramsB: number;
  /** Parameters active per token (B) — what actually sets the speed. */
  readonly activeParamsB: number;
  /** Roles this model is a sensible choice for. */
  readonly roles: readonly Role[];
  readonly licence: string;
  /**
   * Whether Golem is willing to *recommend* this entry automatically.
   *
   * `false` means listed-but-not-recommended: reachable by naming its id, never
   * returned by {@link rankModels} unless `includeUnproven` is set. This is the
   * §89/§100 discipline applied to model choice — an entry whose note says "a
   * measurement to run, not a default to assume" must not be able to win a default
   * by scoring well on a proxy. Unproven entries exist so the trade is *visible*,
   * not so it is taken silently.
   */
  readonly proven: boolean;
  /** One line on when to pick it — and, where relevant, when not to. */
  readonly note: string;
}

/**
 * How much of a model's nominal capability survives its quantisation.
 *
 * Rough, published-consensus figures, not measurements — which is exactly why they
 * only ever *rank* candidates and never appear in output as though they were facts.
 * The shape that matters: Q4 is the standard working point and costs little, while
 * 2-bit quants fall off a cliff, and they fall hardest on code, where one wrong token
 * is a syntax error rather than a slightly worse sentence.
 */
function quantFactor(quant: string): number {
  const q = quant.toUpperCase();
  if (q.includes("BF16") || q.includes("F16") || q.startsWith("Q8")) return 1.0;
  if (q.startsWith("Q6")) return 0.97;
  if (q.startsWith("Q5")) return 0.95;
  if (q.startsWith("Q4") || q.includes("IQ4") || q.includes("MXFP4")) return 0.92;
  if (q.startsWith("Q3") || q.includes("IQ3")) return 0.78;
  if (q.startsWith("Q2") || q.includes("IQ2")) return 0.5;
  if (q.includes("IQ1")) return 0.3;
  return 0.9;
}

/** Nominal parameters discounted by quantisation damage — the capability proxy. */
export function effectiveParamsB(model: GgufModel): number {
  return model.paramsB * quantFactor(model.quant);
}

const GB = 1024 ** 3;
const gb = (n: number) => Math.round(n * GB);

/**
 * The ladder. `ggml-org` conversions are preferred where they exist: same organisation
 * as llama.cpp, so the GGUF and the server that loads it move together.
 */
export const GGUF_CATALOG: readonly GgufModel[] = Object.freeze([
  {
    id: "qwen3-1.7b-q4",
    title: "Qwen3-1.7B (Q4_K_M)",
    repo: "ggml-org/Qwen3-1.7B-GGUF",
    quant: "Q4_K_M",
    files: [{ path: "Qwen3-1.7B-Q4_K_M.gguf", bytes: gb(1.19), kind: "weights" }],
    moe: false,
    paramsB: 1.7,
    activeParamsB: 1.7,
    roles: ["classifier", "extractor", "summarizer"],
    licence: "Apache-2.0",
    proven: true,
    note:
      "The floor: runs on anything, including CPU-only. Fine for triage, tagging and " +
      "digests — the high-frequency roles where waiting on a big model is the actual " +
      "cost. Not for drafting code.",
  },
  {
    id: "qwen3-14b-q4",
    title: "Qwen3-14B (Q4_K_M)",
    repo: "ggml-org/Qwen3-14B-GGUF",
    quant: "Q4_K_M",
    files: [{ path: "Qwen3-14B-Q4_K_M.gguf", bytes: gb(8.38), kind: "weights" }],
    moe: false,
    paramsB: 14,
    activeParamsB: 14,
    roles: ["drafter", "judge", "summarizer", "extractor", "classifier"],
    licence: "Apache-2.0",
    proven: true,
    note:
      "Dense, so all 14B are active per token — usable on a 16 GB machine that cannot " +
      "hold an MoE. If you have the RAM for the 35B-A3B, prefer it: more capable AND " +
      "faster, because only 3B are active.",
  },
  {
    id: "qwen3.6-27b-q4",
    title: "Qwen3.6-27B (Q4_K_M)",
    repo: "ggml-org/Qwen3.6-27B-GGUF",
    quant: "Q4_K_M",
    files: [
      { path: "Qwen3.6-27B-Q4_K_M.gguf", bytes: gb(17.78), kind: "weights" },
      { path: "mtp-Qwen3.6-27B-Q4_0.gguf", bytes: gb(1.56), kind: "draft", specType: "draft-mtp" },
    ],
    moe: false,
    paramsB: 27,
    activeParamsB: 27,
    roles: ["drafter", "judge"],
    licence: "Apache-2.0",
    proven: true,
    note:
      "The dense sibling of the 35B-A3B. Slightly smaller on disk and markedly slower " +
      "per token, because dense means all 27B are active. Choose it over the MoE only " +
      "if a specific evaluation says so.",
  },
  {
    id: "qwen3.6-35b-a3b-q4",
    title: "Qwen3.6-35B-A3B (Q4_K_M)",
    repo: "ggml-org/Qwen3.6-35B-A3B-GGUF",
    quant: "Q4_K_M",
    files: [
      { path: "Qwen3.6-35B-A3B-Q4_K_M.gguf", bytes: gb(19.02), kind: "weights" },
      {
        path: "mtp-Qwen3.6-35B-A3B-Q4_0.gguf",
        bytes: gb(0.99),
        kind: "draft",
        specType: "draft-mtp",
      },
    ],
    moe: true,
    paramsB: 35,
    activeParamsB: 3,
    roles: ["drafter", "judge", "summarizer", "extractor", "classifier"],
    licence: "Apache-2.0",
    proven: true,
    note:
      "The sweet spot on a machine with ~24 GB of free RAM and any GPU: 35B of " +
      "knowledge at 3B of cost per token. This is the family little-coder measured at " +
      "78.67% on Aider Polyglot, on 8 GB of laptop VRAM.",
  },
  {
    id: "qwen3.6-35b-a3b-q4-vision",
    title: "Qwen3.6-35B-A3B (Q4_K_M, vision)",
    repo: "ggml-org/Qwen3.6-35B-A3B-GGUF",
    quant: "Q4_K_M",
    files: [
      { path: "Qwen3.6-35B-A3B-Q4_K_M.gguf", bytes: gb(19.02), kind: "weights" },
      {
        path: "mtp-Qwen3.6-35B-A3B-Q4_0.gguf",
        bytes: gb(0.99),
        kind: "draft",
        specType: "draft-mtp",
      },
      { path: "mmproj-Qwen3.6-35B-A3B-Q8_0.gguf", bytes: gb(0.57), kind: "mmproj" },
    ],
    moe: true,
    paramsB: 35,
    activeParamsB: 3,
    roles: ["drafter", "judge", "summarizer", "extractor", "classifier"],
    licence: "Apache-2.0",
    proven: true,
    note: "As above plus the vision projector, so attached screenshots can be read.",
  },
  {
    id: "qwen3.6-35b-a3b-q8",
    title: "Qwen3.6-35B-A3B (Q8_0)",
    repo: "ggml-org/Qwen3.6-35B-A3B-GGUF",
    quant: "Q8_0",
    files: [
      { path: "Qwen3.6-35B-A3B-Q8_0.gguf", bytes: gb(34.37), kind: "weights" },
      {
        path: "mtp-Qwen3.6-35B-A3B-Q8_0.gguf",
        bytes: gb(1.85),
        kind: "draft",
        specType: "draft-mtp",
      },
    ],
    moe: true,
    paramsB: 35,
    activeParamsB: 3,
    roles: ["drafter", "judge"],
    licence: "Apache-2.0",
    proven: true,
    note:
      "Same model, less quantisation damage, ~1.8× the RAM. MoE experts stream from " +
      "RAM, so expect fewer tokens/sec than Q4 — worth it when work is pre-planned and " +
      "latency is not the constraint.",
  },
  {
    id: "qwen3-coder-next-iq2m",
    title: "Qwen3-Coder-Next (UD-IQ2_M)",
    repo: "unsloth/Qwen3-Coder-Next-GGUF",
    quant: "UD-IQ2_M",
    files: [{ path: "Qwen3-Coder-Next-UD-IQ2_M.gguf", bytes: gb(23.25), kind: "weights" }],
    moe: true,
    paramsB: 80,
    activeParamsB: 3,
    roles: ["drafter"],
    licence: "Apache-2.0",
    proven: false,
    note:
      "The code-specific line, at the only quant that leaves room for a second model " +
      "on 64 GB — its Q4_K_M is 45.20 GB. IQ2 is a real quality loss on code, so this " +
      "is a measurement to run, not a default to assume.",
  },
  {
    id: "qwen2.5-coder-32b-q4",
    title: "Qwen2.5-Coder-32B-Instruct (Q4_K_M)",
    repo: "Qwen/Qwen2.5-Coder-32B-Instruct-GGUF",
    quant: "Q4_K_M",
    files: [
      {
        path: "qwen2.5-coder-32b-instruct-q4_k_m-00001-of-00005.gguf",
        bytes: gb(19.85),
        kind: "weights",
      },
    ],
    moe: false,
    paramsB: 32,
    activeParamsB: 32,
    roles: ["drafter"],
    licence: "Apache-2.0",
    proven: false,
    note:
      "Official and code-tuned, but DENSE: on a small GPU it is slower than the 35B " +
      "MoE despite being smaller on disk. Listed so the trade is visible, not because " +
      "it is recommended.",
  },
]);

/** Look up a catalog entry by id. */
export function ggufModel(id: string): GgufModel | undefined {
  return GGUF_CATALOG.find((m) => m.id === id);
}

/** Total bytes an entry will download. */
export function modelBytes(model: GgufModel): number {
  return model.files.reduce((sum, f) => sum + f.bytes, 0);
}

/**
 * Resident RAM a model needs once loaded, as a working **estimate**.
 *
 * Weights plus a KV-cache allowance — not a precise figure, and labelled an estimate
 * everywhere it surfaces. The draft model is resident too; the projector is not
 * counted, being loaded per image rather than held for the session.
 */
export function estimatedResidentBytes(model: GgufModel, contextTokens: number): number {
  const weights = model.files
    .filter((f) => f.kind !== "mmproj")
    .reduce((sum, f) => sum + f.bytes, 0);
  return weights + estimatedKvBytes(contextTokens);
}

/**
 * KV-cache bytes for a context window, as a deliberately generous **estimate**.
 *
 * Per *token*, not per thousand — that distinction is the whole point. The cache is
 * `2 (K+V) × layers × kv_heads × head_dim × 2 bytes`, which for a grouped-query model
 * of this class lands in the tens of KiB **for every single token**. 64 KiB/token
 * puts a 32K window near 2 GB and a 128K window near 8 GB, which is the right order
 * of magnitude and errs high.
 *
 * Erring high is deliberate and asymmetric: an over-estimate costs a user a smaller
 * quant than they strictly needed, while an under-estimate lets a model load and then
 * swap, which is far slower than the model they would otherwise have run.
 */
export function estimatedKvBytes(contextTokens: number): number {
  return contextTokens * 64 * 1024;
}

/**
 * The floor — what Golem falls back to when nothing else fits. Small enough to run
 * essentially anywhere, and named as a floor rather than a default so nobody reads it
 * as a recommendation.
 */
export const FLOOR_GGUF_MODEL_ID = "qwen3-1.7b-q4";

export interface SelectionRequest {
  readonly role: Role;
  /** RAM the model may actually claim, after the caller's headroom. */
  readonly usableRamBytes: number;
  /** Context window to budget the KV cache against. */
  readonly contextTokens: number;
  /** What to optimise for. Default `balanced`. */
  readonly prefer?: ModelPreference;
  /** Require a vision projector. */
  readonly needsVision?: boolean;
  /**
   * Include entries marked `proven: false`. Off by default: an unmeasured entry may
   * be *chosen* by name but must never *win* a recommendation on a proxy score.
   */
  readonly includeUnproven?: boolean;
}

export interface ModelChoice {
  readonly model: GgufModel;
  readonly residentBytes: number;
  /** Why this one won, in a line a human can check. */
  readonly reason: string;
}

/**
 * Rank the models that fit, best first.
 *
 * Scoring is intentionally simple and legible, because a recommendation nobody can
 * check is worse than a slightly worse recommendation they can:
 *
 * - **speed** — fewest active parameters wins; ties break toward more total knowledge.
 * - **quality** — most total parameters wins; ties break toward fewer active.
 * - **balanced** — knowledge per unit of active cost (`paramsB / activeParamsB`),
 *   which is precisely the property that makes an MoE worth its disk footprint.
 *
 * Returns every fitting candidate, so a caller can show the runners-up rather than
 * presenting one answer as though there were no trade.
 */
export function rankModels(req: SelectionRequest): readonly ModelChoice[] {
  const prefer = req.prefer ?? "balanced";
  const candidates: ModelChoice[] = [];

  for (const model of GGUF_CATALOG) {
    if (!model.roles.includes(req.role)) continue;
    if (!model.proven && req.includeUnproven !== true) continue;
    if (req.needsVision === true && !model.files.some((f) => f.kind === "mmproj")) continue;
    const residentBytes = estimatedResidentBytes(model, req.contextTokens);
    if (residentBytes > req.usableRamBytes) continue;
    candidates.push({ model, residentBytes, reason: "" });
  }

  // Capability is always the quant-discounted figure: an 80B at 2-bit is not 80B of
  // anything, and ranking on nominal size would hand every default to whichever entry
  // was quantised hardest enough to fit.
  const score = (m: GgufModel): number => {
    const capability = effectiveParamsB(m);
    switch (prefer) {
      case "speed":
        return -m.activeParamsB * 1000 + capability;
      case "quality":
        return capability * 1000 - m.activeParamsB;
      default:
        return (capability / m.activeParamsB) * 1000 + capability;
    }
  };

  candidates.sort((a, b) => score(b.model) - score(a.model));

  return candidates.map((c) => ({
    ...c,
    reason: explain(c.model, prefer, c.residentBytes, req),
  }));
}

function explain(
  model: GgufModel,
  prefer: ModelPreference,
  residentBytes: number,
  req: SelectionRequest,
): string {
  const resident = `${(residentBytes / GB).toFixed(1)} GB resident of ${(req.usableRamBytes / GB).toFixed(1)} GB usable`;
  const damage =
    effectiveParamsB(model) < model.paramsB * 0.9
      ? `, and ${model.quant} discounts that capability materially`
      : "";
  const shape = model.moe
    ? `${model.paramsB}B total but only ${model.activeParamsB}B active per token (MoE)${damage}`
    : `${model.paramsB}B, all active per token (dense)${damage}`;
  const why =
    prefer === "speed"
      ? "fewest active parameters for the role"
      : prefer === "quality"
        ? "most total parameters that still fits"
        : "best knowledge-per-active-parameter that fits";
  return `${model.title}: ${shape}; ${resident}. Chosen for ${why}.`;
}

/**
 * The single best model for a role, or `undefined` when nothing fits.
 *
 * `undefined` is a real answer and callers must handle it: on a machine with too
 * little free RAM, "no local model is appropriate right now" is the honest report, and
 * loading something that will swap is not a kindness.
 */
export function selectModel(req: SelectionRequest): ModelChoice | undefined {
  return rankModels(req)[0];
}

/** A Hugging Face resolve URL for one file. Public repos only; no token is ever sent. */
export function huggingFaceUrl(model: GgufModel, file: GgufFile): string {
  return `https://huggingface.co/${model.repo}/resolve/main/${file.path}?download=true`;
}
