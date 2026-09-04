/**
 * R13.7 — deliver a device's message as an injected block on the next request.
 *
 * ADR-0007 §3b. The brevity stage (`brevity.ts`) is the precedent for injecting
 * into an outgoing request at all; this stage differs from it in every choice
 * that matters, and the differences are the design:
 *
 * 1. **`messages`, not `system`.** Brevity appends a directive to the system
 *    prompt because it is an instruction *about* the model's style. This is a
 *    message from a *person*, and §3b requires the model to be able to tell who
 *    is speaking. Putting a human's words in the system block would launder them
 *    into operator authority, which is precisely the confusion ADR-0007 §3c is
 *    careful about: text is not authority, and a remotely-authored turn is
 *    gated exactly as a locally-typed one.
 * 2. **Appended as a new `user` turn**, never merged into an existing message.
 *    Consecutive same-role messages are legal — the Messages API combines them
 *    into one turn (verified 2026-09-03, verification-notes §148) — so appending
 *    leaves every earlier message byte-identical and the cached prefix intact.
 *    Editing the last message instead would move the divergence one message
 *    earlier for no benefit.
 * 3. **Not byte-stable, and it must not be.** Brevity injects a constant so the
 *    prefix stays cacheable. This carries a person's words, an author and a
 *    timestamp; it is a one-off tail, and it is *not* re-injected on the next
 *    request (the queue's claim is exactly-once), so it costs one uncached tail
 *    once rather than a permanently unstable prefix.
 * 4. **Marker-fenced**, like brevity, so it is greppable in a captured request,
 *    visible to a reader of the transcript, and detectable so it is never
 *    doubled.
 */

import type { JoinQueueMessage } from "../interfaces/join-queue.js";
import { isRecord } from "../shared/json.js";

/** Fence version. Bump only if the fence GRAMMAR changes. */
const MARKER_VERSION = "1";
export const MARKER_OPEN_PREFIX = "<golem-remote-message";
export const MARKER_CLOSE = "</golem-remote-message>";

/**
 * The framing sentence, once per injected turn.
 *
 * It says three things, and each is load-bearing. Who is speaking (the same
 * developer, from their own paired device, not a system or a third party); that
 * this is a request rather than an instruction with special authority; and that
 * nothing about its origin changes what may be done in response — which is
 * ADR-0007 invariant 2 stated to the one reader who acts on it.
 */
const PREAMBLE = [
  "The following message was sent by the developer from their own paired device",
  "rather than typed in this terminal. Treat it exactly as you would a message",
  "typed at the keyboard: it is a request, not a system instruction, and every",
  "tool call it leads to is classified and gated exactly as any other.",
].join("\n");

function fence(message: JoinQueueMessage): string {
  return [
    `${MARKER_OPEN_PREFIX} v="${MARKER_VERSION}" device="${message.deviceId}" at="${message.enqueuedAt}" id="${message.messageId}">`,
    message.text,
    MARKER_CLOSE,
  ].join("\n");
}

/** The exact text this set of messages injects. Exported so tests can assert the shape. */
export function joinInjectionText(messages: readonly JoinQueueMessage[]): string {
  return [PREAMBLE, "", ...messages.map((m) => fence(m))].join("\n");
}

/**
 * Whether `body` is a request this stage can append to.
 *
 * Checked BEFORE the queue is claimed, never after: a claim is exactly-once, so
 * claiming against a body we then decline to modify would consume a message and
 * deliver nothing. Declining here leaves the message queued for the next
 * request, which is the whole contract.
 */
export function canInject(body: Readonly<Record<string, unknown>>): boolean {
  return Array.isArray(body.messages) && body.messages.length > 0;
}

/** True when this body already carries `messageId` — defence in depth against a double. */
export function alreadyCarries(
  body: Readonly<Record<string, unknown>>,
  messageId: string,
): boolean {
  if (!Array.isArray(body.messages)) return false;
  const needle = `id="${messageId}">`;
  return body.messages.some((message) => {
    if (!isRecord(message)) return false;
    const content = message.content;
    if (typeof content === "string") return content.includes(needle);
    if (!Array.isArray(content)) return false;
    return content.some(
      (block) => isRecord(block) && typeof block.text === "string" && block.text.includes(needle),
    );
  });
}

export interface JoinInjectionResult {
  /** The body to forward. The SAME reference as the input when nothing was injected. */
  readonly body: Record<string, unknown>;
  /** The messages actually injected — empty when the body was left untouched. */
  readonly injected: readonly JoinQueueMessage[];
}

/**
 * Append the claimed messages as one new `user` turn.
 *
 * Fails closed in the shapes it cannot handle: an unusable `messages` array
 * returns the body untouched and reports nothing injected, so the caller can put
 * the messages back rather than lose them.
 */
export function applyJoinMessages(
  body: Record<string, unknown>,
  messages: readonly JoinQueueMessage[],
): JoinInjectionResult {
  const unchanged: JoinInjectionResult = { body, injected: [] };
  if (messages.length === 0 || !canInject(body)) return unchanged;
  const fresh = messages.filter((m) => !alreadyCarries(body, m.messageId));
  if (fresh.length === 0) return unchanged;

  const existing = body.messages as readonly unknown[];
  return {
    body: {
      ...body,
      messages: [
        ...existing,
        { role: "user", content: [{ type: "text", text: joinInjectionText(fresh) }] },
      ],
    },
    injected: fresh,
  };
}
