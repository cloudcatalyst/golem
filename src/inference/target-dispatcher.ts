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
import { redactReversibleText } from "../pipeline/redaction.js";
import {
  isGeminiProvider,
  isSpawnProvider,
  isTranslatingProvider,
  listTargets,
  makeAuthMapper,
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

export interface DispatchRequest {
  /** The role to use when this resolves to the local tiered service. */
  readonly role: Role;
  readonly prompt: string;
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
  prompt: string,
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
      messages: [{ role: "user", content: prompt }],
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
    choices?: { message?: { content?: string } }[];
  };
  const text = json.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new TargetDispatchError(
      `target "${target.id}" returned no message content (unexpected response shape).`,
    );
  }
  return { text, model: json.model ?? target.model ?? target.provider };
}

/** POST an Anthropic Messages request and concatenate the text blocks. */
async function dispatchAnthropic(
  target: ResolvedTarget,
  prompt: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<RemoteReply> {
  const base = target.baseUrl.replace(/\/+$/, "");
  const res = await fetchImpl(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...headers,
    },
    body: JSON.stringify({
      model: target.model,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
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
      const messages: readonly ChatMessage[] = [{ role: "user", content: request.prompt }];

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
      const redacted = staysOnThisMachine
        ? // Pass-through, shaped exactly like the real thing so there is still ONE
          // downstream path. Widening the set of targets that reach this branch
          // means widening `permitsUnredactedDispatch`, which is a deliberate act
          // with its own review (R10.8's reservation) — not something that can
          // happen as a side effect of adding a provider.
          { text: request.prompt, count: 0, restore: (reply: string) => reply }
        : redactReversibleText(request.prompt);

      if (isSpawnProvider(target.provider)) {
        const reply = await dispatchSpawned(options, target, redacted.text);
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
      const mapper = makeAuthMapper(target.authScheme, apiKey);
      // A credentialed target with no resolvable key would otherwise dispatch
      // with NO auth header and come back as a bare 401 — a failure that names
      // neither the target nor the missing credential. Say which is missing.
      if (mapper === undefined && target.authScheme !== "inherit") {
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
          ? await dispatchOpenAI(target, redacted.text, authHeaders, fetchImpl, controller.signal)
          : await dispatchAnthropic(
              target,
              redacted.text,
              authHeaders,
              fetchImpl,
              controller.signal,
            );
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
