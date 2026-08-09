/**
 * golem wiki — extracted from program.ts (R8.27).
 */

import type { Command } from "commander";
import { findProjectDir, loadConfig } from "../../config/index.js";
import { distillOne, pendingDrafts, renderPendingDrafts } from "../distill.js";
import { InitError, type InitReport } from "../init.js";
import {
  draftTargetRelPath,
  listPendingPromotions,
  renderPendingPromotions,
  runPromote,
} from "../promote.js";
import { synthesizeWeeklyReport } from "../synthesize.js";
import {
  checkWiki,
  defaultUserWikiDir,
  golemWikiInit,
  resolveWikiDir,
  type WikiCheckReport,
} from "../wiki.js";

const _DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();

function _fail(err: unknown): never {
  process.stderr.write(`golem: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(err instanceof InitError ? 2 : 1);
}

function printReport(report: InitReport): void {
  for (const action of report.actions)
    process.stdout.write(`  ${action.kind.padEnd(8)} ${action.path} — ${action.detail}\n`);
  if (report.dryRun) process.stdout.write("dry run: nothing was written.\n");
}

function printWikiCheckReport(report: WikiCheckReport): void {
  if (report.issues.length === 0) {
    process.stdout.write(`golem wiki check: ${report.pagesChecked} page(s), no issues.\n`);
    return;
  }
  for (const issue of report.issues)
    process.stdout.write(`  ${issue.relPath} — ${issue.message}\n`);
  process.stdout.write(
    `golem wiki check: ${report.pagesChecked} page(s), ${report.issues.length} issue(s).\n`,
  );
}

export default function register(program: Command): void {
  const wiki = program.command("wiki").description("Golem project wiki (spec Decision 28)");

  wiki
    .command("init")
    .description("Scaffold the project wiki (WIKI.md schema + zone directories)")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--dry-run", "show what would change without writing", false)
    .option(
      "--user",
      "scaffold the user-scope wiki (~/.golem/wiki/) instead of the project wiki",
      false,
    )
    .action(async (opts: { dir: string; dryRun: boolean; user: boolean }) => {
      try {
        const wikiDir = opts.user
          ? defaultUserWikiDir()
          : resolveWikiDir(
              opts.dir,
              (await loadConfig({ projectDir: opts.dir })).settings.knowledge.wiki_dir,
            );
        const report = await golemWikiInit({
          projectDir: opts.user ? wikiDir : opts.dir,
          wikiDir,
          dryRun: opts.dryRun,
        });
        printReport(report);
      } catch (err) {
        _fail(err);
      }
    });

  wiki
    .command("check")
    .description("Lint wiki pages: frontmatter, dates, wikilinks, duplicate titles")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .action(async (opts: { dir: string }) => {
      try {
        const { settings } = await loadConfig({ projectDir: opts.dir });
        const wikiDir = resolveWikiDir(opts.dir, settings.knowledge.wiki_dir);
        const report = await checkWiki(wikiDir);
        printWikiCheckReport(report);
        if (report.issues.length > 0) process.exitCode = 1;
      } catch (err) {
        _fail(err);
      }
    });

  wiki
    .command("distill")
    .description("Distill a cached page into a zone-1 source-note draft (local model, T3)")
    .argument("[url]", "URL to distill (must already be cached by a prior WebFetch)")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--pending", "list drafts awaiting review instead of distilling one", false)
    .option("--force", "re-distill even if a draft already exists for this URL", false)
    .option("--json", "machine-readable output", false)
    .action(
      async (
        url: string | undefined,
        opts: { dir: string; pending: boolean; force: boolean; json: boolean },
      ) => {
        try {
          if (opts.pending) {
            const drafts = await pendingDrafts(opts.dir);
            if (opts.json) {
              process.stdout.write(
                `${JSON.stringify(
                  drafts.map((d) => ({
                    slug: d.slug,
                    path: d.path,
                    title: d.frontmatter.title,
                    sources: d.frontmatter.sources,
                  })),
                  null,
                  2,
                )}\n`,
              );
              return;
            }
            process.stdout.write(renderPendingDrafts(drafts));
            return;
          }
          if (url === undefined)
            throw new InitError("provide a URL to distill, or pass --pending to list drafts");
          const result = await distillOne({ projectDir: opts.dir, url, force: opts.force });
          process.stdout.write(
            result.kind === "exists"
              ? `draft already exists: ${result.path} (pass --force to re-distill)\n`
              : `distilled: ${result.path}\n`,
          );
        } catch (err) {
          _fail(err);
        }
      },
    );

  wiki
    .command("synthesize")
    .description(
      "Draft a weekly synthesis of recent debriefs + notes into a zone-1 draft (local model, R3.4)",
    )
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--days <n>", "how many days back to gather from", "7")
    .action(async (opts: { dir: string; days: string }) => {
      try {
        const days = Number(opts.days);
        if (!Number.isInteger(days) || days <= 0)
          throw new InitError(`invalid --days "${opts.days}"`);
        const result = await synthesizeWeeklyReport({ projectDir: opts.dir, days });
        process.stdout.write(
          `synthesized: ${result.path} (${result.debriefCount} debrief(s), ${result.noteCount} note(s))\n`,
        );
      } catch (err) {
        _fail(err);
      }
    });

  wiki
    .command("promote")
    .description(
      "Review and apply a pending distill draft as a wiki page (Decision 29 append-and-refine)",
    )
    .argument("[id]", "draft id (slug) to promote; omit (or use --list) to list pending drafts")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--list", "list pending drafts instead of promoting", false)
    .option("--yes", "skip the confirmation prompt (required in non-interactive use)", false)
    .option("--json", "machine-readable output (with --list)", false)
    .action(
      async (
        id: string | undefined,
        opts: { dir: string; list: boolean; yes: boolean; json: boolean },
      ) => {
        try {
          const { settings } = await loadConfig({ projectDir: opts.dir });
          const wikiDir = resolveWikiDir(opts.dir, settings.knowledge.wiki_dir);
          const nowIso = new Date().toISOString();
          if (id === undefined || opts.list) {
            const drafts = await listPendingPromotions(opts.dir);
            if (opts.json) {
              process.stdout.write(
                `${JSON.stringify(
                  drafts.map((d) => ({
                    id: d.slug,
                    type: d.frontmatter.type,
                    target: draftTargetRelPath(d),
                    sources: d.frontmatter.sources,
                    created: d.frontmatter.created,
                  })),
                  null,
                  2,
                )}\n`,
              );
              return;
            }
            process.stdout.write(renderPendingPromotions(drafts, nowIso));
            return;
          }
          const outcome = await runPromote({
            projectDir: opts.dir,
            wikiDir,
            slug: id,
            nowIso,
            yes: opts.yes,
          });
          if (outcome.kind === "cancelled") {
            process.stdout.write("aborted — draft left in place.\n");
            return;
          }
          process.stdout.write(
            `${outcome.created ? "created" : "updated"}: ${outcome.relPath} (draft ${outcome.slug} consumed)\n`,
          );
        } catch (err) {
          _fail(err);
        }
      },
    );
}
