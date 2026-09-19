/**
 * `golem vibe` — the personal style guide's CLI half.
 *
 * Read, seed, and work the candidate queue. There is deliberately no `set` verb
 * for writing a preference directly: a stated preference is something the human
 * agreed to, and the only surfaces that can ask are the `/vibe` skill and
 * `confirm` below, which takes a candidate that was actually observed. A free
 * `set` would be a second place for "did they really agree to this?" to be
 * answered — or not.
 *
 * Every verb goes through {@link requireStore}, so every verb is gated: run
 * outside a Golem project and the guide is not read at all.
 */

import type { Command } from "commander";
import {
  applyConfirmed,
  confirmCandidate,
  describeSignal,
  loadCandidates,
  loadVibeContext,
  localDate,
  openVibeStore,
  quizzable,
  rejectCandidate,
  renderVibeContext,
  seedFromPath,
  sweepCorrections,
  type VibeStore,
} from "../../vibe/index.js";

function fail(err: unknown): never {
  process.stderr.write(`golem: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

const NOT_A_PROJECT =
  "golem: the personal vibe guide is only readable from a Golem-initialised project.\n" +
  "       Run `golem init` here first.\n";

/**
 * The gate, as a CLI verb sees it: a store, or a clean exit.
 *
 * Every verb needs the same three lines, and writing them out each time is how
 * one of them eventually forgets. `openVibeStore` returning null is not an error
 * to be handled differently per command — it means this directory has no
 * business reading the guide, and that answer is the same everywhere.
 */
function requireStore(dir: string): VibeStore {
  const store = openVibeStore({ cwd: dir });
  if (store === null) {
    process.stderr.write(NOT_A_PROJECT);
    process.exit(1);
  }
  return store;
}

export default function register(program: Command): void {
  const vibe = program
    .command("vibe")
    .description("Your personal style guide — seed it from code you like, and see what it holds");

  vibe
    .command("show", { isDefault: true })
    .description("Print the brief that coding, writing and review turns actually see")
    .option("--dir <path>", "project directory", process.cwd())
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; json: boolean }) => {
      try {
        const store = requireStore(opts.dir);
        const ctx = await loadVibeContext({ cwd: opts.dir });
        if (ctx === null) {
          // The gate already passed, so this is the other null: nothing seeded.
          void store;
          process.stdout.write(
            opts.json
              ? `${JSON.stringify({ brief: null }, null, 2)}\n`
              : "No personal vibe captured yet. Seed one: `golem vibe seed <path>`\n",
          );
          return;
        }
        process.stdout.write(
          opts.json ? `${JSON.stringify(ctx, null, 2)}\n` : renderVibeContext(ctx),
        );
      } catch (err) {
        fail(err);
      }
    });

  vibe
    .command("seed")
    .argument("<paths...>", "files or project directories that read the way you write")
    .description("Measure your style from code you point at, and refresh the guide")
    .option("--dir <path>", "project directory", process.cwd())
    .action(async (paths: string[], opts: { dir: string }) => {
      try {
        const store = requireStore(opts.dir);
        for (const p of paths) {
          const result = await seedFromPath(store, p);
          process.stdout.write(
            `golem vibe: ${result.source}\n` +
              `  read ${result.filesRead} file(s)` +
              `${result.filesSkipped > 0 ? `, skipped ${result.filesSkipped}` : ""}` +
              `, ${result.snippetsWritten} snippet(s)\n` +
              `  guideline: ${result.guidelinePath}\n` +
              `  brief: ${result.briefBytes} bytes (always loaded)\n`,
          );
        }
      } catch (err) {
        fail(err);
      }
    });

  vibe
    .command("sources")
    .description("List what the guide was seeded from")
    .option("--dir <path>", "project directory", process.cwd())
    .action(async (opts: { dir: string }) => {
      try {
        const store = requireStore(opts.dir);
        const { sources } = await store.sources();
        if (sources.length === 0) {
          process.stdout.write("No sources seeded yet.\n");
          return;
        }
        for (const s of sources) {
          process.stdout.write(
            `${s.path}  (${s.kind}, ${s.files ?? 0} files, seeded ${s.lastSeededAt ?? s.addedAt})\n`,
          );
        }
      } catch (err) {
        fail(err);
      }
    });

  vibe
    .command("path")
    .description("Print where the guide lives on this machine")
    .option("--dir <path>", "project directory", process.cwd())
    .action((opts: { dir: string }) => {
      process.stdout.write(`${requireStore(opts.dir).paths.root}\n`);
    });

  vibe
    .command("candidates")
    .description("Corrections noticed but not yet confirmed — what `/vibe quiz` would ask about")
    .option("--dir <path>", "project directory", process.cwd())
    .option("--all", "include confirmed and rejected, not only what is askable", false)
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; all: boolean; json: boolean }) => {
      try {
        const store = requireStore(opts.dir);
        const rows = opts.all ? await loadCandidates(store) : await quizzable(store);
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
          return;
        }
        if (rows.length === 0) {
          process.stdout.write(
            opts.all
              ? "Nothing noticed yet.\n"
              : "Nothing worth asking about yet — a pattern has to recur before it counts.\n",
          );
          return;
        }
        for (const c of rows) {
          const files = `${c.files.length} file${c.files.length === 1 ? "" : "s"}`;
          process.stdout.write(
            `${c.key}\n` +
              `  ${describeSignal({ kind: c.kind, from: c.from, to: c.to })}\n` +
              `  ${c.state}, seen ${c.seen}x across ${files}, last ${c.lastSeen}\n`,
          );
        }
      } catch (err) {
        fail(err);
      }
    });

  vibe
    .command("confirm")
    .argument("<key>", "candidate key, as printed by `golem vibe candidates`")
    .description("Accept a noticed preference — it becomes a stated instruction in the guide")
    .option("--dir <path>", "project directory", process.cwd())
    .option("--note <text>", "why, in your own words")
    .action(async (key: string, opts: { dir: string; note?: string }) => {
      try {
        const store = requireStore(opts.dir);
        const now = new Date();
        const row = await confirmCandidate(store, key, now.toISOString(), opts.note);
        if (row === null) {
          process.stderr.write(`golem: no candidate with key ${key}\n`);
          process.exit(1);
        }
        const result = await applyConfirmed(store, localDate(now));
        process.stdout.write(
          `confirmed: ${describeSignal({ kind: row.kind, from: row.from, to: row.to })}\n` +
            `  ${result.confirmed} preference(s) total, ${result.inBrief} of them in the brief\n` +
            `  brief: ${result.briefBytes} bytes (always loaded)\n`,
        );
      } catch (err) {
        fail(err);
      }
    });

  vibe
    .command("reject")
    .argument("<key>", "candidate key, as printed by `golem vibe candidates`")
    .description("Decline a noticed preference — tombstoned, so it is never raised again")
    .option("--dir <path>", "project directory", process.cwd())
    .action(async (key: string, opts: { dir: string }) => {
      try {
        const store = requireStore(opts.dir);
        const row = await rejectCandidate(store, key, new Date().toISOString());
        if (row === null) {
          process.stderr.write(`golem: no candidate with key ${key}\n`);
          process.exit(1);
        }
        process.stdout.write(`rejected: ${row.key} — it will not be raised again\n`);
      } catch (err) {
        fail(err);
      }
    });

  vibe
    .command("sweep")
    .description("Look now for edits you made to files the agent wrote (the hooks do this for you)")
    .option("--dir <path>", "project directory", process.cwd())
    .action(async (opts: { dir: string }) => {
      try {
        const store = requireStore(opts.dir);
        const result = await sweepCorrections(opts.dir, store, new Date().toISOString());
        process.stdout.write(
          `swept: ${result.corrected.length} corrected file(s), ` +
            `${result.signals.length} signal(s)` +
            `${result.dropped.length > 0 ? `, ${result.dropped.length} vanished` : ""}\n`,
        );
        for (const s of result.signals) {
          process.stdout.write(`  ${describeSignal(s)}\n`);
        }
      } catch (err) {
        fail(err);
      }
    });
}
