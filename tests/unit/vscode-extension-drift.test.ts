/**
 * R9.16 — shipped-vs-deployed drift for the VS Code extension.
 *
 * The bug these exist for: the status bar named the coder's model as
 * `qwen2.5-coder:7b` while the CLI correctly named `claude-sonnet-5`, because
 * the DEPLOYED `render.js` was three releases behind and `init` skipped it on
 * "the directory exists".
 *
 * `vscode-extension/render.test.js` passed throughout — it tests the **repo**
 * copy, and a test that only ever sees the source cannot detect a stale
 * deployment. So these assert against a fake extensions directory instead.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  defaultVscodeExtensionsDir,
  inspectVscodeExtension,
  staleExtensionWarning,
} from "../../src/cli/vscode-extension.js";
import { useTempDirs } from "../helpers/tmp.js";

let base: string;
let sourceDir: string;
let extensionsDir: string;

const ID = "golem-run.golem-vscode-9.9.9";

async function writeShipped(render: string): Promise<void> {
  await mkdir(path.join(sourceDir, "media"), { recursive: true });
  await writeFile(
    path.join(sourceDir, "package.json"),
    JSON.stringify({ publisher: "golem-run", name: "golem-vscode", version: "9.9.9" }),
    "utf8",
  );
  await writeFile(path.join(sourceDir, "extension.js"), "// extension\n", "utf8");
  await writeFile(path.join(sourceDir, "render.js"), render, "utf8");
  await writeFile(path.join(sourceDir, "README.md"), "# readme\n", "utf8");
  await writeFile(path.join(sourceDir, "media", "icon.svg"), "<svg/>", "utf8");
}

/** Deploy a copy of the shipped tree, optionally with a different render.js. */
async function deploy(render?: string): Promise<void> {
  const target = path.join(extensionsDir, ID);
  await mkdir(path.join(target, "media"), { recursive: true });
  await writeFile(
    path.join(target, "package.json"),
    JSON.stringify({ publisher: "golem-run", name: "golem-vscode", version: "9.9.9" }),
    "utf8",
  );
  await writeFile(path.join(target, "extension.js"), "// extension\n", "utf8");
  await writeFile(path.join(target, "render.js"), render ?? "// current renderer\n", "utf8");
  await writeFile(path.join(target, "README.md"), "# readme\n", "utf8");
  await writeFile(path.join(target, "media", "icon.svg"), "<svg/>", "utf8");
}

const newTempDir = useTempDirs("golem-vsx-");

beforeEach(async () => {
  base = await newTempDir();
  sourceDir = path.join(base, "shipped");
  extensionsDir = path.join(base, "extensions");
  await mkdir(extensionsDir, { recursive: true });
  await writeShipped("// current renderer\n");
});

describe("inspectVscodeExtension", () => {
  it("reports current when the deployed bytes match", async () => {
    await deploy();
    const report = await inspectVscodeExtension({ sourceDir, extensionsDir });
    expect(report.state).toBe("current");
    expect(report.staleFiles).toEqual([]);
    expect(report.id).toBe(ID);
  });

  it("names the stale file — the exact case that shipped a wrong model", async () => {
    await deploy("// three releases behind\n");
    const report = await inspectVscodeExtension({ sourceDir, extensionsDir });
    expect(report.state).toBe("stale");
    expect(report.staleFiles).toEqual(["render.js"]);
    expect(staleExtensionWarning(report)).toContain("render.js");
    expect(staleExtensionWarning(report)).toContain("golem init");
  });

  it("notices drift inside the media directory, not just top-level files", async () => {
    await deploy();
    await writeFile(
      path.join(extensionsDir, ID, "media", "icon.svg"),
      "<svg>changed</svg>",
      "utf8",
    );
    const report = await inspectVscodeExtension({ sourceDir, extensionsDir });
    expect(report.state).toBe("stale");
    expect(report.staleFiles).toEqual(["media"]);
  });

  it("notices a file added to the deployed media directory", async () => {
    await deploy();
    await writeFile(path.join(extensionsDir, ID, "media", "extra.svg"), "<svg/>", "utf8");
    const report = await inspectVscodeExtension({ sourceDir, extensionsDir });
    expect(report.state).toBe("stale");
  });

  it("reports absent when this version was never deployed", async () => {
    const report = await inspectVscodeExtension({ sourceDir, extensionsDir });
    expect(report.state).toBe("absent");
    expect(report.staleFiles).toEqual([]);
    expect(report.dir).toBe(path.join(extensionsDir, ID));
  });

  it("is unknown — not absent — when there is no VS Code", async () => {
    expect((await inspectVscodeExtension({ sourceDir, extensionsDir: null })).state).toBe(
      "unknown",
    );
    expect(
      (await inspectVscodeExtension({ sourceDir, extensionsDir: path.join(base, "nope") })).state,
    ).toBe("unknown");
  });

  it("is unknown when no extension source ships with this install", async () => {
    const report = await inspectVscodeExtension({
      sourceDir: path.join(base, "not-shipped"),
      extensionsDir,
    });
    expect(report.state).toBe("unknown");
  });

  it("ignores an older version's directory — the id carries the version", async () => {
    await mkdir(path.join(extensionsDir, "golem-run.golem-vscode-0.7.0"), { recursive: true });
    const report = await inspectVscodeExtension({ sourceDir, extensionsDir });
    expect(report.state).toBe("absent");
  });

  it("resolves the default extensions dir from the home directory", () => {
    expect(defaultVscodeExtensionsDir("/home/dev")).toBe(
      path.join("/home/dev", ".vscode", "extensions"),
    );
  });
});
