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
import { buildSpawnEnv, CREDENTIALS_INJECTED_ENV } from "../../../src/cli/proxy-daemon.js";

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

  /**
   * R9.20 — the marker that stops the child re-resolving what the parent already
   * injected. The proxy paid the credential cost twice per restart (~13.3s of an
   * ~18s restart at the measured 6668ms), and the child's own injection is `??=`,
   * so the second result was discarded every time.
   *
   * `buildSpawnEnv` must pass it through like any other injected var — it is
   * `startDetached` that supplies it, precisely so the marker cannot be set
   * without the credentials it describes.
   */
  it("carries the credentials-injected marker through as an ordinary injected var", () => {
    const env = buildSpawnEnv(
      { PATH: "/usr/bin" },
      { [CREDENTIALS_INJECTED_ENV]: "1", GOLEM_UPSTREAM_API_KEY: "sk-live" },
    );
    expect(env[CREDENTIALS_INJECTED_ENV]).toBe("1");
    expect(env.GOLEM_UPSTREAM_API_KEY).toBe("sk-live");
  });

  it("does not let a stray marker leak in from the spawning shell", () => {
    // It means "the parent resolved for you". If a shell export could set it, a
    // hand-run daemon would skip resolution and start with no credential at all —
    // the allowlist is what makes the marker trustworthy.
    const env = buildSpawnEnv({ PATH: "/usr/bin", [CREDENTIALS_INJECTED_ENV]: "1" });
    expect(env[CREDENTIALS_INJECTED_ENV]).toBeUndefined();
  });
});
