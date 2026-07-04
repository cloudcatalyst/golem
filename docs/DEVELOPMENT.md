# Developing Golem while using Golem

Dogfooding Golem means the proxy that carries your Claude Code traffic is the
same software you're changing. To avoid a dev bug or a rebuild breaking your
live session, run **two proxies**: a frozen **stable** one you actually use, and
a throwaway **dev** one you test against.

## The split

| | Stable | Dev |
|---|---|---|
| Build | frozen global install (`npm i -g golem-run-*.tgz`) — a real copy, unaffected by `npm run build` | the repo's `dist/` (changes every build) |
| Run | `golem proxy` (resolves to the global binary) | `node dist/cli/main.js proxy --port 4655` |
| Port | **4653** (what `golem init` writes to `ANTHROPIC_BASE_URL`) | **4655** (never in your session's path) |
| Who runs it | **you**, in your own terminal (persists across agent sessions) | the agent, transiently, only while testing |
| Dashboard | `golem dashboard` → 4654 | — |

Your Claude Code session's `ANTHROPIC_BASE_URL` points only ever at **4653**.
Because stable is a frozen copy, rebuilding the repo — or a crash in dev code —
cannot affect it.

## Running stable persistently

Background processes an agent starts die when its session is torn down (we hit
this repeatedly). For a stable proxy that survives, **run it yourself** in a
dedicated terminal:

```sh
golem proxy            # frozen global build, binds 4653
# optionally, in another terminal:
golem dashboard        # savings UI on 4654
```

Leave that terminal open. Your editor sessions can come and go; the proxy stays
up. To confirm it's alive: `golem status` (shows "Proxy: … reachable").

## Testing dev changes (agent workflow)

Never rebuild onto 4653. Test the working tree on 4655:

```sh
npm run build
node dist/cli/main.js proxy --port 4655 --dir /tmp/somewhere   # transient
# drive traffic at 4655, verify, then stop it
```

Unit/integration tests (`npx vitest run`) don't touch either running proxy —
prefer them; only use a live dev proxy for true end-to-end checks.

## Promoting dev → stable

When a change is committed, tested, and you want it in your live proxy:

```sh
npm run build
npm pack                      # -> golem-run-<version>.tgz
npm install -g ./golem-run-*.tgz
# restart your stable `golem proxy` terminal to pick up the new binary
```

That is the *only* moment your live proxy changes — deliberately, not as a side
effect of development.

## Escape hatch

If stable ever misbehaves: remove `ANTHROPIC_BASE_URL` from
`.claude/settings.json` and reopen the editor → straight back to the direct API.
The proxy also honors an `x-golem-bypass` header for per-request passthrough,
and fails open (a pipeline error forwards the original request unchanged rather
than breaking the session).
