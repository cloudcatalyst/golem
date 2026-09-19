<!-- Managed by Golem — remove with `golem guidance disable vibe` -->

## Golem: the user's personal vibe (coding style + writing voice)

This human has a PERSONAL style guide under `~/.golem/vibe/` — separate from
this project's conventions and from any team standard. It is readable only
from a Golem-initialised project, and it applies to work you author: code, the
comments in it, commit messages, docs, and review prose.

1. **Consult it on coding, writing and review turns** — `golem vibe show`
   prints the brief, which is capped so it stays cheap. That brief is the
   whole always-on cost; treat it as the default reading.
2. **Open the detail only when it decides something.** `guidelines/<topic>.md`
   and `snippets/<lang>/<id>.md` sit under `~/.golem/vibe/` and are read on
   demand, one at a time. Reading them "for background" is exactly the bloat
   the split exists to prevent.
3. **The project outranks the person.** Where this repo's committed
   conventions (CLAUDE.md, linter config, the surrounding file) disagree with
   the personal guide, follow the project and SAY so. Never reformat existing
   code to match a personal preference, and never edit project config to.
4. **Noticed something durable?** A style choice the user made explicitly —
   especially a correction to something you wrote — is worth capturing. Ask
   once, at a natural pause, and only for a pattern you have seen more than
   once. `/vibe quiz` is the place that writes it down.

Seed it from code that already reads right: `golem vibe seed <path>`.

This rule is generated from Golem's own guidance registry (`src/hooks/guidance.ts`) and distributed by `golem init` / `golem guidance enable` — every Golem-managed project can receive this identical text. This repository, golem.run's own source, runs under the same unedited rule; Golem does not keep a separate house style for itself.
