/**
 * Decision 46 — the daemon does not inherit the spawning shell's env.
 *
 * `buildSpawnEnv` is the fix for "key set in one terminal but the proxy says
 * key missing": the daemon starts from a minimal allowlist (PATH + home) plus
 * explicitly injected vars (the resolved credential), so a stray GOLEM_* var in
 * one terminal can no longer silently un-configure it — and a stored credential
 * reaches it deterministically.
 */

import { describe, expect, it } from "vitest";
import { buildSpawnEnv } from "../../../src/cli/proxy-daemon.js";

describe("buildSpawnEnv", () => {
  it("keeps only the minimal allowlist from the base env", () => {
    const env = buildSpawnEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      GOLEM_UPSTREAM_API_KEY__KIMI: "sk-should-not-leak",
      GOLEM_PROXY_PORT: "9999",
      SOME_RANDOM_VAR: "x",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/u");
    // Stray GOLEM_* and unrelated vars from the shell do NOT leak through.
    expect(env.GOLEM_UPSTREAM_API_KEY__KIMI).toBeUndefined();
    expect(env.GOLEM_PROXY_PORT).toBeUndefined();
    expect(env.SOME_RANDOM_VAR).toBeUndefined();
  });

  it("injects the resolved credential explicitly", () => {
    const env = buildSpawnEnv({ PATH: "/usr/bin" }, { GOLEM_UPSTREAM_API_KEY__KIMI: "sk-live" });
    expect(env.GOLEM_UPSTREAM_API_KEY__KIMI).toBe("sk-live");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("injected vars win over the base allowlist", () => {
    const env = buildSpawnEnv({ PATH: "/usr/bin" }, { PATH: "/custom" });
    expect(env.PATH).toBe("/custom");
  });

  it("omits allowlist vars that are unset in the base", () => {
    const env = buildSpawnEnv({});
    expect(Object.keys(env)).toHaveLength(0);
  });
});
