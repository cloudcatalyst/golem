---
title: 2026-07-26 — Golem-managed credentials
type: debrief
tags: [credentials, accounts, proxy, security, ADR-0003, Decision-46]
sources: [src/credentials/, src/cli/accounts.ts, src/cli/proxy-daemon.ts, docs/decisions/ADR-0003-credential-storage-and-account-routing.md]
created: 2026-07-26
updated: 2026-07-26
---

# 2026-07-26 — Golem-managed credentials

## What shipped
A Golem-managed credential store, so an upstream API key no longer lives only in
whichever shell happened to start the proxy. Trigger: a real failure — after
switching to a Kimi account, every *new* terminal reported "key missing",
because a per-account `GOLEM_UPSTREAM_API_KEY__<ID>` had only ever been exported
in one shell.

- **`src/credentials/`** — the resolution chain (first hit wins; **env stays
  first**, so CI/containers/scripts are untouched):
  1. `env` — the existing per-account var (plain `GOLEM_UPSTREAM_API_KEY` for
     the default top-level config).
  2. `keychain` — the platform's OS-backed store with **no native dependency**
     (per CLAUDE.md): macOS `security`, Linux `secret-tool`, Windows **DPAPI**
     via a *detected* PowerShell host.
  3. `file` — plaintext 0600, **never auto-selected**; an explicit
     `--store file` opt-in for headless machines, labelled honestly unencrypted.
- **CLI owns credentials; the daemon never touches the store.** The interactive
  CLI resolves (env → OS store) and injects the secret into the detached
  daemon's environment at spawn via `buildSpawnEnv` — a minimal allowlist, not
  the whole shell env. Every OS keychain is weakest for exactly a detached,
  session-less daemon, so this sidesteps the class *and* removes the "works in
  one terminal, not another" trap.
- **New surfaces:** `golem account login <id>` (masked prompt → **live-verify
  the key against the upstream** with a cheap read-only probe → store only if
  accepted), `golem account logout <id>`, a **fail-closed credential preflight**
  in `golem account use <id>` (`--yes` overrides), and key location/strength in
  `golem account list` (never the value).
- **Honesty rules:** surfaces name the backend and its real strength (a DPAPI
  blob is never called "Credential Manager"; a 0600 file is never called
  "encrypted"); secrets never appear in argv (writes use stdin), logs, or errors.

## The verification that gated it (§82)
ADR-0003 invariant 2 had *deferred* any OS-keychain backend pending exactly this
check. What it found:

- **No readable Windows Credential Manager without a native module** —
  `cmdkey /list` never returns the password; WinRT `PasswordVault` won't load in
  PowerShell 7. So Windows uses DPAPI (an encrypted *file*, user+machine-bound),
  and is labelled as such, never "Credential Manager".
- **DPAPI's PowerShell host is machine-dependent.** Under a Node spawn, the
  inbox `powershell.exe` (5.1) could not autoload its Security module on the
  reference machine (`CommandNotFoundException`; `Import-Module` then failed on
  TypeData duplication), while `pwsh` (PS7) worked. So the backend **detects** a
  working host with a real encrypt→decrypt self-test and throws a *remediable*
  error when none exists — never silent plaintext, never a raw PowerShell
  diagnostic.

## Decisions / notes
- **Spec Decision 46**, amending **ADR-0003 invariant 2**; all other invariants
  stand (no secrets in settings; no silent fallback; no MCP surface touches
  credentials — `src/credentials/` is CLI-only; audited to the existing
  `account-log.jsonl`).
- The **coder-first gate** fired; the local model timed out twice (once with
  `refine`, once without) on a module this size, so the code was hand-written —
  noted per the rule rather than skipped silently.
- A subtle pre-existing-file divergence: `accounts.ts`, `proxy-daemon.ts`, and
  `main.ts` had been refactored since the last read (CCR flagged stale reads);
  the integration rewrote `accounts.ts` against the *current* structure (default
  account id = provider name, `writeSetting` leaf semantics, `loadConfig({env})`)
  rather than the snapshot.
- Full-suite runs initially showed init/slider/status failures — confirmed as
  **resource contention** (my DPAPI self-test spawns PowerShell), not
  regressions: those suites pass in isolation in my tree and on a clean `HEAD`
  worktree, and the full suite is green at `--maxWorkers=4`.

## Verified
`tsc --noEmit`, `biome check`, `biome format` clean; `vitest run` **1361
passed**. Live on this machine: stored → resolved from DPAPI in a fresh process
→ `account list` showed the honest location → `account use` passed preflight →
`account logout` removed it. Proxy restarted on the new build. PR #57.

Related: [[Architecture]] (the proxy daemon the credential is injected into),
[[Dogfooding Golem]] (this repo runs the proxy it ships — the bug this fixes was
hit dogfooding).
