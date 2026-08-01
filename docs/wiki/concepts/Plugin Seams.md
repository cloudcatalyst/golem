---
title: Plugin Seams
type: concept
tags: [plugins, r8, redaction, security, decision-53, adr-0004]
sources: ["docs/decisions/ADR-0004-plugin-seams.md", "src/interfaces/plugin.ts", "src/plugins/", "src/pipeline/plugin-rules.ts"]
created: 2026-08-01
updated: 2026-08-01
---

# Plugin Seams

How a third party extends Golem **without forking it** (R8.11). Governed by
[ADR-0004](../../decisions/ADR-0004-plugin-seams.md), which is the threat model,
and by [[Managed Tools]] (Decision 53), which is the ships-no-third-party-bytes rule.

A **plugin** runs *inside* Golem's process. An **ext** runs *beside* it. That is the
entire reason they are separate surfaces — `golem plugin` vs `golem ext`.

## The three seams are three trust classes

| Seam | A plugin supplies | Sees unredacted content | Runs plugin code |
|---|---|---|---|
| **redaction** | rule **descriptors** (data) | yes | **no** |
| **stage** | a function | no — post-redaction, lossy slot only | yes |
| **tool** | a function | no — off the request path | yes |

The move that makes this work: **the seam with the most demand needs data, not code.**
Every org has private key formats, so the redaction seam is the one people actually
want — and it points straight at the most sensitive data in the process. So it accepts
a *pattern*, never a *predicate*: `validate` names one of Golem's own validators
(`luhn`, `credit-card`, `high-entropy`) instead of supplying one, and Golem compiles the
`RegExp` itself. No plugin function is ever called on unredacted text, because there is
nothing to call.

## What holds by construction

- **Append-only.** `REDACTION_RULES` stays a frozen const; plugin rules are a separate
  list applied after it and before the entropy sweep. There is no remove/replace/reorder
  API — the [[Redaction Stage]] hard rule is enforced by the function not existing. A
  contract test asserts the module's exported names, so a future `removeBuiltinRule`
  fails on the day it is written.
- **No impersonation.** Every rule id is namespaced `<plugin>/<id>`, every tool
  `<plugin>__<name>`.
- **Byte-fidelity is untouchable.** A stage runs only when `semanticCompression !== "off"`
  **and** the upstream is non-caching — so at slider ≤1, and on Anthropic at any level, no
  plugin stage executes. See [[Slider Levels]].
- **Determinism.** Rules are pure regex + a named Golem validator, and a load-time probe
  runs each rule twice over a fixed corpus and rejects it if the passes differ. Prefix
  stability is what every prompt-cache hit rests on (verification-notes §14).
- **Every failure is a no-op with a reason.** Unresolved, import-failed, invalid-export,
  pin-mismatch, no-seams-enabled — each is a row in `golem plugin list`, never an error
  path (Decision 53, criterion 3).

## Consent is per seam, not per package

```json
{ "plugins": { "entries": [
  { "id": "acme", "specifier": "@acme/golem-plugin", "pin": "1.2.0", "seams": ["redaction"] }
] } }
```

Listing a package grants nothing. `seams` grants exactly what it names — a plugin
offering a stage it was not granted has that stage ignored and says so. `pin` is
*compared* against the installed version, never fetched; a mismatch contributes nothing.

## What Golem does not claim

**Seams `stage` and `tool` are not sandboxed.** They are ordinary Node code with the full
privilege of the process. `worker_threads` is not a security boundary and neither is `vm`,
so ADR-0004 says this plainly instead of implying isolation it cannot provide: the
mitigations are that the user installs the package themselves, pins it, enables each seam
explicitly, and can see what is loaded. The same trust already extended to any npm
dependency.

**ReDoS on the redaction seam is a documented residual risk.** Node cannot interrupt a
running regex, so a pathological pattern blocks the event loop. A static lint rejects
nested unbounded quantifiers and over-long patterns, and per-rule elapsed time is
measured — but the measurement is post-hoc and the first stall still happens. The
complete fix is an out-of-process host under Node 22's permission model; it is not built,
and it was declined on purpose because it would put an IPC round-trip on every request's
critical path.

Related: [[Managed Tools]], [[Redaction Stage]], [[Configuration Surfaces]],
[[Slider Levels]].
