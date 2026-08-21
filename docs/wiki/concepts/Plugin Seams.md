---
title: Plugin Seams
type: concept
tags: [plugins, redaction, threat-model, trust, extensibility, adr-0005, r8]
sources: [src/plugins/types.ts, src/plugins/loader.ts, src/plugins/init.ts, src/pipeline/redaction-rules.ts, src/cli/plugin.ts, docs/decisions/ADR-0005-plugin-seams-and-the-redaction-path.md]
created: 2026-08-21
updated: 2026-08-21
---

# Plugin seams — third-party code inside the redaction path

A **plugin** runs *inside* Golem's process. A **pkg** runs *beside* it. That
single difference is why the two surfaces were named separately (spec Decision
53(g)) and why they give opposite answers to "how much do I have to trust this".

| | `golem pkg` | `golem plugin` |
|---|---|---|
| Where it runs | its own OS process | **inside Golem** |
| Boundary | a real one | **none** |
| Install | consent-gated (R8.14) | **no install verb — that is npm's job** |
| Sees your prompts | only what Golem passes on stdin | everything the process holds |

See [[Managed Tools]] for the pkg side.

## The headline, first

**There is no sandbox, and Node cannot give us one.** Loading a Golem plugin is
exactly as dangerous as adding a dependency to your own `package.json` and
importing it. It is not less dangerous. Every control below narrows what a plugin
is *asked* to do; none narrows what it *can* do.

That is stated in [ADR-0005](../../decisions/ADR-0005-plugin-seams-and-the-redaction-path.md),
in the CLI output of `golem plugin`, and in the settings help — deliberately, in
all three, because a control that looks like containment is worse than an honest
absence of one. Why no sandbox is available (verification-notes §134):

- `node:vm` is **not** a security boundary; its own documentation says so.
- `worker_threads` isolates *state*, not *authority* — a worker still has `fs`
  and sockets — and a redaction rule must run synchronously inside the pass to be
  part of it.
- `--permission` is process-wide and set at launch; it cannot be scoped to one
  loaded module.
- A separate OS process **is** a real boundary — and that surface already exists.
  **Anything that can tolerate a process hop should be a `pkg`, not a plugin.**

## What it is weighed against — not zero

Before this seam, extending redaction meant *editing Golem*. Every organisation
has private secret formats: an internal key prefix, a bespoke employee id, a
customer reference that is PII in their jurisdiction and nowhere else. The
realistic outcomes of refusing a seam were:

1. the org forks Golem, and their fork drifts out of date — including out of date
   with fixes to the redaction stage itself;
2. the org gives up and their private key format flows upstream **unredacted**;
3. the org does not adopt Golem.

None of those is safe. The question was never "is loading third-party code
risky" — it was "which risk, and is the user told the truth about it".

## Three seams, and only one sees raw text

| Seam | Runs | Sees |
|---|---|---|
| **Redaction rule** | after every built-in, before the entropy sweep | **raw text** — a detector that cannot see the secret cannot detect it |
| **Pipeline stage** | after redaction, after the local-answer short-circuit | only redacted content |
| **MCP tool** | on a tool call | whatever the caller passes |

## Redaction is append-only by construction, not by convention

CLAUDE.md's hard rule is that redaction is never weakened or reordered, so none
of this rests on review:

- Built-ins run **first**, in their audited order; plugin rules are a **suffix**.
  A plugin can therefore only ever redact *more*.
- `REDACTION_RULES` is never handed to a plugin, and there is **no remove,
  replace, or reorder function** — those do not exist to be called.
- Rule kinds are namespaced `<plugin>/<rule>`, so a plugin cannot impersonate a
  built-in kind (`[REDACTED:acme/employee-id:1]`, never `[REDACTED:aws-key:1]`).
- A plugin rule that matches something a built-in already replaced sees a
  **placeholder** — `[`, `]` and `:` are outside every rule's charset — so it
  cannot un-redact.
- Registration happens **once, at startup**, and a second registration is
  *refused*. Not tidiness: redaction must be a pure function of its input for
  prompt-cache prefix stability (verification-notes §14), so a table that
  changed mid-process would break caching for every later request.

## A stage cannot smuggle a secret in, because redaction runs again

The load-bearing property of the pipeline seam. A plugin stage receives
already-redacted content, and **redaction re-runs over whatever it returns**.
Redaction is idempotent, so the second pass renumbers nothing; what it buys is
that a stage cannot introduce unredacted content — fetched, constructed, or
restored from anywhere.

That is a structural answer to "can a plugin weaken redaction here". Not "we read
the plugin" but "the stage's output is redacted too". The extra pass is attributed
separately (`redaction-after-plugins`) so a stage that keeps introducing secrets
is *visible* rather than folded into stage 1.

## Failure is always a no-op

An unresolvable specifier, a bad export, a `setup()` that throws, a stage that
throws mid-request, a validator that throws — each is a recorded problem and
nothing more. Two details worth keeping:

- A `setup()` that throws discards that plugin's registrations **entirely**,
  rather than keeping the half it managed before failing. A plugin that never
  finished saying what it wanted does not get a redaction rule installed.
- A third-party `validate` that throws is read as **"not a secret"** — the same
  verdict as returning `false` — because a throw tells us nothing, and it must
  not abort a pass that still has built-ins to run.

## `golem plugin`

```
golem plugin              # what loaded, from where, and what each registered
golem plugin --verbose    # every rule, stage and tool contributed
golem plugin --json       # machine-readable
```

Read-only, with **no install verb**: offering one would imply a vetting Golem does
not perform. It reports the **resolved path**, not just the specifier — "which
copy of this is running inside my process" is the question that matters. Every
render ends with the no-sandbox notice.

Configuration is two keys, and the default is inert:

```jsonc
// .golem/settings.json
{ "plugins": { "enabled": true, "load": ["./acme-golem-plugin.mjs"] } }
```

**Nothing is discovered.** No `node_modules` scan, no naming convention, no
registry, no download — ever, not even with consent. `load` is empty by default,
so a fresh install runs no third-party in-process code at all.
`plugins.enabled: false` is the kill switch for when a plugin is suspected and you
want it gone now.

## The bypass shim gets rules but not stages

Decision 56's shim is "pipeline off", so no third-party *stage* runs on it. Plugin
redaction *rules* still do — the shim redacts, and dropping an org's own
key-format rule the moment the proxy is "stopped" would weaken redaction exactly
when the user thought they were safer.

## Where this goes next

Both recorded in ADR-0005 as successors rather than left as gaps:

- **Declarative pattern-only rules** — a JSON/YAML pattern file, no code loading,
  no ADR needed. Covers the majority case ("our key prefix is `ACME-`") and is
  strictly safer and strictly less capable (no `validate`, so no Luhn-style
  checks). The right default for most users.
- **WASM-compiled rules** — a genuine sandbox for the *pure* seam. A rule that
  only matches patterns has no business touching the filesystem. Needs a
  compilation toolchain the user would have to run, and it solves only one of the
  three seams.

## Related

- [[Managed Tools]] — the `pkg` side: a real process boundary, consent-gated installs
- [[Redaction Stage]] — the built-in table these rules append to, and why order is audited
- [[Architecture]] — where the pipeline stages sit
- [[Configuration Surfaces]] — where `plugins.enabled` / `plugins.load` are rendered
- `docs/decisions/ADR-0005-plugin-seams-and-the-redaction-path.md` — the threat model
