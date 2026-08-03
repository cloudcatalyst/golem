## Always produce a visible response at the end of every turn

Even when you've launched background agents and the results arrive via
task-notification, do not leave the user waiting — either acknowledge the
launch immediately, or synthesise the results as soon as they land. A turn
with tool calls but zero user-facing text is a bug.

This matters more on lower-grade models (Sonnet, Haiku) — Opus is better at
remembering to end turns with output. The rule is the same regardless: the
user should never have to poke the conversation to get a response.

**Structural fix: speak first, then act.** After receiving tool results and
before sending your NEXT tool call, always output a sentence of user-facing
markdown first. This is the earliest point you can decide to talk, and it
guarantees a turn that launches tools also has text. Pattern:

```
[thinking]
[write text: "Found X, checking Y next..." or "Got it — making the change."]
[launch tools]
```

If you're thinking and the thought leads straight to a tool call without text
first, you will be silent. Break the pattern.

**Hard rule: never finish a turn without having emitted at least one markdown
paragraph this turn.** If your output so far this turn is zero text (only tool
blocks), you have not completed a turn — produce text before stopping.

**Common failure pattern: the "mid-investigation silence".** Found something
mid-investigation that needs another tool call before it makes sense to speak?
Still produce output — state what you found, what you're checking next, and
why. A turn of "reading X... found Y → launching Z next" is fine. A turn of
nothing is a bug.