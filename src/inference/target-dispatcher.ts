/**
 * R9.3 — dispatch a `coder` draft to ANY target from the R9.1 registry.
 *
 * ## Why this sits ABOVE the frozen contract
 *
 * `src/interfaces/inference.ts` is a frozen contract whose doctrine is that
 * *callers never name concrete models* — dispatch is role-based through the tier
 * catalog. A `coder` that names a target contradicts that head-on, so the
 * contract is **not amended**. `InferenceService` keeps its exact present
 * meaning (local, tiered, role-based) and this dispatcher wraps it:
 *
 * - a `local`-trust target on a loopback URL → delegate to `InferenceService`,
 *   mapping the requested role through the existing catalog.
 * - any other target → redact, then dispatch directly, then restore.
 *
 * ## R10.8 — local inference is a destination, not a default
 *
 * Until R10.8 a dispatch that named no target went to the local tiered service,
 * and `inference.default_target` — the setting whose entire job is to name the
 * default — was never consulted. So the local model was not *chosen*; it was
 * what happened when nothing else was. The chain is now, in order:
 *
 * 1. an explicit `targetId` on the call,
 * 2. `inference.worker_targets[worker]`,
 * 3. `inference.default_target`,
 * 4. the harness's own default upstream (the synthetic target over
 *    `proxy.upstream_*`), which always exists.
 *
 * Every one of those four resolves to a target id and goes through the same
 * fail-closed lookup and the same redaction floor below — there is no longer a
 * branch that reaches a model without naming one. A local backend stays fully
 * reachable, by pointing a target at it and naming that target at step 1, 2 or
 * 3; what it stops being is the silent destination for work the user thought
 * they had routed elsewhere. {@link DispatchResult.route} reports which of the
 * four applied, so a surface can say where a draft went and why.
 *
 * ## R13.11 — step 4 cannot always be dispatched to, and says so
 *
 * R10.8 took step 4 to be a universal last resort because the harness's default
 * upstream always *exists*. It is not always *reachable*: on the commonest
 * configuration there is — a Claude Code session against an `inherit`-auth
 * Anthropic upstream — the credential that serves that account belongs to the
 * client and Golem never holds it. `inherit` is a proxy instruction ("forward the
 * caller's headers"), and a dispatch ORIGINATES its request, so there were no
 * headers to forward: every unrouted `coder` call went out unauthenticated and
 * came back a bare `401`. Step 4 had never worked, and the task's gate — "provable
 * from the audit record and `golem status`" — could not have caught it, because
 * routing and reporting were both correct.
 *
 * Two changes close it. {@link originationAuthScheme} resolves `inherit` to the
 * header Golem would have to set *itself*, so a stored key is actually used (it
 * previously could not be: `makeAuthMapper("inherit", …)` discards any key) and a
 * keyless loopback server still sends none. And when no credential exists at all,
 * step 4 raises {@link NoDrafterConfiguredError} — a decline, meaning "nothing is
 * routed here, do the work yourself", not a failure. Steps 1–3 still fail closed
 * with the target named: those were configured deliberately, so a missing key
 * there is a real misconfiguration.
 *
 * ## R13.11 — a dispatch is a conversation, not a prompt
 *
 * The request carried a single `prompt`, so every dispatch was turn one: a caller
 * that disliked a draft and called again re-asked a near-identical question and
 * got a near-identical answer. That reads as a looping model and is really a
 * stateless transport. {@link DispatchRequest.attempts} carries prior drafts and
 * what was wrong with each, rendered by {@link buildDispatchMessages} into real
 * assistant/user turns; {@link DispatchRequest.system} frames the role. Both cross
 * the same egress boundary as the prompt and are redacted with it, under one
 * shared placeholder table.
 *
 * ## The redaction blocker this task exists to close
 *
 * `src/mcp/` contains no redaction calls at all. That was *sound* while the only
 * reachable target was local: nothing left the machine. **The moment `coder` can
 * name a remote target it becomes an egress path that bypasses the proxy's
 * redaction stage** — carrying exactly the material most worth redacting (KB and
 * wiki grounding, and in edit mode, project source).
 *
 * So redaction is not a follow-up here; it lands in the same slice as the target
 * parameter, and it is enforced structurally: {@link dispatch} has exactly one
 * non-local code path and it cannot reach the network without passing through
 * {@link redactReversibleText} first.
 *
 * A target's `trust` may only **raise** the floor, never lower it: `local` is
 * the sole value that permits the unredacted path, and it is only honoured when
 * the endpoint really is loopback — a config claiming `trust = "local"` for a
 * remote URL is refused rather than believed.
 */

import type { ChatMessage, InferenceService, Role } from "../interfaces/inference.js";
import { redactReversibleTexts } from "../pipeline/redaction.js";
import {
  isGeminiProvider,
  isSpawnProvider,
  isTranslatingProvider,
  listTargets,
  makeAuthMapper,
  originationAuthScheme,
  perGatewayEnvVar,
  type ResolvedTarget,
  resolveDefaultTargetId,
  resolveTarget,
  type TargetRegistrySettings,
  type TargetTrust,
  upstreamChatCompletionsPath,
} from "../providers/index.js";
import { workerTarget } from "./workers.js";

/** Hosts for which `trust: "local"` is believable — context never leaves the machine. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Output cap for a remote dispatch, shared by both transports.
 *
 * One constant rather than a per-transport literal: the Anthropic path pinned
 * 4096 while the OpenAI-shaped path pinned nothing at all, so the same draft
 * request had a different, unstated ceiling depending on which provider served
 * it — and a reply truncated at a gateway's own default reads like a model that
 * restated the task and stopped, not like a truncation.
 */
const REMOTE_MAX_TOKENS = 4096;

/**
 * R13.11 — one previous try at the SAME task, and what was wrong with it.
 *
 * The reason this type exists: a dispatch used to carry a single `prompt` and
 * nothing else, so every call was turn one of a fresh conversation. Re-calling
 * `coder` after a draft did not work therefore re-asked a near-identical
 * question and got a near-identical answer — the model had no way to know an
 * attempt had already been made, let alone which one. Iterating was not
 * *unreliable*, it was structurally impossible.
 */
export interface DispatchAttempt {
  /** What the model produced last time, verbatim. */
  readonly draft: string;
  /** What was actually wrong with it — the test that failed, the behaviour observed. */
  readonly problem: string;
}

/**
 * One turn of a dispatched conversation.
 *
 * A type alias rather than an interface so it stays assignable to the frozen
 * {@link ChatMessage} (`Readonly<Record<string, unknown>>`) without a cast: TS
 * gives an implicit index signature to object type aliases and not to interfaces.
 */
export type DispatchMessage = {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
};

export interface DispatchRequest {
  /** The role to use when this resolves to the local tiered service. */
  readonly role: Role;
  readonly prompt: string;
  /**
   * R13.11 — a system/role line for the model, when the caller has one worth
   * sending. Absent for the local tiered service's own roles, which the tier
   * catalog already frames.
   */
  readonly system?: string | undefined;
  /**
   * R13.11 — previous attempts at this task, oldest first. Rendered as real
   * assistant/user turns so the model can see what it already tried and why that
   * did not work, instead of re-deriving it.
   *
   * Redacted on exactly the same footing as {@link prompt} — see the egress
   * boundary in {@link createTargetDispatcher}. Every message shares ONE
   * placeholder table, so a secret appearing in two turns is the same
   * placeholder in both and restores correctly.
   */
  readonly attempts?: readonly DispatchAttempt[] | undefined;
  /** A target id from the registry. Omitted → step 2 of the R10.8 chain onward. */
  readonly targetId?: string | undefined;
  /**
   * R9.4 — which tool worker is dispatching (`coder`, and more to come). Selects
   * the `inference.worker_targets` entry that applies when no `targetId` is
   * given. Omitted, or no entry for it → `inference.default_target`, then the
   * harness's own default upstream.
   */
  readonly worker?: string | undefined;
}

/**
 * R10.8 — which step of the resolution chain chose the target. Reported rather
 * than inferred: "it went to your Anthropic account" and "it went to your
 * Anthropic account *because nothing named anything else*" are different facts,
 * and only the second one tells a user their config is not doing what they
 * think.
 */
export type DispatchRoute =
  /** An explicit `targetId` on the call. */
  | "explicit"
  /** This worker's `inference.worker_targets` entry. */
  | "worker"
  /** `inference.default_target`. */
  | "default_target"
  /** Nothing named a target — the synthetic default over `proxy.upstream_*`. */
  | "harness";

/** How to describe {@link DispatchRoute} in an audit line or a user-facing note. */
export function describeRoute(route: DispatchRoute, worker?: string | undefined): string {
  switch (route) {
    case "explicit":
      return "target named by the caller";
    case "worker":
      return `inference.worker_targets.${worker ?? "?"}`;
    case "default_target":
      return "inference.default_target";
    case "harness":
      return "the harness default upstream (proxy.upstream_*) — nothing named a target";
  }
}

export interface DispatchResult {
  /** The reply, with any redaction placeholders restored. */
  readonly text: string;
  /** The concrete model that produced it. */
  readonly model: string;
  /**
   * The target that served it. Never null since R10.8: every dispatch resolves a
   * target, even when the caller and the config both named none.
   */
  readonly targetId: string;
  readonly trust: TargetTrust;
  /** Which step of the chain picked {@link targetId}. */
  readonly route: DispatchRoute;
  /** How many secret occurrences were redacted before dispatch (0 on the local path). */
  readonly redactedCount: number;
}

/** A target the conversation is allowed to name. */
export interface SelectableTarget {
  readonly id: string;
  readonly provider: string;
  readonly model: string | null;
  readonly trust: TargetTrust;
}

export interface TargetDispatcher {
  dispatch(request: DispatchRequest): Promise<DispatchResult>;
  /** Targets config declares AND marks agent-selectable. */
  selectableTargets(): readonly SelectableTarget[];
}

/** Raised for a target the caller may not use, or cannot be dispatched to. */
export class TargetDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetDispatchError";
  }
}

/**
 * R13.11 — nothing routes this worker, and the harness default cannot be
 * dispatched to on Golem's behalf. A **decline**, not a failure.
 *
 * The distinction is the whole point of a separate class. R10.8's step 4 assumed
 * the harness's own default upstream is always dispatchable, and on the commonest
 * configuration there is — a Claude Code session against an `inherit`-auth
 * Anthropic upstream — it never was: Golem holds no credential of its own for it,
 * so the request went out unauthenticated and came back a bare `401`. Reported as
 * an error, that reads as "Golem is broken"; the truthful reading is "there is no
 * drafter here, so do the work yourself" — which is what the caller was going to
 * do anyway, and what a caller with no `worker_targets` almost certainly expected.
 *
 * Callers should surface this as an ordinary result that redirects the work
 * inline, NOT as a tool error. It never means the config is wrong — only that no
 * delegation was configured.
 */
export class NoDrafterConfiguredError extends TargetDispatchError {
  constructor(message: string) {
    super(message);
    this.name = "NoDrafterConfiguredError";
  }
}

/**
 * Render a dispatch as a real conversation.
 *
 * The shape is deliberate: the task, then one assistant/user pair per previous
 * attempt, so the final turn is always the user's. A model that can see its own
 * rejected draft revises it; a model handed the bare task again re-derives it.
 */
export function buildDispatchMessages(
  request: Pick<DispatchRequest, "prompt" | "system" | "attempts">,
): readonly DispatchMessage[] {
  const out: DispatchMessage[] = [];
  if (request.system !== undefined && request.system !== "") {
    out.push({ role: "system", content: request.system });
  }
  out.push({ role: "user", content: request.prompt });
  for (const attempt of request.attempts ?? []) {
    out.push({ role: "assistant", content: attempt.draft });
    out.push({
      role: "user",
      content:
        `That did not work: ${attempt.problem}\n\n` +
        "Do not repeat the same answer. Produce a corrected version that addresses " +
        "specifically what went wrong above.",
    });
  }
  return out;
}

/** Replace every message's content, positionally — the redacted conversation. */
function withContents(
  messages: readonly DispatchMessage[],
  contents: readonly string[],
): readonly DispatchMessage[] {
  return messages.map((m, i) => ({ role: m.role, content: contents[i] ?? m.content }));
}

/**
 * Flatten a conversation into one prompt, for a transport that takes only a
 * single string (a spawned CLI). Lossy by necessity, so it LABELS the turns
 * rather than silently concatenating them into something that reads like one
 * instruction.
 */
function flattenMessages(messages: readonly DispatchMessage[]): string {
  if (messages.length === 1) return messages[0]?.content ?? "";
  return messages
    .map((m) => (m.role === "user" ? m.content : `[${MESSAGE_LABELS[m.role]}]\n${m.content}`))
    .join("\n\n");
}

const MESSAGE_LABELS: Record<DispatchMessage["role"], string> = {
  system: "instructions",
  user: "user",
  assistant: "your earlier reply",
};

function isLoopback(baseUrl: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Whether this target may be dispatched to WITHOUT redaction.
 *
 * Two conditions, both required: the target declares `trust: "local"`, and its
 * endpoint really is loopback. The second check is the point — trust is
 * user-authored config, and a typo'd or copy-pasted `trust = "local"` on a LAN
 * or cloud URL would otherwise turn the redaction bypass into a silent egress.
 * Config may raise the floor; it may not assert its way past physics.
 */
function permitsUnredactedDispatch(target: ResolvedTarget): boolean {
  return target.trust === "local" && isLoopback(target.baseUrl);
}

/** Same scheme, host and port — the test for "this target IS that endpoint". */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * R10.9 — is this target the endpoint {@link TargetDispatcherOptions.inference}
 * actually serves?
 *
 * The question exists because `options.inference` is the **Ollama-backed tiered
 * service**, not a general local transport. `dispatch()` used to hand every
 * trusted-local target to it, which silently meant "local ⇒ Ollama" rather than
 * "local ⇒ the endpoint this target names". A loopback `llamacpp` target on
 * `:8080` drafted on Ollama at `:11434` instead — or failed outright, if Ollama
 * was not installed. That was ~true while `ollama` was the only self-hosted
 * provider; R10.8 added `llamacpp` and made it reachable by following the
 * documented path.
 *
 * The tiered service keeps its special case where it is genuinely the
 * destination, because it is the only path that maps a ROLE through the hardware
 * tier catalog — so it can serve a target that declares no model, which the direct
 * transport cannot.
 *
 * `localServiceBaseUrl` is the precise answer. Without it (a caller that did not
 * wire it) the fallback is the provider name: `InferenceService` is Ollama-backed,
 * so `ollama` is a sound stand-in that keeps every existing wiring behaving
 * exactly as before, while the provider the defect was reported against goes to
 * the endpoint it names. The residual imprecision is narrow and worth stating: two
 * Ollama servers on different loopback ports are indistinguishable to the
 * fallback, so the one that is not the tiered service would still be dispatched to
 * the one that is. Wiring `localServiceBaseUrl` removes even that.
 */
function servesLocalTieredService(
  target: ResolvedTarget,
  options: Pick<TargetDispatcherOptions, "localServiceBaseUrl">,
): boolean {
  if (options.localServiceBaseUrl !== undefined && options.localServiceBaseUrl !== "") {
    return sameOrigin(target.baseUrl, options.localServiceBaseUrl);
  }
  return target.provider === "ollama";
}

export interface TargetDispatcherOptions {
  /** The frozen, role-based local service. Untouched by this task. */
  readonly inference: InferenceService;
  /**
   * R10.9 — the endpoint {@link inference} actually serves
   * (`inference.ollama_base_url`).
   *
   * Needed because "this target is trusted-local" and "this target is the tiered
   * service" are different facts, and conflating them sent a loopback `llamacpp`
   * target to Ollama. See {@link servesLocalTieredService} for what happens when
   * this is omitted.
   */
  readonly localServiceBaseUrl?: string | undefined;
  readonly settings: TargetRegistrySettings;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /**
   * ADR-0003 invariant 5 — every dispatch is attributable. Receives non-secret
   * facts only; it must not throw.
   */
  readonly audit?: (event: {
    readonly targetId: string | null;
    readonly provider: string | null;
    readonly model: string | null;
    readonly trust: string | null;
    /** R10.8 — which step of the chain chose the target. */
    readonly route: DispatchRoute;
    readonly redactedCount: number;
    readonly reason: string;
  }) => void;
  /**
   * R9.4 — `inference.worker_targets`: worker name → target id. The dispatch's
   * {@link DispatchRequest.worker} picks the entry. A worker with no entry falls
   * through to `inference.default_target` and then to the harness default
   * (R10.8) — never a silent fall back to the local model, which would send the
   * work somewhere the user did not choose while reporting success.
   *
   * Applied as a *default*, never as an override: an explicit `targetId` on the
   * request always wins.
   */
  readonly workerTargets?: Readonly<Record<string, string>> | undefined;
  /**
   * Resolve a target's credential without it ever entering the environment.
   *
   * Decision 47's spawn-time handoff assumes a process the CLI *spawns* (the
   * proxy daemon, which gets `credentialEnvForProxy` injected at spawn). The MCP
   * server is spawned by Claude Code from `.mcp.json`, so it inherits no
   * `GOLEM_UPSTREAM_API_KEY__*` at all — every credentialed target dispatched
   * from `coder` therefore went out with **no auth header** and came back 401,
   * while `golem target list` correctly reported the key as stored.
   *
   * A resolver rather than more env: secrets stay in this process's closure, so
   * nothing the MCP server spawns (capability probes, Ollama calls) inherits
   * them. Receives `null` for a target on the default top-level upstream config.
   * When omitted, the env lookup below is used unchanged.
   */
  readonly resolveKey?: (
    accountId: string | null,
  ) => string | undefined | Promise<string | undefined>;
  /**
   * R9.15 — how a `claude-cli` target is reached: by spawning the user's own
   * Claude Code CLI. Injected rather than imported so that POLICY (the two
   * guards below, redaction, audit) and MECHANISM (a child process) stay in
   * separate modules, and a policy test needs no child process.
   *
   * Absent → a `claude-cli` target is refused rather than silently rerouted.
   */
  readonly spawnDrafter?: (input: {
    readonly prompt: string;
    readonly model: string;
  }) => Promise<string>;
  /**
   * The model the interactive session is currently being served, for the
   * "don't draft on the model you are already using" guard. Read from
   * `.golem/state/served-model.json` by the caller. Returning undefined means
   * "unknown", and the guard then allows the dispatch — refusing on no evidence
   * would be worse than the waste it prevents.
   */
  readonly sessionModel?: () => string | undefined | Promise<string | undefined>;
  /** Per-request timeout for a remote dispatch. */
  readonly timeoutMs?: number;
}

interface RemoteReply {
  readonly text: string;
  readonly model: string;
}

/** POST an OpenAI Chat Completions request and read the first choice. */
async function dispatchOpenAI(
  target: ResolvedTarget,
  messages: readonly DispatchMessage[],
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<RemoteReply> {
  // `upstreamChatCompletionsPath` returns a PATH — it was built for undici,
  // which takes origin and path separately. `fetch` needs an absolute URL.
  const url = `${new URL(target.baseUrl).origin}${upstreamChatCompletionsPath(target.baseUrl)}`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      model: target.model,
      messages,
      // R13.11 — pinned to match the Anthropic path below. Omitting it left the
      // cap to whatever the gateway defaults to, which differs per provider and
      // per model; a draft truncated at an unannounced limit reads like a model
      // that restated the task and stopped rather than like a truncation.
      max_tokens: REMOTE_MAX_TOKENS,
      stream: false,
    }),
    signal,
  });
  if (!res.ok) {
    throw new TargetDispatchError(
      `target "${target.id}" returned ${res.status} ${res.statusText}. No draft was produced.`,
    );
  }
  const json = (await res.json()) as {
    model?: string;
    choices?: {
      message?: { content?: string; reasoning?: string; reasoning_content?: string };
    }[];
  };
  const message = json.choices?.[0]?.message;
  // R13.11 — a reasoning model routed through an OpenAI-shaped gateway may put
  // everything it produced in `reasoning`/`reasoning_content` and leave `content`
  // empty. Read those as a fallback, never as a preference: an empty `content`
  // with reasoning present used to surface as "unexpected response shape", which
  // named the wrong problem.
  const text =
    message?.content !== undefined && message.content !== ""
      ? message.content
      : (message?.reasoning_content ?? message?.reasoning);
  if (typeof text !== "string" || text === "") {
    throw new TargetDispatchError(
      `target "${target.id}" returned no message content (unexpected response shape).`,
    );
  }
  return { text, model: json.model ?? target.model ?? target.provider };
}

/** POST an Anthropic Messages request and concatenate the text blocks. */
async function dispatchAnthropic(
  target: ResolvedTarget,
  messages: readonly DispatchMessage[],
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<RemoteReply> {
  const base = target.baseUrl.replace(/\/+$/, "");
  // The Messages API takes the system prompt as a top-level field; a
  // `system`-role turn inside `messages` is rejected outright.
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const res = await fetchImpl(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...headers,
    },
    body: JSON.stringify({
      model: target.model,
      max_tokens: REMOTE_MAX_TOKENS,
      ...(system === "" ? {} : { system }),
      messages: messages.filter((m) => m.role !== "system"),
    }),
    signal,
  });
  if (!res.ok) {
    throw new TargetDispatchError(
      `target "${target.id}" returned ${res.status} ${res.statusText}. No draft was produced.`,
    );
  }
  const json = (await res.json()) as {
    model?: string;
    content?: { type?: string; text?: string }[];
  };
  const text = (json.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
  if (text === "") {
    throw new TargetDispatchError(
      `target "${target.id}" returned no text content (unexpected response shape).`,
    );
  }
  return { text, model: json.model ?? target.model ?? target.provider };
}

/**
 * R9.15 — the provider whose "endpoint" is the user's own Claude Code session.
 *
 * Two guards, both asked for explicitly and both REFUSING rather than falling
 * back, because a silent reroute is the failure mode this dispatcher exists to
 * avoid (see the unknown-target branch above).
 *
 * 1. **The session's upstream must be Anthropic.** The spawned client
 *    authenticates as itself, so if the session is fronted by a third-party
 *    gateway the draft lands on a *different* account than the work it is
 *    drafting for. That is a surprise, not a saving.
 * 2. **The target's model must differ from the session's.** Spawning a whole
 *    second session to draft on the model already in use spends the same quota
 *    for a strictly worse context. Unknown session model → allowed: refusing on
 *    no evidence would cost more than the waste it prevents.
 */
async function dispatchSpawned(
  options: TargetDispatcherOptions,
  target: ResolvedTarget,
  redactedPrompt: string,
): Promise<RemoteReply> {
  if (options.spawnDrafter === undefined) {
    throw new TargetDispatchError(
      `target "${target.id}" is a claude-cli target, which is served by spawning the Claude ` +
        "Code CLI — and this process has no spawner wired. Route this worker elsewhere.",
    );
  }

  const sessionProvider = sessionUpstreamProvider(options.settings);
  if (sessionProvider !== "anthropic") {
    throw new TargetDispatchError(
      `target "${target.id}" drafts by spawning your own Claude Code session, but this ` +
        `project's upstream is "${sessionProvider}". The spawned client authenticates as ` +
        "itself, so the draft would be billed to a different account than the session it is " +
        "drafting for. Point the upstream at Anthropic, or route this worker to a target with " +
        "its own credential.",
    );
  }

  const current = await options.sessionModel?.();
  if (current !== undefined && target.model !== undefined && current === target.model) {
    throw new TargetDispatchError(
      `target "${target.id}" would draft on "${target.model}", which is the model this session ` +
        "is already using — the same quota, in a worse context, for a whole extra session " +
        "start. Give the target a different model, or route this worker elsewhere.",
    );
  }
  if (target.model === undefined) {
    throw new TargetDispatchError(
      `target "${target.id}" declares no model, so there is nothing to ask.`,
    );
  }

  const text = await options.spawnDrafter({ prompt: redactedPrompt, model: target.model });
  return { text, model: target.model };
}

/**
 * Which provider actually fronts this session — the resolved default target's,
 * falling back to the top-level upstream config when the registry cannot answer.
 */
function sessionUpstreamProvider(settings: TargetRegistrySettings): string {
  const lookup = resolveTarget(settings, resolveDefaultTargetId(settings));
  return lookup.ok ? lookup.target.provider : settings.upstream_provider;
}

/**
 * R10.8 — the four-step chain, as one pure function so every surface that wants
 * to *predict* a dispatch (`golem status`) asks the same code the dispatch asks.
 *
 * Step 3 and step 4 both come out of {@link resolveDefaultTargetId}, which
 * already encodes both (`settings.default_target ?? defaultTargetId(provider)`,
 * plus the bare-gateway-id resolution R9.23 added). Re-deriving the id here
 * would be a second copy of a rule that must not drift; the ROUTE is a separate
 * observation about which half of that expression applied.
 *
 * Note this returns an id, not a target — resolution stays fail-closed at
 * {@link resolveTarget}, so a `default_target` naming nothing raises there with
 * the list of what does exist.
 */
export function selectTarget(
  options: Pick<TargetDispatcherOptions, "settings" | "workerTargets">,
  request: Pick<DispatchRequest, "targetId" | "worker">,
): { readonly id: string; readonly route: DispatchRoute } {
  if (request.targetId !== undefined && request.targetId !== "") {
    return { id: request.targetId, route: "explicit" };
  }
  const fromWorker =
    request.worker !== undefined ? workerTarget(options.workerTargets, request.worker) : undefined;
  if (fromWorker !== undefined) return { id: fromWorker, route: "worker" };

  const configured = options.settings.default_target;
  return {
    id: resolveDefaultTargetId(options.settings),
    route: configured !== undefined && configured !== "" ? "default_target" : "harness",
  };
}

export function createTargetDispatcher(options: TargetDispatcherOptions): TargetDispatcher {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;

  const selectable = (): readonly SelectableTarget[] =>
    listTargets(options.settings)
      // `agent_selectable = false` opts ONE target out — for the case that
      // actually matters: an expensive account you want reachable by an explicit
      // route but never picked for a draft. Declaring a target is already a
      // deliberate act, so selectable-by-default is the right polarity;
      // per-target opt-in would be ceremony without safety.
      .filter((t) => declaredSelectable(options.settings, t.id))
      .map((t) => ({
        id: t.id,
        provider: t.provider,
        model: t.model ?? null,
        trust: t.trust,
      }));

  return {
    selectableTargets: selectable,

    async dispatch(request: DispatchRequest): Promise<DispatchResult> {
      // R13.11 — the conversation, not one prompt. With no `attempts` this is
      // exactly the single user turn it always was, so nothing changes for a
      // first call; with them the model can see what it already tried.
      const messages = buildDispatchMessages(request);

      // R10.8: the four-step chain. Every branch yields a target ID, so there is
      // no path from here to a model that was not named by somebody.
      const { id: named, route } = selectTarget(options, request);
      const via = describeRoute(route, request.worker);

      // Fail closed: an unknown id is an error naming what exists, never a
      // fallback to another target or to the local model. This now guards
      // `inference.default_target` too — a typo there raises, exactly as a typo
      // in `worker_targets` always has, rather than quietly drafting locally and
      // reporting success.
      const lookup = resolveTarget(options.settings, named);
      if (!lookup.ok) throw new TargetDispatchError(`${lookup.reason} (via ${via})`);
      const base = lookup.target;

      if (!declaredSelectable(options.settings, base.id)) {
        throw new TargetDispatchError(
          `target "${base.id}" is marked agent_selectable = false, so it cannot be chosen ` +
            "for a draft. Route to it explicitly instead.",
        );
      }

      // A local-trust loopback target keeps the unredacted path — that is the ONE
      // case where nothing leaves the machine.
      //
      // R10.9 splits the two questions this branch used to answer at once.
      // `permitsUnredactedDispatch` decides WHETHER TO REDACT; it does not decide
      // where the bytes go. Only a target that IS the tiered service's endpoint is
      // handed to `options.inference` — every other trusted-local target is
      // dispatched to the endpoint it names, by its own provider's transport, like
      // every other target in this function.
      const unredacted = permitsUnredactedDispatch(base);
      if (unredacted && servesLocalTieredService(base, options)) {
        const result = await options.inference.chat(request.role, messages);
        options.audit?.({
          targetId: base.id,
          provider: base.provider,
          model: result.model,
          trust: base.trust,
          route,
          redactedCount: 0,
          reason: `${via} → local target — dispatched to the local tiered service`,
        });
        return {
          text: result.text,
          model: result.model,
          targetId: base.id,
          trust: base.trust,
          route,
          redactedCount: 0,
        };
      }

      // R10.8 — the harness default routinely declares NO model, and that is
      // correct rather than broken: a byte-faithful Anthropic upstream forwards
      // the client's own `claude-*` id, so `proxy.upstream_model` is left unset
      // on the most common configuration there is. A dispatch that originates
      // here has no client request whose id it could forward, so the honest
      // stand-in is the model this session is actually being served — the same
      // snapshot the "don't draft on the model you are already using" guard
      // reads. Refusing instead would make step 4 unreachable for a fresh
      // project, which is exactly the project it exists for.
      //
      // Only on the harness step. Every other step named a target deliberately,
      // and a *named* target that declares no model is a configuration error
      // worth reporting rather than papering over.
      const target =
        base.model === undefined && route === "harness"
          ? { ...base, model: await options.sessionModel?.() }
          : base;

      if (target.model === undefined) {
        throw new TargetDispatchError(
          route === "harness"
            ? `no target is configured for this draft, so it fell through to the harness ` +
                `default upstream ("${target.id}") — which declares no model, and this session's ` +
                "own model is not known yet. Name a destination with `inference.default_target` " +
                "or `inference.worker_targets`, or set `proxy.upstream_model`."
            : `target "${target.id}" declares no model, so there is nothing to ask. ` +
                "Give it one with `golem target add --model <id>`.",
        );
      }
      if (isGeminiProvider(target.provider)) {
        throw new TargetDispatchError(
          `target "${target.id}" uses the Gemini schema, which \`coder\` cannot dispatch to yet. ` +
            "Use it as a proxy route instead.",
        );
      }

      // ── The egress boundary. Everything past this line may leave the machine,
      // so redaction happens HERE and there is no other non-local path. A spawn
      // is an egress like any other: the child talks to Anthropic.
      //
      // R10.9 — the ONE exception, and the whole of it: a target that
      // `permitsUnredactedDispatch` certified (declares `trust: "local"` AND its
      // endpoint really is loopback) but which is not the tiered service's own
      // endpoint. It reaches a socket on this machine and nowhere else, which is
      // the same guarantee the `InferenceService` path above has always had —
      // that path also POSTs an unredacted prompt to a loopback port. So this is
      // the existing local class generalised from one hard-coded endpoint to any
      // endpoint that passed the same check, NOT a new class of egress.
      //
      // A spawn is excluded unconditionally, whatever its trust says: the child
      // process talks to Anthropic, so "loopback base URL" would certify nothing
      // about where the bytes actually go.
      const staysOnThisMachine = unredacted && !isSpawnProvider(target.provider);
      // R13.11 — EVERY turn, not just the task. A prior draft and the note saying
      // why it failed are ordinary context and carry exactly the same material
      // worth redacting; redacting only `prompt` would have made `attempts` a
      // hole straight through the boundary this function exists to enforce.
      // `redactReversibleTexts` shares one placeholder table across all of them,
      // so a secret appearing in two turns is the same placeholder in both and
      // restores correctly.
      const redacted = staysOnThisMachine
        ? // Pass-through, shaped exactly like the real thing so there is still ONE
          // downstream path. Widening the set of targets that reach this branch
          // means widening `permitsUnredactedDispatch`, which is a deliberate act
          // with its own review (R10.8's reservation) — not something that can
          // happen as a side effect of adding a provider.
          { texts: messages.map((m) => m.content), count: 0, restore: (reply: string) => reply }
        : redactReversibleTexts(messages.map((m) => m.content));
      const outbound = withContents(messages, redacted.texts);

      if (isSpawnProvider(target.provider)) {
        const reply = await dispatchSpawned(options, target, flattenMessages(outbound));
        options.audit?.({
          targetId: target.id,
          provider: target.provider,
          model: reply.model,
          trust: target.trust,
          route,
          redactedCount: redacted.count,
          reason: `${via} → spawned the user's own Claude Code CLI — redacted before spawn`,
        });
        return {
          text: redacted.restore(reply.text),
          model: reply.model,
          targetId: target.id,
          trust: target.trust,
          route,
          redactedCount: redacted.count,
        };
      }

      const apiKey =
        options.resolveKey !== undefined
          ? await options.resolveKey(target.accountId)
          : target.accountId === null
            ? env.GOLEM_UPSTREAM_API_KEY
            : env[perGatewayEnvVar(target.accountId)];
      // R13.11 — this is an ORIGINATED request, so `inherit` cannot mean "forward
      // the client's credential": there is no client request here. Resolve it to
      // the header Golem would have to set itself, which is `undefined` only for
      // a provider that genuinely needs none. Two defects close here at once:
      //
      //  - `makeAuthMapper("inherit", …)` returns undefined whatever key is
      //    passed, so the harness default on an Anthropic upstream ALWAYS
      //    dispatched keyless and always 401'd — and a key stored with
      //    `golem gateway login anthropic` could never help, because the scheme
      //    discarded it before the key was even consulted.
      //  - a keyless loopback server (`ollama`, `llamacpp`) still resolves to
      //    `undefined` and still dispatches with no headers, exactly as before.
      const scheme =
        target.authScheme === "inherit"
          ? originationAuthScheme(target.provider)
          : target.authScheme;
      const mapper = scheme === undefined ? undefined : makeAuthMapper(scheme, apiKey);
      // A credentialed target with no resolvable key would otherwise dispatch
      // with NO auth header and come back as a bare 401 — a failure that names
      // neither the target nor the missing credential. Say which is missing.
      if (mapper === undefined && scheme !== undefined) {
        // The harness step is the one case where the absence is not a
        // misconfiguration at all: nothing routed this worker, and step 4's
        // premise — "use the account the session already uses" — is unreachable
        // from here, because that account's credential belongs to the CLIENT and
        // Golem never holds it. So decline and let the caller do the work, rather
        // than report a broken config the user never wrote.
        if (route === "harness") {
          throw new NoDrafterConfiguredError(
            `nothing routes ${request.worker === undefined ? "this draft" : `\`${request.worker}\``}, ` +
              `so it fell through to the harness default upstream ("${target.id}") — which is served ` +
              "by forwarding your own client's credential, and Golem never holds that, so it cannot " +
              "draft on your behalf there. Do this work yourself. To delegate it instead, name a " +
              "destination with `inference.worker_targets" +
              `${request.worker === undefined ? "" : `.${request.worker}`}\` or ` +
              "`inference.default_target`, or store a key for this upstream with " +
              "`golem gateway login anthropic`.",
          );
        }
        throw new TargetDispatchError(
          `target "${target.id}" needs a credential and none resolved` +
            (target.accountId === null
              ? " for the default upstream account"
              : ` for account "${target.accountId}"`) +
            `. Store one with \`golem gateway login ${target.accountId ?? "anthropic"}\`.`,
        );
      }
      const authHeaders = mapper ? (mapper({}) as Record<string, string>) : {};

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let reply: RemoteReply;
      try {
        reply = isTranslatingProvider(target.provider)
          ? await dispatchOpenAI(target, outbound, authHeaders, fetchImpl, controller.signal)
          : await dispatchAnthropic(target, outbound, authHeaders, fetchImpl, controller.signal);
      } finally {
        clearTimeout(timer);
      }

      options.audit?.({
        targetId: target.id,
        provider: target.provider,
        model: reply.model,
        trust: target.trust,
        route,
        redactedCount: redacted.count,
        // R10.9: the audit line is how the gate is proven, so it must name the
        // endpoint for a local dispatch. "went to the target it names" is the
        // whole claim, and `targetId` alone does not evidence it.
        reason: staysOnThisMachine
          ? `${via} → loopback target (trust=${target.trust}) at ${target.baseUrl} — ` +
            "direct transport, not the tiered service; unredacted (never leaves this machine)"
          : `${via} → non-local target (trust=${target.trust}) — redacted before dispatch`,
      });

      return {
        // Restore the placeholders: a draft full of `[REDACTED:…]` is useless,
        // so the round trip is part of the requirement.
        text: redacted.restore(reply.text),
        model: reply.model,
        targetId: target.id,
        trust: target.trust,
        route,
        redactedCount: redacted.count,
      };
    },
  };
}

/** Whether config leaves this target selectable by the conversation (default: yes). */
function declaredSelectable(settings: TargetRegistrySettings, id: string): boolean {
  const declared = (settings.targets ?? []).find((t) => t.id === id);
  return declared?.agent_selectable !== false;
}
