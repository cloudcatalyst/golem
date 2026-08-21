---
title: Managed Tools
type: concept
tags: [dependencies, policy, pkg, ext, headroom, caveman, rtk, ollama]
sources: [src/pkg/manifest.ts, src/pkg/detect.ts, src/pkg/status.ts, src/pkg/install.ts, src/cli/pkg.ts, docs/golem-spec.md, docs/plan/verification-notes.md]
created: 2026-07-30
updated: 2026-08-21
---

# Managed tools — spawned or detected, never shipped

Golem integrates external tools without redistributing them. Spec **Decision 53**
writes down the policy three integrations had already converged on
([[Compression]]'s Headroom sidecar, the Ollama local tier, and Decision 52's
Caveman interop), and `golem pkg` makes it inspectable — and, since R8.14,
actionable without ever carrying a byte of it.

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

## `golem pkg`

The surface was named `golem ext` when Decision 53 landed; R10.1 renamed the module
to `src/pkg/` and the command to `golem pkg`, keeping `ext` as an alias.

```
golem pkg                       # list every row: tier, installed?, on?, what breaks without it
golem pkg --verbose             # + purpose, install steps, upstream, licence, adapter
golem pkg --json                # machine-readable
golem pkg install <id> [--yes]  # invoke the UPSTREAM's installer, with consent (R8.14)
golem pkg remove  <id> [--yes]
golem pkg upgrade <id> [--yes]  # converge on the pin; never move past it
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
gated off on caching upstreams (Decision 31, see [[Compression Levels]]) unless
`compression.force_semantic_on_caching` is set. A surface that printed "enabled"
and stopped would have been the dishonest kind.

## A pin is not a passthrough (and how Headroom was fixed)

`headroom-worker.py` is authored by Golem, so **it** — not the version pin —
defines which upstream APIs are reachable. It used to hand-enumerate exactly two
`CompressConfig` fields, which made every other Headroom option unreachable
without editing that file. Bumping the pin would not have helped.

The worker now **introspects** the installed `CompressConfig` and forwards an
opaque bag from `compression.headroom_config`, layered *over* Golem's per-mode
presets:

```jsonc
// .golem/settings.json — any key the installed Headroom accepts
{ "compression": { "headroom_sidecar": true, "headroom_config": { "kompress_model": "…" } } }
```

Three honesty properties, because a passthrough that hides its failures is worse
than an enumeration:

- **Unsupported keys are reported, not forwarded** (`config_ignored`) — forwarding
  would raise inside `CompressConfig` and cost the whole request.
- **A supported name with an unusable value degrades to the mode preset**, so a
  bad override costs the override, not the stage.
- **`/health` returns `supported_config`** — capability read from the running
  package, not inferred from a pin. The adapter warns once per distinct
  ignored-key set, so a typo is visible instead of silently doing nothing.

**The general rule for any tier-2 adapter:** forward an opaque options bag and
version-gate on what the installed package reports. Do not hand-enumerate an API
surface you do not own.

## Coexisting with a peer that rewrites your input (R8.12)

A tier-3a peer acting on the same surface can change what Golem's own logic reads.
RTK rewrites `vitest` into `rtk vitest` via its `PreToolUse` hook, and that turned
up a real degradation (§96):

- Golem's autonomy **deny**-lists are word-boundary anchored, so they saw straight
  through the wrapper — `rtk git push` was still `outward`. Safe by luck.
- Golem's **allow**-list was start-anchored, so `rtk vitest` stopped matching and
  fell through to `unknown` → a prompt. Fail-closed, so never unsafe, but a user
  whose auto-approvals suddenly start asking tends to loosen the autonomy level.
  A safety mechanism disabled out of irritation is a safety problem.

Fixed by retrying **only the allow-list** against the unwrapped command, so
unwrapping can never downgrade a classification. Also fixed: Golem's oversized-output
swap now preserves an external compactor's own `[full output: …]` recovery pointer
rather than eliding it — a compaction of a compaction must not destroy the other
tool's way back.

**The general rule.** When admitting a peer that mutates tool arguments, audit every
pattern that matters for whether its anchoring survives the rewrite.
Start-anchored allow-lists are the fragile ones.

Still open: what Claude Code does when a rewriting hook and a denying hook fire on
the same call is **undocumented** (§91). Golem never emits `updatedInput`, so it
cannot itself conflict; treat the combination as unverified.

## The write half is mostly refusals (R8.14)

`install` / `remove` / `upgrade` shipped a year of caution and about three
recipes. That ratio is the design, not an unfinished edge.

**A recipe is an argument array naming an installer you already have.** No
vendoring, no mirror, no auto-download on first use. `planPkgAction` is *pure* —
it decides what would happen without spawning anything, which is what makes the
whole refusal matrix unit-testable and lets `--dry-run` show you the exact argv
before you agree to it. Only two rows have a recipe: `caveman` (via `claude
plugin`) and `typescript-language-server` (via global `npm`). `uv`, `ollama` and
`rtk` stay manual because their installers are shell scripts or OS packages, and
a `module` row (`unpdf`, `web-tree-sitter`) is refused outright — those resolve
inside *Golem's own* install, so a project-local `npm install` would not even be
detected. **A row without a recipe has no automated path at all**, and the refusal
quotes its documented human route.

**Consent comes from the autonomy gate, not from a local `if`.** Installing
classifies `outward`; `decideGate` answers `ask` for `outward` at *every* autonomy
level, `outcome` included (ADR-0002). That answer is what makes consent
mandatory, so there is no level, setting or flag combination in which `golem pkg
list` installs something. The gate's own reason is quoted to you, both outcomes
land in the autonomy log, and a non-TTY run without `--yes` refuses (exit 3)
rather than hanging — the same shape as `golem ollama setup`.

**`upgrade` cannot move a pin.** A `"manifest"`-pinned row declares `upgrade:
"reinstall"`, so an upgrade's argv is *byte-identical* to install's and the most it
can achieve is converging on the recorded pin. A `"playbook"`-pinned row — both
Headroom rows — refuses `upgrade` outright and names the T-C4 playbook. Moving a
pin stays a reviewed code change. Drift guards assert those are the only two legal
shapes, so a new row cannot quietly invent a third.

## A cache is not an inventory (§133)

Building `remove` exposed a false positive in the *read* half. `pluginOnDisk`
checked for `~/.claude/plugins/cache/<marketplace>/<name>/`, but `claude plugin
uninstall` empties `installed_plugins.json` and leaves that cache — plus the
marketplace clone — on disk. So this repo reported Caveman `[found]` for ten days
while `claude plugin list` said "No plugins installed."

`installed_plugins.json` is now the authority in **both** directions: listed →
installed; file readable and not listed → not installed, cache notwithstanding.
The cache survives only as a fallback for a Claude Code with no registry file.

**The rule.** When detection must answer "is this installed", read the file the
tool itself would have to update to answer that question — a directory that merely
exists proves someone once installed it, which is a different claim. And a
read-only surface that grows a `remove` verb must re-derive what its detector
actually proves: the verb is what makes a stale positive load-bearing.

Related: `claude plugin install` has **no version selector** at all (§133), which
is why the Caveman row records `pinPolicy: "upstream-unpinned"` rather than
inventing a pin. Saying "the upstream governs this and gives us no say" is honest;
a fabricated pin would not be.

## Related

- [[LSP Bridge]] — the R8.6 tier-2 row: spawn the user's own language server, degrade to a no-op
- [[Compression]] — the Headroom sidecar's only caller, and why it stays idle
- [[Compression Levels]] — the gate that makes "enabled" not mean "running"
- [[Configuration Surfaces]] — where `enabledBy` settings are rendered and written
- [[Dogfooding Golem]] — the local setup these rows describe
- [[Architecture]] — where the adapters sit in the pipeline
- `docs/decisions/ADR-0002-autonomy-approval-gates.md` — the gate that makes `golem pkg install` require consent
