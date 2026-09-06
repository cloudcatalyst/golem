/**
 * The one-request loopback redirect listener (RFC 8252 §7.3).
 *
 * Three details decide whether this works on a real machine, and all three are
 * the kind that fail confusingly rather than loudly:
 *
 * 1. **Bind `127.0.0.1`, never `localhost`.** `localhost` can resolve to IPv6
 *    `::1`, and the browser then arrives at a redirect URI that is not the one
 *    registered with the authorization server. The literal is used for the bind
 *    address AND for the `redirect_uri` string, so the two cannot drift.
 * 2. **The port is chosen at runtime.** Port `0` asks the OS for an ephemeral
 *    one. The client is registered with the loopback host and NO port, per
 *    RFC 8252 §7.3, precisely so a machine where some pinned port is already
 *    taken still works.
 * 3. **`state` is verified here, at the boundary.** A request whose `state` is
 *    not the one that went out is answered with a refusal page and settles the
 *    wait as a failure — the code it carries is never exchanged. Verifying later,
 *    in the orchestrator, would mean a tampered request had already been treated
 *    as the answer.
 *
 * The listener answers exactly one *callback* request. Anything else on the
 * socket (a favicon fetch, a probe, a stray path) gets a 404 and does not settle
 * the wait, so a browser's automatic requests cannot consume the one shot.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { PortalAuthError } from "./errors.js";

/** The only host this listener ever binds. See the module doc. */
export const LOOPBACK_HOST = "127.0.0.1";
/** The only path treated as the redirect target. */
export const CALLBACK_PATH = "/callback";

export interface LoopbackListener {
  /** `http://127.0.0.1:<port>/callback` — send this as `redirect_uri`. */
  readonly redirectUri: string;
  /** The port the OS handed out. */
  readonly port: number;
  /**
   * Resolve with the authorization code once a valid callback arrives.
   * Rejects on `error=`, on a `state` mismatch, and on the deadline.
   */
  waitForCode(): Promise<string>;
  /** Idempotent. Safe to call in a `finally`. */
  close(): Promise<void>;
}

export interface LoopbackOptions {
  /** The `state` that went out. A callback carrying anything else is refused. */
  readonly expectedState: string;
  /** How long to wait for the user to finish in the browser. Default 5 min. */
  readonly timeoutMs?: number;
  /** Compare `state` in constant time. Injected so pkce.ts owns the primitive. */
  readonly statesMatch: (expected: string, received: string) => boolean;
}

function page(title: string, body: string): string {
  // Deliberately dependency-free and inline-styled: this renders in a browser
  // that has no access to anything the harness ships.
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>Golem</title></head>" +
    '<body style="font:16px/1.5 system-ui,sans-serif;margin:4rem auto;max-width:34rem;padding:0 1rem">' +
    `<h1 style="font-size:1.3rem">${title}</h1><p>${body}</p>` +
    "</body></html>"
  );
}

function respond(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    // Without this the browser may hold the socket open and `close()` hangs
    // until the OS times it out — which reads as "golem team link froze".
    connection: "close",
    // A redirect URL carrying an authorization code must not sit in a cache.
    "cache-control": "no-store",
  });
  res.end(html);
}

/**
 * Bind an ephemeral loopback port and start listening for the redirect.
 *
 * Resolves once the socket is actually bound, so the caller can build the
 * authorization URL from a `redirect_uri` that is already live — opening the
 * browser first would race the listener.
 */
export async function startLoopbackListener(options: LoopbackOptions): Promise<LoopbackListener> {
  const timeoutMs = options.timeoutMs ?? 300_000;

  let settle: ((outcome: { code: string } | { error: PortalAuthError }) => void) | null = null;
  let settled: { code: string } | { error: PortalAuthError } | null = null;

  /** Records the outcome even if nobody is awaiting yet. */
  function finish(outcome: { code: string } | { error: PortalAuthError }): void {
    if (settled !== null) return;
    settled = outcome;
    settle?.(outcome);
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`);
    if (url.pathname !== CALLBACK_PATH) {
      respond(res, 404, page("Not this page", "Golem is waiting on its sign-in callback."));
      return;
    }
    if (settled !== null) {
      respond(res, 409, page("Already handled", "This sign-in has already been completed."));
      return;
    }

    const error = url.searchParams.get("error");
    if (error !== null) {
      const description = url.searchParams.get("error_description");
      respond(
        res,
        400,
        page("Sign-in was not completed", "You can close this window and return to the terminal."),
      );
      finish({
        error: new PortalAuthError(
          "authorization_denied",
          `the portal refused the sign-in: ${description === null ? error : `${error}: ${description}`}`,
        ),
      });
      return;
    }

    const state = url.searchParams.get("state");
    if (state === null || !options.statesMatch(options.expectedState, state)) {
      respond(
        res,
        400,
        page(
          "That request did not come from Golem",
          "The single-use <code>state</code> did not match, so the sign-in was refused. " +
            "Nothing was stored. Run <code>golem team link</code> again.",
        ),
      );
      finish({
        error: new PortalAuthError(
          "state_mismatch",
          "the sign-in callback carried a `state` Golem did not issue, so it was refused " +
            "and no authorization code was exchanged. Run `golem team link` again.",
        ),
      });
      return;
    }

    const code = url.searchParams.get("code");
    if (code === null || code === "") {
      respond(res, 400, page("Sign-in was not completed", "No authorization code came back."));
      finish({
        error: new PortalAuthError(
          "authorization_denied",
          "the sign-in callback carried no authorization code",
        ),
      });
      return;
    }

    respond(
      res,
      200,
      page("Golem is linked", "You can close this window and return to the terminal."),
    );
    finish({ code });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: LOOPBACK_HOST, port: 0 }, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new PortalAuthError(
      "no_browser",
      `could not determine the loopback port after binding ${LOOPBACK_HOST}`,
    );
  }
  const port = address.port;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return {
    redirectUri: `http://${LOOPBACK_HOST}:${port}${CALLBACK_PATH}`,
    port,
    waitForCode: () =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          finish({
            error: new PortalAuthError(
              "timed_out",
              `no sign-in came back within ${Math.round(timeoutMs / 1000)}s. ` +
                "Golem stopped listening; nothing was stored.",
            ),
          });
        }, timeoutMs);
        // Never hold the process open on the deadline alone.
        timer.unref?.();

        settle = (outcome) => {
          clearTimeout(timer);
          if ("code" in outcome) resolve(outcome.code);
          else reject(outcome.error);
        };
        if (settled !== null) settle(settled);
      }),
    close,
  };
}
