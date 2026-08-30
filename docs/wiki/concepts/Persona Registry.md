---
title: Persona Registry
type: concept
tags: [r14, r14-1, inference, configuration, personas, bench, dispatch, agent-definition]
sources: ["src/config/schema.ts", "src/config/loader.ts", "src/inference/personas.ts", "src/config/migrations.ts", "src/cli/personas.ts", "docs/decisions/ADR-0003-credential-storage-and-account-routing.md"]
updated: 2026-08-30
created: 2026-08-30
---

# Persona Registry

A **named bench**: each role staffed by the model that suits it. `inference.personas`, keyed by persona id — the table that maps human-readable role names (`coder`, `reviewer`, `scribe`, …) to their configuration (discipline, description, model, prompt, tool allow-list, permission axis).

```json
{
  "inference": {
    "personas": {
      "coder": {
        "discipline": "code",
        "model": "claude-sonnet-5"
      },
      "reviewer": {
        "model": "claude-sonnet-5"
      },
      "scribe": {
        "discipline": "write",
        "model": "claude-haiku-4-5"
      }
    }
  }
}
```

A persona holds **no credential and no `base_url`** — it names a model (a plain id) or a `proxy.targets` id (which points at a gateway). The gateway holds the keychain reference. That keeps ADR-0003 intact: secrets live in the OS credential store, never in settings, never as an env var.

## Why a leaf under `inference`, not a top-level `personas` section

Every section in `SETTINGS_LEAVES` is a flat map of **known leaves** like `proxy.port` or `inference.ollama_base_url`. The loader, env mapping (`GOLEM_<SECTION>_<KEY>`), `writeSetting`, and the UI model all derive their behaviour from that single table. 

A `personas` section whose keys are **user-defined ids** has no table to derive from. It would need a parallel mechanism in each of those places — a second source of truth for which keys exist and how they coerce. `worker_targets` (another record leaf under `inference`) established that a map belongs in a leaf; the persona registry follows it.

## The merge rule — per id, then per field

This is the **one leaf that merges per key** instead of replacing wholesale (see `MERGE_PER_KEY_LEAVES` in `src/config/loader.ts`). Ordinary leaves replace, and here that would mean a `<project>/.golem/settings.json` bench silently erasing the user's in `~/.golem/settings.json` — precedence runs defaults → user → project → local → env, so the project layer sits above the user one.

**Two levels, not deep:**

1. **Per id** — `personas.reviewer` in two layers merges to one, keeping all fields from both.
2. **Per field within an id** — if layer 1 sets `reviewer.model: "opus"` and layer 2 sets `reviewer.description`, the result has both.

Example: the project (`<project>/.golem/settings.json`) sets `reviewer: { model: "claude-sonnet-5", description: "…" }`, and `<project>/.golem/settings.local.json` — the layer ABOVE it — sets `reviewer: { model: "claude-haiku-4-5" }`. The result is `{ model: "claude-haiku-4-5", description: "…" }`: the higher layer's model wins and the project's description survives. That is the motivating case — restaff one persona on your own machine without restating the repo's definition of it.

**`tools` replaces**, not merges, because an allow-list you can only add to is not an allow-list.

Provenance is recorded per `inference.personas.<id>.<field>`, so `golem personas` can say which layer supplied each field and why a persona is configured as it is.

## No defaults per layer — only on read

Every field in `personaLayerSchema` is optional with **no defaults**. A default applied per layer would let a higher layer that merely *mentions* a persona overwrite a lower layer's explicit value.

Example failure: layer 1 sets `coder: { owner: user }` (human-only role), layer 2 sets `coder: { model: "opus" }` — if layer 2 applied a default `owner: agent`, the result would be `{ owner: agent, model: "opus" }`, silently overriding the human's rule. That is unacceptable.

Defaults are applied on **read**, after all layers are merged, in `src/inference/personas.ts`. At that point, a persona is final and can have proper defaults (e.g., `owner` defaults to `"agent"`, prompt defaults to the built-in for that role).

## Staffed vs dispatchable

A persona has two states:

- **`staffed: true`** — names a model (the `model` field is set and non-empty).
- **`staffed: false`** — unstaffed, so it declines rather than guessing.

**`dispatchable`** folds in the permission axis:

- `dispatchable: true` — staffed AND `owner: "agent"`. This persona may be dispatched by the session.
- `dispatchable: false` — unstaffed OR `owner: "user"`. A `user`-owned persona is a role only a human fills; nothing may dispatch it.

This distinction is why `personaModel(personas, id)` returns `undefined` for a persona that is undeclared, unstaffed, **or** `owner: user`. Folding the permission axis in there rather than at each call site is deliberate: six places used to read `inference.default_coder` directly, and six places each remembering to check `owner` separately is five chances to forget.

## Security properties

1. **No credential storage** — a persona names a model id or a `proxy.targets` id, never a key or `base_url`.
2. **Path-safe ids** — persona ids are restricted to lowercase alphanumerics and hyphens (`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`). The id becomes the basename of a generated agent definition (`.claude/agents/golem-<id>.md`, R14.3), so `../` and other traversal must be unrepresentable at the schema boundary, not sanitised downstream.
3. **Per-layer strictness** — each layer's schema is `.strict()`, so a misspelled field is a hard `ConfigError` naming the file and key, not a silently ignored line.

## The starter bench

R14.1 ships three personas, all **unstaffed** by default, so an unconfigured repo is unchanged:

- **`coder`** (`discipline: code`) — a self-contained coding task, done on its own context and returned for review.
- **`reviewer`** (`discipline: review`) — reads code as code and reports defects, without the authoring session's assumptions.
- **`scribe`** (`discipline: write`) — turns landed work into prose: wiki debriefs, task documents, docs.

Staff them by setting `inference.personas.<id>.model` to a model id or target id.

Staffing goes **per role**, not per hierarchy: there is no `manager` persona (the session is the only thing that can spawn a subagent) and no `planner` (planning is a skill surface; R9.11 says skills orchestrate).

Prompts are versioned with the shipped bench: `DEFAULT_PERSONA_PROMPTS` in `src/inference/personas.ts` supplies built-in prompts for each, which can be overridden per layer by `prompt` (inline) or `prompt_file`. Users can eject and edit with `golem personas eject <id>`.

## Retirement: `inference.default_coder` → `personas.coder.model`

R14.1 retires `inference.default_coder` and raises (rather than warns) if a settings file still carries it. Retiring rather than aliasing was the user's call. Raising rather than warning is this module's logic: a warning nobody reads reproduces the failure class — "the setting silently stops taking effect while every surface reports success" — that migrations exist to prevent.

The mechanism is `RETIRED_SETTINGS` (in `src/config/migrations.ts`), a new table parallel to migration renames. A rename has a destination leaf the loader can write to; this replacement is a **field inside a record** (`personas.coder.model`), not a leaf, so it would need a rename function for record members. Instead, `RETIRED_SETTINGS` is checked before both the rename and unknown-key branches, because a retired key is neither.

When a settings file carries `inference.default_coder`:

```
settings.local.json: "inference.default_coder" was retired in R14.1 and no longer does anything. Use inference.personas.coder.model instead (e.g. { "personas": { "coder": { "model": "…" } } }). Golem raises rather than ignoring it, so the setting cannot silently stop taking effect.
```

That message names the file, the key, and the exact replacement syntax.

## What is not here yet

- **Staffing lane** (subagent vs dispatched worker) — R14.2.
- **Generating agent definitions** (`.claude/agents/golem-<id>.md`) — R14.3.
- **A task naming a `discipline`** — R14.4. Note it is advisory and free-form: a discipline nobody staffs changes nothing, with no warning, by design.

## Related

[[Configuration Surfaces]] · [[Spawn Headroom Gate]] · [[Architecture]]
