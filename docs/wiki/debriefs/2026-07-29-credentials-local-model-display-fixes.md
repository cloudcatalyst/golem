---
title: 2026-07-29 — Env-key removal, `golem local`, and two stale-display fixes
type: debrief
tags: [credentials, accounts, local-model, statusline, vscode-extension, Decision-46, Decision-47, ADR-0003]
sources: [src/credentials/, src/cli/accounts.ts, src/cli/local-config.ts, src/proxy/served-model.ts, vscode-extension/render.js, docs/decisions/ADR-0003-credential-storage-and-account-routing.md]
created: 2026-07-29
updated: 2026-07-29
---

# 2026-07-29 — Env-key removal, `golem local`, and two stale-display fixes

Five maintainer-reported items, landed together. Two are credential/account
correctness, one is a new CLI surface, two are display bugs where a surface
confidently reported something that was no longer true.

## 1. `golem account remove` logs out first

De-registering an account left its secret in the OS credential store, reachable
by no command — the store id is derived from the registry entry that had just
vanished — and remembered by nobody. A credential with no account is pure
liability.

`removeAccount` now runs the same `forget` as `account logout`, **before** it
edits the registry. That ordering is load-bearing, and it is the reason the
fail-closed check has to come first too: an unknown id must delete nothing.
`--keep-credential` is the escape hatch for re-adding the same account shortly
after. Both the `logout` and the `remove` land in the audit log.

## 2. Environment variables are no longer a credential mechanism (Decision 47)

[[2026-07-26 — Golem-managed credentials]] deliberately kept `env` at the *head*
of the resolution chain "so CI, containers, and scripted setups are untouched".
That was the wrong trade. Nobody set keys that way once `golem account login`
existed, and keeping env *above* the OS store meant a stale export in one shell
could silently shadow a correctly-stored key — a fresh instance of the exact bug
class Decision 46 was written to kill.

The chain is now **keychain → file**. Removed with the backend: the `env`
`CredentialBackendId`, the `process-env` `CredentialProtection`,
`AccountRow.key_env`, `CredentialStoreOptions.env`, and `logoutAccount`'s
`env_note` — "this var is still set and I can't unset it" is now unreachable,
because a logout is *complete*. Every `export GOLEM_UPSTREAM_API_KEY…`
remediation is gone from help text, `account list`, the `use` preflight, the
proxy's startup warnings, and the `/golem/upstream` skill; following that advice
would now configure nothing.

**The var name survives as an internal transport, and only that.** The original
ADR-0003 reasoning is unchanged: every OS store is weakest for exactly the
detached, session-less daemon that needs the key. So the CLI still resolves the
secret and injects it at spawn. What changed is that this is no longer *also* a
user-facing input — `credentialEnvForProxy` sources the value from the store,
never from an ambient var.

Two consequences worth recording, because both were gaps the removal opened:

- **Non-interactive setup.** With no env path and a prompt that needs a TTY, a
  headless machine could not set a key at all. `golem account login <id>` now
  reads the key from **stdin** when stdin is not a TTY
  (`echo "<key>" | golem account login kimi`) — still never through argv. This
  is the CI story in place of an exported var.
- **Foreground `golem proxy start`.** It leaned on the ambient env, so it would
  have run keyless. It now performs the same store resolve the detached path
  does, assigning with `??=` so a value the parent CLI already injected wins and
  the daemon never has to reach a keychain itself.

The non-secret `GOLEM_<SECTION>_<KEY>` settings overrides are untouched — this
is about *keys* only.

A side benefit: `collectAccounts`/`useAccount`/`credentialEnvForProxy` gained an
injectable `store_backend`, which is what finally lets the account tests stop
touching the machine's real keychain (they used to lean on env vars for
determinism — the very thing being removed).

See `docs/decisions/ADR-0003-credential-storage-and-account-routing.md` (second amendment) and
spec Decision 47.

## 3. `golem local` — enable/disable and configure the local/LAN model

The two levers that decide whether Golem is a local+upstream hybrid already
existed as settings; there was no one place to see or set them.

- `golem local status` (the default subcommand) — enabled/disabled, the endpoint
  and whether it answers, hardware tier, coder model, and **why** it is inactive
  when it is.
- `golem local enable` / `golem local disable` — `inference.local_coder_enabled`.
- `golem local url <url>` — `inference.ollama_base_url`, i.e. the LAN-offload
  switch. It probes the new endpoint and **reports** the verdict rather than
  refusing: a config command that won't let you pre-configure a machine you will
  boot later is worse than one that saves and tells you the truth. A bare
  `host:port` is diagnosed as a missing scheme, because `new URL("gpubox:11434")`
  parses and "unsupported scheme gpubox:" is a baffling answer to a missing
  `http://`.

Deliberately a thin front end over `golem config` — no new settings semantics, so
anything it does can still be done and undone with `golem config set`.
`golem coder enable|disable|status` is kept as an alias.

## 4. The VS Code status bar showed a local model that was turned off

With Ollama running and `inference.local_coder_enabled` false, the status bar
still read `→ local (Qwen 2.5) + anthropic (…)`, advertising a hybrid Golem was
not offering. The CLI statusline already gated on both conditions
(`localCoderEnabled === false || localModelReachable !== true`); the extension
gated on reachability alone.

`buildModel` now derives `localCoderEnabled` (from `status.local_model.coder_enabled`,
defaulting true for an older CLI) and `localModelActive` = reachable AND enabled.
The status bar, the hover, and the panel's Inference row all key off `active`;
`localModelReachable` stays on the model and stays honest, because "Ollama is up"
and "Golem is using it" are different facts. The disabled case is called out
rather than silently omitted (`Local: disabled (golem local enable)`), so the
hover explains the absence.

The file watcher also now includes `.golem/settings.local.json`, so a change made
with `--scope local` — or the slider/account selection that Decision 43 moved
there — repaints without waiting for the poll.

## 5. Changing upstream showed the previous model's name

`.golem/state/served-model.json` records what the proxy last served, and every
display surface read it unconditionally. After `golem account use <other>` the
snapshot still described the account just left, so `status`, the statusline, and
the extension all reported the **previous** model as current until the new
upstream happened to serve a request.

Two-part fix, because either alone leaves a hole:

- The snapshot now carries the `accountId` it was served under, and surfaces read
  it through `servedModelFor(dir, activeAccountId)` — a mismatch returns `null`
  and the surface falls back to the configured `upstream_model`. This covers a
  settings file edited by hand, not just a switch through the CLI. A legacy
  snapshot with no `accountId` is accepted only when the top-level config is
  active: the case it was almost certainly written under, and where being wrong
  matters least.
- `useAccount` also clears the snapshot outright, so the change is immediate
  rather than merely not-wrong. Best-effort — a switch must not fail over a
  display cache.

## Verification

`tsc --noEmit` clean, Biome clean (one pre-existing `useOptionalChain` warning in
`src/proxy/server.ts`), 1441 vitest tests, and 37 extension tests via
`node --test`.

**Pre-existing flake, not from this work:** `tests/integration/cli-init.test.ts`
intermittently fails 1–2 tests under full-suite load on Windows — either a 5 s
timeout or `ENOTEMPTY: directory not empty, rmdir …\.claude` from temp-dir
cleanup. Confirmed by stashing this branch and reproducing at `main`. The file
passes in isolation (~5.6 s).

Related: [[2026-07-26 — Golem-managed credentials]],
[[R6.2 v1 — account switching (multi-account/provider selection)]],
`docs/decisions/ADR-0003-credential-storage-and-account-routing.md`.
