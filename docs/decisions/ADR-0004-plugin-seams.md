---
title: ADR-0004 — Plugin seams: third-party code inside Golem's process
type: adr
tags: [r8, plugins, security, redaction, threat-model, decision-53]
sources:
  [
    "docs/plan/tasks/R8.11.md",
    "docs/plan/proposals/r8-context-economy.md",
    "docs/golem-spec.md (Decision 53)",
    "src/pipeline/redaction-rules.ts",
    "src/pipeline/pipeline.ts",
    "src/ext/manifest.ts",
  ]
created: 2026-08-01
updated: 2026-08-01
---

# ADR-0004 — Plugin seams: third-party code inside Golem's process

**Status: ACCEPTED (2026-08-01, user decision).** Written as the R8.11 build gate. The
task states
the ordering itself: *"A plugin runs inside the process that sees unredacted prompt
content. Write the threat model (an ADR, like ADR-0002 for autonomy) **before** the
seam."* This is that threat model. No seam code lands until it is accepted.

## Context

Decision 53 named two integration surfaces and deliberately kept them apart:

| | runs | example | ADR |
|---|---|---|---|
| **ext** | *beside* Golem — spawned or detected | Headroom, Ollama, `typescript-language-server` | Decision 53 |
| **plugin** | *inside* Golem — same process, same heap | R8.11 | this one |

An ext that turns hostile can do what any subprocess can do. A plugin that turns
hostile is already inside the process that holds the unredacted request body, the
decrypted upstream credential, and the handle to `.golem/`. That is a different
question, and it is the only reason this ADR exists.

**Redaction rules are the driver.** Every org has private key formats, and today
extending redaction means editing `src/pipeline/redaction-rules.ts` — a fork. This is
an adoption feature before it is a token feature. It is also the seam pointed straight
at the most sensitive data in the process, which is the tension the design has to
resolve rather than restate.

Three seams were asked for: **redaction rule**, **pipeline stage**, **MCP tool**.

## Decision

### 1. The three seams are three different trust classes, not one plugin API

The central move: **the seam with the most demand needs data, not code.**

| Seam | What a plugin supplies | Sees unredacted content? | Arbitrary code? |
|---|---|---|---|
| **A — redaction rule** | **declarative rule descriptors** | yes, by definition | **no** |
| **B — pipeline stage** | a function | **no** — runs strictly after redaction | yes |
| **C — MCP tool** | a function | no — off the request path | yes |

Seam A accepts a *pattern*, not a *predicate*. A plugin exports rule descriptors —
`{id, description, pattern, flags?, group?, validate?}` where `validate` names one of
Golem's own built-in validators (`luhn`, `base64`, …) rather than supplying one — and
Golem compiles the `RegExp` and runs it. **No third-party function is ever called on
unredacted text.** The exfiltration vector that makes seam A frightening does not exist,
because there is nothing to execute.

Seams B and C run ordinary code, and they are placed where that is survivable: a stage
sees only already-redacted content, and a tool is not on the request path at all.

### 2. Registration is append-only, and Golem owns the order

- `REDACTION_RULES` stays a frozen module-level const. Plugin rules live in a
  **separate** list, appended after the built-in table and before the high-entropy
  sweep — the same slot ordering the built-ins already document, so provider-specific
  built-ins keep winning the placeholder kind.
- There is **no API to remove, replace, disable or reorder** a built-in rule or a
  built-in stage. Not "it's checked" — the function does not exist.
- A plugin stage runs in one fixed slot, after every built-in stage.

### 3. Resolution: the user's own install, pinned, never fetched

Mirrors `golem ext` and Decision 53's "ship none of its bytes":

- Declared in settings as an array leaf (`plugins.entries`, precedent:
  `proxy.accounts`): `{id, specifier, pin, seams}` where `specifier` is an npm package
  the user installed or a local path.
- Golem **never** installs, downloads, vendors or auto-updates a plugin. If R8.14 ships
  `golem ext install`, plugins are still excluded from it.
- **Absent, unresolvable, or failing → a no-op with a reason**, never an error path
  (Decision 53 admission bar, criterion 3).
- Each seam is enabled per-plugin and per-seam. Installing a package grants nothing;
  listing it under `plugins.entries` with `seams: ["redaction"]` grants exactly that.

### 4. Golem does not sandbox seams B and C, and says so

Stated plainly because the task asks for it: *"Sandboxing as a solved problem — if it
needs a sandbox to be safe, say so in the ADR rather than shipping."*

A seam-B or seam-C plugin is ordinary Node code with the full privilege of the Golem
process: filesystem, network, `child_process`. **Golem does not and will not pretend
otherwise.** `worker_threads` is not a security boundary; `vm` is not a security
boundary. The real mitigations are the unglamorous ones — the user installs it
themselves, pins it, enables each seam explicitly, and can see exactly what is loaded.
That is the same trust the user already extends to any npm dependency, and it is
honest to name it as such rather than to imply an isolation that isn't there.

The one place that argument would *not* have been good enough is seam A — third-party
code reading unredacted secrets — which is precisely why seam A accepts no code.

If a future seam genuinely needs to run untrusted code against sensitive content, the
answer is an out-of-process **plugin host** under Node 22's permission model
(`--permission`, `--allow-fs-read`), not a tighter in-process wrapper. That is not built
here, and nothing in this design should be read as a step toward it.

### 5. Plugins get a narrow context, not Golem's internals

A seam receives a purpose-built context object — for a stage: the body and the resolved
policy; for a tool: the KB reader and a logger. It never receives the credential store,
the settings writer, the proxy handle, or the `deps` bag the MCP server is built from.
This is not a security boundary (see §4) — it is an interface-surface decision that
keeps a plugin from depending on internals that are free to change.

## Threat model and default-safe proofs

Failure modes, and why each is safe by construction rather than by care:

1. **Hostile or compromised plugin package (supply chain).** Seam A executes nothing,
   so the highest-value target is inert. Seams B and C are full-privilege and are
   defended only by consent, pinning and visibility — stated, not hidden. R8.10's
   `save-exact` + `min-release-age` apply to the *user's* install, which is where the
   package lives; Golem's own dependency ceiling is untouched because Golem depends on
   no plugin.
2. **A plugin tries to weaken or reorder redaction.** Structurally impossible: the
   built-in table is a frozen const, plugin rules are a separate appended list, and no
   removal/reorder/replace API exists. The CLAUDE.md hard rule is enforced by the
   absence of a mechanism, not by a check that could be forgotten.
3. **A plugin rule breaks prompt-cache prefix stability.** Redaction must be a pure
   function of the text (verification-notes §14). Seam A is pure by construction — a
   compiled `RegExp` plus a *named Golem* validator; no clock, no randomness, no config,
   no closure. A load-time probe additionally applies every plugin rule twice to a
   fixed corpus and rejects any rule whose two outputs differ.
4. **Catastrophic backtracking (ReDoS) stalls the proxy.** The honest gap. Node cannot
   interrupt a running regex in-process, so a pathological pattern blocks the event
   loop and there is no in-process fix. Mitigations are partial and named as partial:
   a static load-time lint rejects nested unbounded quantifiers and over-long patterns;
   per-rule elapsed time is measured and a rule that breaches its budget is reported.
   The measurement is **post-hoc** — the first stall still happens. A complete answer
   requires the out-of-process host from §4; until then this is a documented residual
   risk of enabling seam A, and seam A is off by default. **Explicitly accepted by the
   user on 2026-08-01**, with the lint-and-measure mitigation and without the host: the
   host would put an IPC round-trip on every request's critical path to close a gap that
   only opens for someone who installs a plugin, pins it, and enables the seam.
5. **A plugin rule over-redacts and destroys the request.** A rule matching too broadly
   is a fidelity failure, not a leak, but it is still a failure. If the plugin rules
   **match** more than 90% of a long-enough string's characters, their whole contribution
   is dropped **for that string** and the built-ins alone apply. Judged from that string
   alone, so the stage stays a pure function — no cross-request state, no cache-breaking
   nondeterminism.

   Two details the first implementation got wrong, both caught by the contract tests:
   the measure must be *matched input characters*, not the change in length (a
   placeholder is usually longer than the secret, so a greedy rule can **grow** the
   string while a total swallow can leave its length alone); and the cap must not apply
   to short strings, because a message that *is* one API key is a legitimate 100% match
   and clamping it would break the seam's main use.
6. **A plugin stage breaks byte-fidelity at slider ≤1.** Cannot: a plugin stage runs
   only in the lossy slot, under the same caching-upstream gate as semantic compression
   and context substitution (Decision 31). At level ≤1, and on any caching upstream, no
   plugin stage runs at all — the same guarantee the recorded-shape integration tests
   already assert.
7. **A plugin MCP tool taxes every request.** A tool *definition* is billed on every
   request whether or not it is called (§88/§100: Golem's whole tools contribution is
   1,130 tokens, and R8.S1 was rejected over less). Seam C is therefore off by default,
   and `golem plugin list` reports each tool's definition cost measured the same way
   `golem bench tools` measures Golem's own.
8. **A plugin throws, hangs at load, or returns garbage.** Each seam is invoked behind
   its own quarantine adapter: a thrown error, a rejected promise, or a value that
   fails zod validation resolves to *no contribution from that plugin*, one line on
   stderr, and the request proceeds. Mirrors the semantic stage's fail-open and the LSP
   bridge's `available: false` (R8.6).
9. **A plugin escalates through Golem's own state.** It receives the narrow context of
   §5 — no credentials, no settings writer, no proxy handle. Again: an interface
   decision, not a boundary. A hostile seam-B plugin can `import` whatever it likes.
10. **A plugin loads silently.** It cannot. `golem plugin list` names every declared
    plugin with its specifier, pin, resolution path, enabled seams and load outcome;
    `golem status` reports the count and any quarantine; every load failure and every
    quarantine writes one line to stderr.

## Consequences

- **Seam A is the only one that answers the actual demand** ("our org has a private key
  format"), and it ships as data, so the adoption feature does not carry the trust cost
  people assume it must.
- **Everything is off by default.** An empty `plugins.entries` — the shipped default —
  is byte-identical to today: no resolution, no load, no tokens.
- Extending Golem's redaction *coverage* no longer requires a fork. Weakening it still
  requires a fork, which is the correct asymmetry.
- The residual ReDoS risk (4) is accepted, documented, and belongs to whoever enables
  seam A. It is the one place this design is knowingly incomplete.
- `golem plugin` stays separate from `golem ext`. Merging them would put "runs beside
  Golem" and "runs inside the redaction path" behind one verb, which is exactly the
  confusion Decision 53 split them to avoid.

## Alternatives rejected

- **Arbitrary `validate` functions in redaction rules, isolated in a worker.**
  `worker_threads` shares no security boundary with the main thread and can open
  sockets; it would have bought the *appearance* of isolation over unredacted secrets.
  Declarative rules give the real property instead.
- **One plugin API across all three seams.** Simpler to document, and it would have
  levelled all three down to the trust model of the most dangerous one.
- **A plugin registry or marketplace.** Explicitly out of scope (R8.11). If one ever
  exists it is a list of names and pins, not a store (Decision 53).
- **Auto-installing a declared-but-missing plugin.** Violates "ship none of its bytes"
  in spirit; absence degrading to a no-op is the whole point of criterion 3.

Related: [[Redaction Stage]], [[Managed Tools]], ADR-0002 (autonomy, the fail-closed
precedent this ADR's numbered proofs follow), Decision 53, verification-notes §14
(prefix stability), §88/§100 (what a tool definition costs).
