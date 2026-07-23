/**
 * R6.2 v1 — `golem account` CLI: registry listing (never leaking secrets),
 * fail-closed switching, and the ADR-0003 audit log.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectAccounts, renderAccounts, useAccount } from "../../../src/cli/accounts.js";
import { writeSetting } from "../../../src/config/index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "golem-acct-"));
  await writeSetting(
    "project",
    "proxy.accounts",
    [
      { id: "work", provider: "openai", base_url: "https://api.openai.com/v1", model: "gpt-5.2" },
      {
        id: "local",
        provider: "ollama",
        base_url: "http://gpubox.lan:11434/v1",
        model: "qwen2.5-coder:7b",
      },
    ],
    { projectDir: dir },
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("collectAccounts", () => {
  it("lists accounts with key-set flags (never the key) and no active by default", async () => {
    const report = await collectAccounts(dir, { GOLEM_UPSTREAM_API_KEY__WORK: "sk-x" });
    expect(report.active).toBeNull();
    expect(report.accounts).toHaveLength(2);
    const work = report.accounts.find((a) => a.id === "work");
    expect(work).toMatchObject({
      provider: "openai",
      key_env: "GOLEM_UPSTREAM_API_KEY__WORK",
      key_set: true,
    });
    const local = report.accounts.find((a) => a.id === "local");
    expect(local?.key_set).toBe(false);
    // The report carries no secret values anywhere.
    expect(JSON.stringify(report)).not.toContain("sk-x");
  });
});

describe("useAccount", () => {
  it("switches the active account, marks it, and appends an audit line", async () => {
    await useAccount(dir, "work", "2026-07-23T00:00:00.000Z");
    const report = await collectAccounts(dir, {});
    expect(report.active).toBe("work");
    expect(report.accounts.find((a) => a.id === "work")?.active).toBe(true);

    const log = await readFile(path.join(dir, ".golem", "state", "account-log.jsonl"), "utf8");
    expect(JSON.parse(log.trim())).toEqual({
      ts: "2026-07-23T00:00:00.000Z",
      action: "use",
      account: "work",
    });
  });

  it("rejects an unknown account id (fail-closed, no silent creation)", async () => {
    await expect(useAccount(dir, "ghost", "2026-07-23T00:00:00.000Z")).rejects.toThrow(
      /unknown account/,
    );
    expect((await collectAccounts(dir, {})).active).toBeNull();
  });

  it("clears the active account with id=null", async () => {
    await useAccount(dir, "work", "2026-07-23T00:00:00.000Z");
    await useAccount(dir, null, "2026-07-23T00:01:00.000Z");
    expect((await collectAccounts(dir, {})).active).toBeNull();
  });
});

describe("renderAccounts", () => {
  it("marks the active account and flags a missing credential", async () => {
    await useAccount(dir, "local", "2026-07-23T00:00:00.000Z");
    const out = renderAccounts(await collectAccounts(dir, {}));
    expect(out).toContain("* local");
    expect(out).toContain("key MISSING");
    expect(out).toContain("active: local");
  });
});
