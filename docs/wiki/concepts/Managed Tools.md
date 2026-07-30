---
title: Managed Tools
type: concept
tags: [dependencies, policy, ext, headroom, caveman, rtk, ollama]
sources: [src/ext/manifest.ts, src/ext/detect.ts, src/ext/status.ts, src/cli/ext.ts, docs/golem-spec.md, docs/plan/verification-notes.md]
created: 2026-07-30
updated: 2026-07-30
---

# Managed tools — spawned or detected, never shipped

Golem integrates external tools without redistributing them. Spec **Decision 53**
writes down the policy three integrations had already converged on
([[Compression]]'s Headroom sidecar, the Ollama local tier, and Decision 52's
Caveman interop), and `golem ext` makes it inspectable.

## The invariant is not "no binaries"

CLAUDE.md's "no heavyweight native deps in the default install" is the symptom.
The rule underneath it is four things:

1. `npx golem-run init` works on all three OSes with no toolchain.
2. Every external thing is **opt-in, off by default, and degrades to a no-op** —
   never an error path.
3. **Exact pins, one quarantine adapter file, never in `dependencies`.**
4. **Golem distributes no third-party bytes** — nothing to audit, no licence to
   relay.

So a prebuilt binary is fine as a *spawn target* and forbidden as *cargo*. That
is why RTK (Apache-2.0, Rust) is a legitimate peer and still must never be
vendored.

## The ladder

| Tier | Mechanism | Examples | Ships their bytes? |
|---|---|---|---|
| 1 | npm `dependencies` — pure JS, no native build, deliberately tiny | the 5 runtime deps | yes |
| **2** | Spawn or resolve a pinned tool the user provides; off by default; one adapter | Headroom (`uv run --with headroom-ai==0.30.0`), Ollama, `unpdf`, `web-tree-sitter` | **no** |
| **3a** | Detect a peer and interoperate or defer | Caveman's marker, RTK's hook | **no** |
| **3b** | Re-implement the idea as Golem's own data, cite the source, copy nothing | Decision 52's brevity profiles | **no** |

## Three shapes — only one of them is "wrap"

Conflating these is what made "should we fold it in?" hard to answer.

- **Callable service** — Golem invokes it, so it can be fully managed
  (install, pin, spawn, health, upgrade). Headroom, Ollama, language servers.
  *Upstream features only flow in for free if the adapter is a passthrough* —
  see the worker-script caveat below.
- **Peer injector** — acts on the same surface independently. Coordinate; never
  drive. Caveman, RTK.
- **In-process seam** — runs *inside* the redaction path, so a different trust
  model applies. `unpdf`, `web-tree-sitter`, and future plugins.

## Admission bar

All four, or it does not get a row:

1. It does something Golem should not reimplement.
2. Stable, pinnable invocation contract.
3. Absence degrades to a no-op.
4. Golem ships none of its bytes.

**The Caveman speech skill deliberately fails criterion 1** (verification-notes
§87): its own README puts input tokens saved at **0%** and adds ~1–1.5k input
tokens per turn, its installer targets one agent's skill directory, and there is
no API — the skill *is* a prompt. A proxy injecting the same directive in-flight,
for every client, with zero dependencies, is strictly better. Golem detects it
only so the two never stack. Its two adjacent components (`/caveman-compress`,
`caveman-shrink`) *do* qualify and are tracked as follow-ups.

## `golem ext`

```
golem ext                # list every row: tier, installed?, on?, what breaks without it
golem ext --verbose      # + purpose, install steps, upstream, licence, adapter
golem ext --json         # machine-readable
```

Two deliberate properties:

- **Spawn-free detection.** A `PATH` walk plus `require.resolve`, so the surface
  costs `stat` calls rather than a process per row (Decision 51 made startup a
  standing constraint). `PATHEXT`-aware on Windows, because an npm-installed CLI
  is a `.cmd` shim there — a bare-filename check reports "not installed" for a
  tool that is plainly present.
- **It refuses to claim "running".** For the Headroom sidecars "running" is a
  transient — they are spawned per use. Instead each row carries a `gate` note
  explaining why *enabled* may still mean *idle*.

That last point is the reason the surface exists. In this repo
`compression.headroom_sidecar = true` and `uv` is installed, yet the sidecar has
**never started**: the lossy semantic stage is its only caller, and that stage is
gated off on caching upstreams (Decision 31, see [[Slider Levels]]) unless
`compression.force_semantic_on_caching` is set. A surface that printed "enabled"
and stopped would have been the dishonest kind.

## Gotcha: a pin is not a passthrough

`headroom-worker.py` is authored by Golem, so **it** — not the version pin —
defines which upstream APIs are reachable. Bumping the pin does not bring new
Headroom features; the worker has to be edited. Any tier-2 adapter that wants
upstream features to arrive for free must forward an opaque options bag and
version-gate, rather than hand-enumerate an API surface.

## Related

- [[Compression]] — the Headroom sidecar's only caller, and why it stays idle
- [[Slider Levels]] — the gate that makes "enabled" not mean "running"
- [[Configuration Surfaces]] — where `enabledBy` settings are rendered and written
- [[Dogfooding Golem]] — the local setup these rows describe
- [[Architecture]] — where the adapters sit in the pipeline
