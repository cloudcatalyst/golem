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
 * - no target, or a `local`-trust target → delegate to `InferenceService`,
 *   mapping the requested role through the existing catalog. **Today's path,
 *   unchanged.**
 * - any non-local target → redact, then dispatch directly, then restore.
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
  isTranslatingProvider,
  listTargets,
  makeAuthMapper,
  perAccountEnvVar,
  type ResolvedTarget,
  resolveTarget,
  type TargetRegistrySettings,
  type TargetTrust,
  upstreamChatCompletionsPath,
} from "../providers/index.js";

/** Hosts for which `trust: "local"` is believable — context never leaves the machine. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export interface DispatchRequest {
  /** The role to use when this resolves to the local tiered service. */
  readonly role: Role;
  readonly prompt: string;
  /** A target id from the registry. Omitted → the local `InferenceService`. */
  readonly targetId?: string | undefined;
}

export interface DispatchResult {
  /** The reply, with any redaction placeholders restored. */
  readonly text: string;
  /** The concrete model that produced it. */
  readonly model: string;
  /** The target id, or null when the local tiered service served it. */
  readonly targetId: string | null;
  readonly trust: TargetTrust | null;
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

export interface TargetDispatcherOptions {
  /** The frozen, role-based local service. Untouched by this task. */
  readonly inference: InferenceService;
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
    readonly redactedCount: number;
    readonly reason: string;
  }) => void;
  /**
   * R9.4 — `inference.coder_target`: the target used when a dispatch names
   * none. Unset → the local tiered service, exactly as before.
   *
   * Applied as a *default*, never as an override: an explicit `targetId` on the
   * request always wins.
   */
  readonly defaultTargetId?: string | undefined;
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

      // R9.4: an explicit target always wins; `inference.coder_target` fills in
      // when the call names none.
      const named =
        request.targetId !== undefined && request.targetId !== ""
          ? request.targetId
          : (options.defaultTargetId ?? undefined);

      // No target at all → exactly today's behaviour, through the frozen contract.
      if (named === undefined || named === "") {
        const result = await options.inference.chat(request.role, messages);
        options.audit?.({
          targetId: null,
          provider: null,
          model: result.model,
          trust: null,
          redactedCount: 0,
          reason: "no target named — local tiered inference",
        });
        return {
          text: result.text,
          model: result.model,
          targetId: null,
          trust: null,
          redactedCount: 0,
        };
      }

      // Fail closed: an unknown id is an error naming what exists, never a
      // fallback to another target or to the local model.
      const lookup = resolveTarget(options.settings, named);
      if (!lookup.ok) throw new TargetDispatchError(lookup.reason);
      const target = lookup.target;

      if (!declaredSelectable(options.settings, target.id)) {
        throw new TargetDispatchError(
          `target "${target.id}" is marked agent_selectable = false, so it cannot be chosen ` +
            "for a draft. Route to it explicitly instead.",
        );
      }

      // A local-trust loopback target keeps the direct, unredacted path — that
      // is the ONE case where nothing leaves the machine.
      if (permitsUnredactedDispatch(target)) {
        const result = await options.inference.chat(request.role, messages);
        options.audit?.({
          targetId: target.id,
          provider: target.provider,
          model: result.model,
          trust: target.trust,
          redactedCount: 0,
          reason: "local target — dispatched to the local tiered service",
        });
        return {
          text: result.text,
          model: result.model,
          targetId: target.id,
          trust: target.trust,
          redactedCount: 0,
        };
      }

      if (target.model === undefined) {
        throw new TargetDispatchError(
          `target "${target.id}" declares no model, so there is nothing to ask. ` +
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
      // so redaction happens HERE and there is no other non-local path.
      const redacted = redactReversibleText(request.prompt);

      const apiKey =
        target.accountId === null
          ? env.GOLEM_UPSTREAM_API_KEY
          : env[perAccountEnvVar(target.accountId)];
      const mapper = makeAuthMapper(target.authScheme, apiKey);
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
        redactedCount: redacted.count,
        reason: `non-local target (trust=${target.trust}) — redacted before dispatch`,
      });

      return {
        // Restore the placeholders: a draft full of `[REDACTED:…]` is useless,
        // so the round trip is part of the requirement.
        text: redacted.restore(reply.text),
        model: reply.model,
        targetId: target.id,
        trust: target.trust,
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
