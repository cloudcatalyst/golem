/**
 * `golem` on its own IS the control panel (Decision 51 — `golem ui` and
 * `golem settings` were removed and their flags moved onto the bare command).
 *
 * `parsePanelArgs` is therefore the panel's only entry point AND the thing standing
 * between a typo and commander's error messages, so its accept/reject boundary is
 * pinned here. Getting it wrong in either direction is bad: too permissive and a
 * mistyped flag silently opens a UI, too strict and the documented flags break.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePanelArgs } from "../../src/cli/panel-args.js";

const argv = (...args: string[]) => ["node", "/x/dist/cli/main.js", ...args];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("what opens the panel", () => {
  it("bare `golem`, with defaults", () => {
    expect(parsePanelArgs(argv())).toEqual({ pet: true, advanced: false });
  });

  it("accepts each panel flag", () => {
    expect(parsePanelArgs(argv("--no-pet"))).toEqual({ pet: false, advanced: false });
    expect(parsePanelArgs(argv("--advanced"))).toEqual({ pet: true, advanced: true });
    expect(parsePanelArgs(argv("--dir", "/tmp/p"))).toEqual({
      dir: "/tmp/p",
      pet: true,
      advanced: false,
    });
  });

  it("accepts `--dir=<path>` as well as `--dir <path>`", () => {
    expect(parsePanelArgs(argv("--dir=/tmp/p"))?.dir).toBe("/tmp/p");
    // A Windows path with a drive letter and spaces must survive intact.
    expect(parsePanelArgs(argv("--dir", "D:\\My Code\\repo"))?.dir).toBe("D:\\My Code\\repo");
  });

  it("accepts the flags together, in any order", () => {
    expect(parsePanelArgs(argv("--advanced", "--dir", "/p", "--no-pet"))).toEqual({
      dir: "/p",
      pet: false,
      advanced: true,
    });
    expect(parsePanelArgs(argv("--no-pet", "--dir=/p", "--advanced"))).toEqual({
      dir: "/p",
      pet: false,
      advanced: true,
    });
  });
});

describe("what goes to commander instead", () => {
  it("defers --help and --version, so commander owns them", () => {
    for (const flag of ["--help", "-h", "--version", "-V", "help"]) {
      expect(parsePanelArgs(argv(flag)), flag).toBeNull();
    }
  });

  it("defers every named command", () => {
    for (const cmd of ["status", "config", "init", "proxy", "slider", "hook", "statusline"]) {
      expect(parsePanelArgs(argv(cmd)), cmd).toBeNull();
    }
    expect(parsePanelArgs(argv("config", "list"))).toBeNull();
  });

  it("defers an unrecognised flag rather than opening a panel", () => {
    // The point: a typo must be reported by the tool that owns flag parsing.
    for (const bad of ["--pet", "--no-advanced", "--dirr", "--json", "-x", "--dir-x"]) {
      expect(parsePanelArgs(argv(bad)), bad).toBeNull();
    }
  });

  it("defers a `--dir` with no usable value", () => {
    expect(parsePanelArgs(argv("--dir"))).toBeNull();
    expect(parsePanelArgs(argv("--dir="))).toBeNull();
    // A following flag is not a directory.
    expect(parsePanelArgs(argv("--dir", "--no-pet"))).toBeNull();
  });

  it("defers a panel flag mixed with a command", () => {
    expect(parsePanelArgs(argv("--no-pet", "status"))).toBeNull();
    expect(parsePanelArgs(argv("status", "--no-pet"))).toBeNull();
  });
});

describe("the documented flags and the accepted flags agree", () => {
  it("every flag `golem --help` advertises is one parsePanelArgs accepts", async () => {
    // program.ts documents the panel in help text (it has no subcommand to carry
    // its options), so the two can drift. They must not.
    const program = await readFile(path.join(repoRoot, "src/cli/program.ts"), "utf8");
    const helpBlock = /Control panel:([\s\S]*?)`,\n\);/.exec(program)?.[1] ?? "";
    expect(helpBlock, "the Control panel help block is gone from program.ts").not.toBe("");
    const advertised = [...helpBlock.matchAll(/\s(--[a-z-]+)/g)].map((m) => m[1]);
    expect(advertised.length).toBeGreaterThan(0);
    for (const flag of advertised) {
      const withValue = flag === "--dir" ? argv(flag, "/tmp/p") : argv(flag ?? "");
      expect(parsePanelArgs(withValue), `${flag} is documented but not accepted`).not.toBeNull();
    }
  });

  it("no longer registers `ui` or `settings` as commands", async () => {
    const program = await readFile(path.join(repoRoot, "src/cli/program.ts"), "utf8");
    expect(program).not.toContain('.command("ui")');
    expect(program).not.toContain('.command("settings")');
    // ...and the removal is explained rather than left as "unknown command".
    const main = await readFile(path.join(repoRoot, "src/cli/main.ts"), "utf8");
    expect(main).toContain("REMOVED_PANEL_COMMANDS");
  });
});
