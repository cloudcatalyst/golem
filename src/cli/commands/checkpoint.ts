/**
 * golem checkpoint — extracted from program.ts (R8.27).
 */

import type { Command } from "commander";
import {
  dropCheckpoint,
  listCheckpoints,
  planRestore,
  pruneCheckpoints,
  resolveCheckpoint,
  restoreCheckpoint,
} from "../../checkpoint/index.js";
import { DEFAULT_KEEP } from "../../checkpoint/ledger.js";
import { findProjectDir } from "../../config/index.js";
import {
  confirmDestructive,
  renderCheckpointList,
  renderRestorePlan,
  renderRestoreResult,
} from "../checkpoint.js";

const _DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();

function _fail(err: unknown): never {
  process.stderr.write(`golem: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}

export default function register(program: Command): void {
  const checkpointCmd = program
    .command("checkpoint")
    .alias("cp")
    .description("Change ledger (R8.9): snapshot the worktree to a shadow git ref");

  checkpointCmd
    .command("create", { isDefault: true })
    .alias("take")
    .description("Snapshot the working tree under refs/golem/ledger/<id>")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--note <text>", "what this attempt is about")
    .option("--keep <n>", "how many checkpoints to retain", String(DEFAULT_KEEP))
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; note?: string; keep: string; json: boolean }) => {
      try {
        const { createCheckpoint } = await import("../../checkpoint/index.js");
        const keep = Number(opts.keep);
        if (!Number.isInteger(keep) || keep < 1)
          _fail(new Error(`--keep must be a positive integer (got "${opts.keep}")`));
        const result = await createCheckpoint(opts.dir, {
          keep,
          ...(opts.note === undefined ? {} : { note: opts.note }),
        });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          return;
        }
        if (!result.ok) {
          process.stdout.write(`No checkpoint taken: ${result.reason}\n`);
          return;
        }
        const { checkpoint, unchanged, pruned } = result.value;
        if (unchanged) {
          process.stdout.write(
            `Working tree unchanged since ${checkpoint.id} — reusing that checkpoint (no new ref).\n`,
          );
          return;
        }
        process.stdout.write(
          `Checkpoint ${checkpoint.id} — ${checkpoint.note}\n${checkpoint.ref}${pruned > 0 ? ` · pruned ${pruned} older` : ""}\nRestore with: golem checkpoint restore ${checkpoint.id}\n`,
        );
      } catch (err) {
        _fail(err);
      }
    });

  checkpointCmd
    .command("list")
    .alias("ls")
    .description("List checkpoints, newest first")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--keep <n>", "retention shown in the footer", String(DEFAULT_KEEP))
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; keep: string; json: boolean }) => {
      try {
        const result = await listCheckpoints(opts.dir);
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          return;
        }
        if (!result.ok) {
          process.stdout.write(`No change ledger here: ${result.reason}\n`);
          return;
        }
        process.stdout.write(
          renderCheckpointList(result.value, new Date().toISOString(), Number(opts.keep)),
        );
      } catch (err) {
        _fail(err);
      }
    });

  checkpointCmd
    .command("show")
    .description("Show what restoring a checkpoint would change (reads only)")
    .argument("[id]", "checkpoint id, an unambiguous prefix, or 'latest'", "latest")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--json", "machine-readable output", false)
    .action(async (id: string, opts: { dir: string; json: boolean }) => {
      try {
        const found = await resolveCheckpoint(opts.dir, id);
        if (!found.ok) {
          process.stdout.write(`${found.reason}\n`);
          return;
        }
        const plan = await planRestore(opts.dir, found.value);
        if (!plan.ok) {
          process.stdout.write(`${plan.reason}\n`);
          return;
        }
        process.stdout.write(
          opts.json ? `${JSON.stringify(plan.value, null, 2)}\n` : renderRestorePlan(plan.value),
        );
      } catch (err) {
        _fail(err);
      }
    });

  checkpointCmd
    .command("restore")
    .alias("undo")
    .description(
      "DESTRUCTIVE: put worktree files back to a checkpoint (a pre-restore checkpoint is taken first)",
    )
    .argument("[id]", "checkpoint id, an unambiguous prefix, or 'latest'", "latest")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--yes", "skip the confirmation prompt", false)
    .action(async (id: string, opts: { dir: string; yes: boolean }) => {
      try {
        const found = await resolveCheckpoint(opts.dir, id);
        if (!found.ok) {
          process.stdout.write(`${found.reason}\n`);
          return;
        }
        const plan = await planRestore(opts.dir, found.value);
        if (!plan.ok) {
          process.stdout.write(`Cannot restore: ${plan.reason}\n`);
          return;
        }
        if (plan.value.restore.length === 0 && plan.value.delete.length === 0) {
          process.stdout.write(renderRestorePlan(plan.value));
          return;
        }
        const accepted = await confirmDestructive(
          renderRestorePlan(plan.value),
          `Discard the changes above and restore ${found.value.id}?`,
          { yes: opts.yes },
        );
        if (!accepted) {
          process.stdout.write("aborted — nothing was changed.\n");
          return;
        }
        const result = await restoreCheckpoint(opts.dir, found.value.id);
        if (!result.ok) {
          process.stdout.write(`Cannot restore: ${result.reason}\n`);
          return;
        }
        process.stdout.write(renderRestoreResult(result.value));
      } catch (err) {
        _fail(err);
      }
    });

  checkpointCmd
    .command("drop")
    .description("Delete one checkpoint's shadow ref")
    .argument("<id>", "checkpoint id, an unambiguous prefix, or 'latest'")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--yes", "skip the confirmation prompt", false)
    .action(async (id: string, opts: { dir: string; yes: boolean }) => {
      try {
        const found = await resolveCheckpoint(opts.dir, id);
        if (!found.ok) {
          process.stdout.write(`${found.reason}\n`);
          return;
        }
        const accepted = await confirmDestructive(
          `Drop checkpoint ${found.value.id} — "${found.value.note}" (${found.value.ref})\nNo working-tree file changes; the snapshot itself is lost.\n`,
          `Delete checkpoint ${found.value.id}?`,
          { yes: opts.yes },
        );
        if (!accepted) {
          process.stdout.write("aborted — the checkpoint is still there.\n");
          return;
        }
        const dropped = await dropCheckpoint(opts.dir, found.value.id);
        process.stdout.write(dropped.ok ? `dropped ${dropped.value.id}\n` : `${dropped.reason}\n`);
      } catch (err) {
        _fail(err);
      }
    });

  checkpointCmd
    .command("prune")
    .description("Delete all but the newest N checkpoints")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--keep <n>", "how many to retain", String(DEFAULT_KEEP))
    .action(async (opts: { dir: string; keep: string }) => {
      try {
        const keep = Number(opts.keep);
        if (!Number.isInteger(keep) || keep < 0)
          _fail(new Error(`--keep must be a non-negative integer (got "${opts.keep}")`));
        const result = await pruneCheckpoints(opts.dir, keep);
        process.stdout.write(
          result.ok
            ? `pruned ${result.value} checkpoint(s), keeping the ${keep} newest\n`
            : `${result.reason}\n`,
        );
      } catch (err) {
        _fail(err);
      }
    });
}
