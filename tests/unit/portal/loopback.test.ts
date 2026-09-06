/**
 * The loopback listener, exercised against a REAL socket and real HTTP requests.
 *
 * This one is deliberately not mocked. Everything it has to get right —
 * binding `127.0.0.1` rather than a name that might resolve to `::1`, taking an
 * ephemeral port, answering exactly one callback, closing cleanly on Windows
 * where a kept-alive socket will hold `close()` open — is a property of the real
 * `node:http` server, and a fake would assert the design instead of the code.
 *
 * The tampered-`state` case is one of this task's gate items.
 */

import { describe, expect, it } from "vitest";
import {
  CALLBACK_PATH,
  LOOPBACK_HOST,
  type LoopbackListener,
  startLoopbackListener,
  statesMatch,
} from "../../../src/portal/index.js";

const STATE = "the-state-that-went-out";

async function listener(timeoutMs = 5_000): Promise<LoopbackListener> {
  return startLoopbackListener({ expectedState: STATE, statesMatch, timeoutMs });
}

/**
 * Capture the wait's outcome with a handler attached SYNCHRONOUSLY.
 *
 * The listener can settle while the test is suspended on its own `fetch`, and a
 * promise that rejects before anything is awaiting it is an unhandled rejection
 * even though the very next line awaits it. That is a property of the test's
 * shape, not of the listener: `linkPortal` awaits `waitForCode()` immediately.
 */
function outcomeOf(pending: Promise<string>): Promise<{ code: string } | { error: unknown }> {
  return pending.then(
    (code) => ({ code }),
    (error: unknown) => ({ error }),
  );
}

/** Hit the listener the way a browser would, following no redirects. */
async function callback(l: LoopbackListener, query: string): Promise<Response> {
  return fetch(`http://${LOOPBACK_HOST}:${l.port}${CALLBACK_PATH}?${query}`);
}

describe("startLoopbackListener", () => {
  it("binds 127.0.0.1 on an ephemeral port and advertises a matching redirect URI", async () => {
    const l = await listener();
    try {
      expect(l.port).toBeGreaterThan(0);
      // The literal, not `localhost`: the latter can resolve to ::1 and mismatch
      // the registered redirect URI.
      expect(l.redirectUri).toBe(`http://127.0.0.1:${l.port}/callback`);
      expect(l.redirectUri).not.toContain("localhost");
    } finally {
      await l.close();
    }
  });

  it("hands back the authorization code when state matches", async () => {
    const l = await listener();
    try {
      const waiting = l.waitForCode();
      const response = await callback(l, `code=auth-code-1&state=${encodeURIComponent(STATE)}`);
      expect(response.status).toBe(200);
      await expect(waiting).resolves.toBe("auth-code-1");
    } finally {
      await l.close();
    }
  });

  it("REJECTS a tampered state, and never yields the code it carried", async () => {
    const l = await listener();
    try {
      const outcome = outcomeOf(l.waitForCode());
      const response = await callback(l, "code=attacker-code&state=not-the-right-state");
      expect(response.status).toBe(400);
      const settled = await outcome;
      expect(settled).toMatchObject({ error: { kind: "state_mismatch" } });
      // The point of the check: the code that arrived alongside the bad state is
      // never returned to the caller, so it is never exchanged for a token.
      expect(settled).not.toHaveProperty("code");
      expect(String((settled as { error: Error }).error.message)).not.toContain("attacker-code");
    } finally {
      await l.close();
    }
  });

  it("rejects a callback with no state at all", async () => {
    const l = await listener();
    try {
      const outcome = outcomeOf(l.waitForCode());
      const response = await callback(l, "code=auth-code-1");
      expect(response.status).toBe(400);
      expect(await outcome).toMatchObject({ error: { kind: "state_mismatch" } });
    } finally {
      await l.close();
    }
  });

  it("surfaces an OAuth error redirect as authorization_denied", async () => {
    const l = await listener();
    try {
      const outcome = outcomeOf(l.waitForCode());
      const response = await callback(
        l,
        `error=access_denied&error_description=User%20said%20no&state=${encodeURIComponent(STATE)}`,
      );
      expect(response.status).toBe(400);
      expect(await outcome).toMatchObject({ error: { kind: "authorization_denied" } });
    } finally {
      await l.close();
    }
  });

  it("rejects a callback that carries a matching state but no code", async () => {
    const l = await listener();
    try {
      const outcome = outcomeOf(l.waitForCode());
      await callback(l, `state=${encodeURIComponent(STATE)}`);
      expect(await outcome).toMatchObject({ error: { kind: "authorization_denied" } });
    } finally {
      await l.close();
    }
  });

  it("does not spend its one shot on a stray request", async () => {
    const l = await listener();
    try {
      const waiting = l.waitForCode();
      // A browser fetches this unprompted; consuming the wait with it would
      // make the flow fail on some browsers and not others.
      const favicon = await fetch(`http://${LOOPBACK_HOST}:${l.port}/favicon.ico`);
      expect(favicon.status).toBe(404);
      const response = await callback(l, `code=auth-code-2&state=${encodeURIComponent(STATE)}`);
      expect(response.status).toBe(200);
      await expect(waiting).resolves.toBe("auth-code-2");
    } finally {
      await l.close();
    }
  });

  it("answers a second callback with 409 rather than re-settling", async () => {
    const l = await listener();
    try {
      const waiting = l.waitForCode();
      await callback(l, `code=first&state=${encodeURIComponent(STATE)}`);
      await expect(waiting).resolves.toBe("first");
      const second = await callback(l, `code=second&state=${encodeURIComponent(STATE)}`);
      expect(second.status).toBe(409);
    } finally {
      await l.close();
    }
  });

  it("times out rather than waiting forever, and says nothing was stored", async () => {
    const l = await listener(60);
    try {
      await expect(l.waitForCode()).rejects.toMatchObject({ kind: "timed_out" });
    } finally {
      await l.close();
    }
  });

  it("closes idempotently, so a `finally` cannot make things worse", async () => {
    const l = await listener();
    await l.close();
    await expect(l.close()).resolves.toBeUndefined();
    // The port really is released.
    await expect(fetch(`http://${LOOPBACK_HOST}:${l.port}${CALLBACK_PATH}`)).rejects.toThrow();
  });
});
