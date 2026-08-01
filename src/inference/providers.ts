/**
 * R8.15 — the provider table: which local model serves which role, as data the
 * user owns.
 *
 * Spec §169 decided the direction years before this file existed — *"Ollama-first
 * behind an OpenAI-compatible interface … llama.cpp server / LM Studio / vLLM is a
 * drop-in swap via config."* The **transport** honoured it (`ollama-client.ts` is
 * plain `/v1/chat/completions`), but role→model selection did not: `catalog.ts` is a
 * frozen table of Ollama-namespaced tags keyed by hardware tier, with no override
 * anywhere. Point `ollama_base_url` at a llama.cpp server and Golem asks it for
 * `qwen2.5-coder:7b`, which is not what it loaded.
 *
 * This module is the missing layer, and it is deliberately **pure data plus pure
 * resolution** — the same reason `catalog.ts` says it is "a plain data table so it is
 * trivial to edit without touching routing logic". No I/O, no clock, no config
 * reads; callers pass what they resolved.
 *
 * **The frozen contract is untouched.** `InferenceService.chat(role, …)` still takes
 * a `Role` and callers still never name a model (`src/interfaces/inference.ts`).
 * What changes is how a role becomes a model, one layer below the interface.
 *
 * Four rules, in the order they matter:
 *
 * 1. **Empty is indistinguishable from absent.** No providers → the tier catalog
 *    over Ollama, exactly as before. An opt-in data feature whose empty state
 *    changed behaviour would be a regression dressed as a feature.
 * 2. **Declaration order decides**, not last-wins, so the resolution of any role is
 *    explicable by reading the file downwards.
 * 3. **A model that claims nothing is a catch-all** for chat roles — the llama.cpp
 *    reality is one server with one loaded GGUF, and making that case spell out five
 *    roles would be the most verbose configuration of the most common setup. An
 *    explicit claim anywhere still beats a catch-all everywhere.
 * 4. **Never invent a fact.** An undeclared context window is `undefined`, not a
 *    guess; a chat catch-all is never routed an embedding request. Same honesty
 *    discipline as `availability.ts`'s three states.
 */

import type { HardwareTier, Role } from "../interfaces/inference.js";
import { chatModelFor, embedModelFor } from "./catalog.js";

/**
 * How Golem talks to a provider.
 *
 * Both speak the OpenAI-compatible chat/embeddings protocol — that is the whole
 * point of §169 — so this does **not** select a transport. It selects the *native*
 * surface used for everything the OpenAI protocol does not cover: Ollama exposes
 * `/api/tags` and `ollama pull`, llama.cpp exposes `/v1/models` and `/props`. Get
 * this wrong and Golem prints `ollama pull …` advice at a server that cannot use it.
 */
export type ProviderApi = "openai-completions" | "ollama";

/** Which embedding kind(s) a model serves. */
export type EmbedKind = "text" | "code" | "both";

/** One model a provider serves, and what it is for. */
export interface ProviderModelEntry {
  /** The id to send as `model` — whatever the server answers to. */
  readonly id: string;
  /**
   * Chat roles this model claims. Omitted (with `embed` also omitted) makes it a
   * catch-all for every chat role no other model explicitly claims.
   */
  readonly roles?: readonly Role[];
  /** Declares this an embedding model instead of a chat one. */
  readonly embed?: EmbedKind;
  /**
   * The model's context window, when the user knows it. Left undefined it stays
   * unknown — for llama.cpp the live value is readable from `/props` at runtime,
   * which is a fact rather than a setting.
   */
  readonly context_window?: number;
}

/** One OpenAI-compatible server and the models it serves. */
export interface ProviderEntry {
  /** Stable handle, used in status output and to detect duplicates. */
  readonly id: string;
  readonly api: ProviderApi;
  /** Base URL. Ollama wants the bare host; most others want the `/v1` suffix. */
  readonly base_url: string;
  /**
   * Name of the env var holding this server's API key, not the key itself —
   * secrets are never a setting (Decisions 46/47). Local servers ignore the value
   * but several clients still require one to be present.
   */
  readonly api_key_env?: string;
  readonly models: readonly ProviderModelEntry[];
}

/** Where a resolution came from — reported, because "why this model?" is the question. */
export type ModelSource = "provider" | "catalog";

/** A role resolved all the way to a concrete endpoint and model id. */
export interface ResolvedModel {
  readonly providerId: string;
  readonly api: ProviderApi;
  readonly baseUrl: string;
  readonly model: string;
  readonly source: ModelSource;
  readonly contextWindow?: number;
  readonly apiKeyEnv?: string;
}

/** Everything resolution needs, all of it already read by the caller. */
export interface ResolutionContext {
  readonly providers?: readonly ProviderEntry[] | undefined;
  readonly tier: HardwareTier;
  /** `inference.ollama_base_url` — the catalog fallback's endpoint. */
  readonly ollamaBaseUrl: string;
}

/** The implicit provider id used when nothing is declared. */
export const CATALOG_PROVIDER_ID = "ollama";

/** True when a model entry claims neither a chat role nor an embedding kind. */
function isCatchAll(model: ProviderModelEntry): boolean {
  return model.embed === undefined && (model.roles === undefined || model.roles.length === 0);
}

function resolved(
  provider: ProviderEntry,
  model: ProviderModelEntry,
  source: ModelSource,
): ResolvedModel {
  return {
    providerId: provider.id,
    api: provider.api,
    baseUrl: provider.base_url,
    model: model.id,
    source,
    ...(model.context_window !== undefined ? { contextWindow: model.context_window } : {}),
    ...(provider.api_key_env !== undefined ? { apiKeyEnv: provider.api_key_env } : {}),
  };
}

function catalogChat(role: Role, ctx: ResolutionContext): ResolvedModel {
  return {
    providerId: CATALOG_PROVIDER_ID,
    api: "ollama",
    baseUrl: ctx.ollamaBaseUrl,
    model: chatModelFor(ctx.tier, role),
    source: "catalog",
  };
}

function catalogEmbed(kind: "text" | "code", ctx: ResolutionContext): ResolvedModel {
  return {
    providerId: CATALOG_PROVIDER_ID,
    api: "ollama",
    baseUrl: ctx.ollamaBaseUrl,
    model: embedModelFor(ctx.tier, kind),
    source: "catalog",
  };
}

/**
 * The concrete model for a chat role.
 *
 * Two passes, deliberately: every explicit claim is considered across all providers
 * before any catch-all is. A catch-all declared first must not turn every later,
 * more specific entry into dead config — that would be config you cannot debug by
 * reading it. Within each pass, declaration order wins.
 */
export function resolveChatModel(role: Role, ctx: ResolutionContext): ResolvedModel {
  const providers = ctx.providers ?? [];
  for (const provider of providers) {
    for (const model of provider.models) {
      if (model.embed === undefined && model.roles?.includes(role) === true) {
        return resolved(provider, model, "provider");
      }
    }
  }
  for (const provider of providers) {
    for (const model of provider.models) {
      if (isCatchAll(model)) return resolved(provider, model, "provider");
    }
  }
  return catalogChat(role, ctx);
}

/**
 * The concrete model for an embedding kind.
 *
 * A chat catch-all is NOT eligible here. Handing `/v1/embeddings` to a chat GGUF
 * either errors or — worse — returns vectors that are not embeddings at all, which
 * would silently poison the knowledge base. Falling back to the catalog is the
 * honest failure.
 */
export function resolveEmbedModel(kind: "text" | "code", ctx: ResolutionContext): ResolvedModel {
  const providers = ctx.providers ?? [];
  for (const provider of providers) {
    for (const model of provider.models) {
      if (model.embed === kind) return resolved(provider, model, "provider");
    }
  }
  for (const provider of providers) {
    for (const model of provider.models) {
      if (model.embed === "both") return resolved(provider, model, "provider");
    }
  }
  return catalogEmbed(kind, ctx);
}

/**
 * Problems worth telling a human about, as plain lines.
 *
 * Never throws and never blocks resolution: these are read by `golem devices` and
 * `golem local status`, and a status command that dies on bad config is the failure
 * mode this repo keeps designing away from. Resolution stays deterministic
 * regardless — a duplicate id resolves to whichever entry comes first.
 */
export function validateProviders(providers: readonly ProviderEntry[] | undefined): string[] {
  const problems: string[] = [];
  if (providers === undefined || providers.length === 0) return problems;

  const seen = new Set<string>();
  for (const provider of providers) {
    if (seen.has(provider.id)) {
      problems.push(
        `inference.providers: duplicate provider id "${provider.id}" — the first entry wins ` +
          "and the later one is ignored. Give it a different id or remove it.",
      );
    }
    seen.add(provider.id);

    if (provider.models.length === 0) {
      problems.push(
        `inference.providers: provider "${provider.id}" declares no models, so it can never ` +
          "serve a role. Add a model entry or remove the provider.",
      );
    }

    for (const model of provider.models) {
      if (model.embed !== undefined && model.roles !== undefined && model.roles.length > 0) {
        problems.push(
          `inference.providers: model "${model.id}" in provider "${provider.id}" claims both ` +
            `chat roles (${model.roles.join(", ")}) and embedding kind "${model.embed}". ` +
            "A model is one or the other here; the embedding claim is what takes effect.",
        );
      }
    }
  }
  return problems;
}

/** Every distinct endpoint a table names, in declaration order. For availability probes. */
export function providerEndpoints(
  ctx: ResolutionContext,
): ReadonlyArray<{ readonly id: string; readonly api: ProviderApi; readonly baseUrl: string }> {
  const out: Array<{ id: string; api: ProviderApi; baseUrl: string }> = [];
  const seen = new Set<string>();
  for (const provider of ctx.providers ?? []) {
    const key = `${provider.api} ${provider.base_url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: provider.id, api: provider.api, baseUrl: provider.base_url });
  }
  const catalogKey = `ollama ${ctx.ollamaBaseUrl}`;
  if (!seen.has(catalogKey)) {
    out.push({ id: CATALOG_PROVIDER_ID, api: "ollama", baseUrl: ctx.ollamaBaseUrl });
  }
  return out;
}
