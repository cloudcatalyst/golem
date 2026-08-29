/**
 * R13.5 — the wire between a hosted session and a device.
 *
 * SSE downstream, POST upstream (ADR-0007 §7c). No WebSocket, which is what
 * holds the five-dependency pin: `text/event-stream` is a content type and a
 * newline convention, and `node:http` already has both.
 *
 * Mounted BEHIND R13.4's write server, so every route here has already presented
 * a valid device certificate and a live user factor. This module contains no
 * authentication of its own, deliberately: two places that decide who may write
 * is one place too many.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionEvent, SessionMessageResponse } from "../interfaces/session-events.js";
import { appendHostLog } from "./host-log.js";
import { MessageLedger, type SessionBus } from "./session-bus.js";

/** `GET /session/:id/stream` — the SSE downstream. */
export const STREAM_PREFIX = "/session/";
export const STREAM_SUFFIX = "/stream";
/** `POST /session/:id/message` — the upstream. */
export const MESSAGE_SUFFIX = "/message";

/**
 * Heartbeat interval. SSE comment lines that keep the connection warm through
 * NAT and phone radios.
 *
 * This is what lets silence mean "still here". Without it a client cannot tell a
 * live-but-quiet session from a dead socket, and would have to guess — which is
 * exactly the inference `SessionEvent`'s contract forbids.
 */
export const HEARTBEAT_MS = 15_000;

/** Largest inbound message. Says the limit in the error rather than truncating. */
export const MAX_MESSAGE_CHARS = 32_000;

/** What the transport needs from the session it is carrying. */
export interface TransportSession {
  readonly bus: SessionBus;
  /**
   * Deliver a turn. MUST resolve only once the text has actually reached the
   * session — the acknowledgement means delivered, not accepted (ADR-0007 §3b,
   * and the `SessionEvent` contract note).
   */
  readonly deliver: (text: string) => Promise<void>;
  readonly projectDir: string;
}

export interface TransportOptions {
  /** Look up a session by id. `null` when the device asked for one that is not here. */
  readonly lookup: (sessionId: string) => TransportSession | null;
  readonly heartbeatMs?: number;
  readonly nowIso?: () => string;
}

/** Per-session idempotency ledgers, kept beside the transport rather than in it. */
const ledgers = new Map<string, MessageLedger>();

function ledgerFor(sessionId: string): MessageLedger {
  let ledger = ledgers.get(sessionId);
  if (ledger === undefined) {
    ledger = new MessageLedger();
    ledgers.set(sessionId, ledger);
  }
  return ledger;
}

/** Exposed so tests can start from a clean ledger without reaching into module state. */
export function resetLedgers(): void {
  ledgers.clear();
}

/** Parse `/session/<id>/stream` or `/session/<id>/message`. */
export function parseSessionPath(
  pathname: string,
): { readonly sessionId: string; readonly route: "stream" | "message" } | null {
  if (!pathname.startsWith(STREAM_PREFIX)) return null;
  const rest = pathname.slice(STREAM_PREFIX.length);
  if (rest.endsWith(STREAM_SUFFIX)) {
    const id = rest.slice(0, -STREAM_SUFFIX.length);
    return id === "" ? null : { sessionId: id, route: "stream" };
  }
  if (rest.endsWith(MESSAGE_SUFFIX)) {
    const id = rest.slice(0, -MESSAGE_SUFFIX.length);
    return id === "" ? null : { sessionId: id, route: "message" };
  }
  return null;
}

/** One SSE frame. `id:` is the cursor a client resumes from. */
export function sseFrame(event: SessionEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

/**
 * The `Last-Event-ID` cursor, from the header or the `?after=` query.
 *
 * Both, because the header is what `EventSource` sends automatically on its own
 * reconnect and the query is what a client controls explicitly. Ignoring either
 * would make one of those two clients silently restart from nothing.
 */
export function resumeCursor(req: IncomingMessage, url: URL): number {
  const header = req.headers["last-event-id"];
  const raw = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get("after") ?? "";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Attach a device to a session's stream. Never returns until the client goes away. */
export function handleStream(
  session: TransportSession,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: TransportOptions,
): void {
  const after = resumeCursor(req, url);

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    // Any intermediary that buffers an event stream turns "as it happens" into
    // "eventually", which is the one thing this transport exists to avoid.
    "x-accel-buffering": "no",
  });

  const write = (frame: string): boolean => {
    // `res.write` returns false when the kernel/socket buffer is full. That is
    // the backpressure signal SessionBus counts — see its subscriber policy.
    try {
      return res.write(frame);
    } catch {
      return false;
    }
  };

  const attach = session.bus.subscribe(
    {
      send: (event) => write(sseFrame(event)),
      close: (reason) => {
        write(
          sseFrame({
            type: "ended",
            seq: session.bus.cursor + 1,
            reason,
          } as SessionEvent),
        );
        res.end();
      },
    },
    after,
  );

  // `attached` first, before any replay, so the client knows what it is looking
  // at and — crucially — whether it has a GAP it must disclose.
  write(
    sseFrame({
      type: "attached",
      seq: 0,
      sessionId: session.bus.sessionId,
      resumedFrom: after,
      gap: attach.gap,
    } as SessionEvent),
  );
  for (const event of attach.replay) write(sseFrame(event));

  // A session that ended while the client was away must be told at once rather
  // than left to time out: silence never means "gone".
  const ended = session.bus.endedEvent;
  if (ended !== undefined) write(sseFrame(ended));

  const heartbeat = setInterval(() => {
    // An SSE comment: keeps the socket warm, carries no event, cannot be
    // mistaken for one.
    write(`: heartbeat ${options.nowIso?.() ?? new Date().toISOString()}\n\n`);
  }, options.heartbeatMs ?? HEARTBEAT_MS);
  // Do not hold the process open for a heartbeat.
  heartbeat.unref?.();

  const cleanup = (): void => {
    clearInterval(heartbeat);
    attach.detach();
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
}

/** Take a message from a device and deliver it — acknowledging only once it lands. */
export async function handleMessage(
  session: TransportSession,
  res: ServerResponse,
  body: string,
  deviceId: string,
  options: TransportOptions,
): Promise<void> {
  let parsed: { messageId?: unknown; text?: unknown };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    json(res, 400, { error: "expected a JSON body with `messageId` and `text`" });
    return;
  }
  const messageId = typeof parsed.messageId === "string" ? parsed.messageId : "";
  const text = typeof parsed.text === "string" ? parsed.text : "";
  if (messageId === "" || text === "") {
    json(res, 400, { error: "both `messageId` and `text` are required" });
    return;
  }
  if (text.length > MAX_MESSAGE_CHARS) {
    // Say the limit rather than truncating: a silently shortened instruction to
    // an agent is worse than a refused one.
    json(res, 413, {
      error: "message too long",
      limit: MAX_MESSAGE_CHARS,
      received: text.length,
    });
    return;
  }

  const ledger = ledgerFor(session.bus.sessionId);
  const already = ledger.lookup(messageId);
  if (already !== undefined) {
    // A retry after a dropped connection. Do NOT deliver again — a duplicated
    // instruction to an agent is not a duplicated packet.
    json(res, 200, {
      messageId,
      status: "duplicate",
      seq: already,
    } satisfies SessionMessageResponse);
    return;
  }

  // Invariant 4: attribution BEFORE delivery, and awaited. A turn nobody can
  // attribute must not run, so a failure to record is a failure to send.
  const ts = options.nowIso?.() ?? new Date().toISOString();
  try {
    await appendHostLog(session.projectDir, {
      kind: "turn",
      ts,
      sessionId: session.bus.sessionId,
      origin: deviceId,
      text,
    });
  } catch (err) {
    json(res, 500, {
      error: "could not record attribution, so the message was not delivered",
      detail: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  try {
    await session.deliver(text);
  } catch (err) {
    json(res, 502, {
      error: "the session did not accept the message",
      detail: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const seq = session.bus.cursor;
  ledger.record(messageId, seq);
  json(res, 200, { messageId, status: "delivered", seq } satisfies SessionMessageResponse);
}

/**
 * The handler R13.4's write server mounts. Everything reaching it has already
 * presented a device certificate and a live user factor.
 */
export function sessionTransportHandler(options: TransportOptions) {
  return async (request: {
    req: IncomingMessage;
    res: ServerResponse;
    device: { id: string };
    body: string;
  }): Promise<void> => {
    const url = new URL(request.req.url ?? "/", "https://localhost");
    const route = parseSessionPath(url.pathname);
    if (route === null) {
      json(request.res, 404, { error: "not found" });
      return;
    }
    const session = options.lookup(route.sessionId);
    if (session === null) {
      json(request.res, 404, {
        error: "no such hosted session",
        message: "It may have ended. `golem session host list` shows what is running.",
      });
      return;
    }
    if (route.route === "stream") {
      if (request.req.method !== "GET") {
        json(request.res, 405, { error: "method not allowed" });
        return;
      }
      handleStream(session, request.req, request.res, url, options);
      return;
    }
    if (request.req.method !== "POST") {
      json(request.res, 405, { error: "method not allowed" });
      return;
    }
    await handleMessage(session, request.res, request.body, request.device.id, options);
  };
}
