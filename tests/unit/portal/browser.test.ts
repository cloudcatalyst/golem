/**
 * Opening a browser, and the refusal that must not look like a timeout.
 *
 * The headless message is asserted on its CONTENT, not just its existence:
 * "there is no device authorization grant, so this cannot work here" is a
 * different instruction to a user than "something went wrong", and the whole
 * reason the check exists is that the alternative failure mode is a silent
 * five-minute wait on a listener nobody will ever reach.
 */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  HEADLESS_MESSAGE,
  hasDisplay,
  openerCommand,
  printingBrowser,
  systemBrowser,
} from "../../../src/portal/index.js";

/** A child process that reports a successful spawn, then nothing. */
function fakeChild(outcome: "spawn" | "error", error?: Error) {
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  child.unref = () => {};
  queueMicrotask(() => {
    if (outcome === "spawn") child.emit("spawn");
    else child.emit("error", error ?? new Error("spawn xdg-open ENOENT"));
  });
  return child;
}

describe("openerCommand", () => {
  it("uses each platform's default-handler launcher", () => {
    expect(openerCommand("darwin")).toEqual({ file: "open", args: [] });
    expect(openerCommand("linux")).toEqual({ file: "xdg-open", args: [] });
    expect(openerCommand("win32").file).toBe("rundll32.exe");
  });

  it("passes the URL as its own argument on Windows, with no shell involved", () => {
    // The authorization URL is full of `&`. Anything that routes it through
    // cmd.exe splits it into several commands.
    const { file, args } = openerCommand("win32");
    expect(file).not.toMatch(/cmd/i);
    expect(args).toEqual(["url.dll,FileProtocolHandler"]);
  });
});

describe("hasDisplay", () => {
  it("assumes a session exists on Windows and macOS", () => {
    expect(hasDisplay({ platform: "win32", env: {} })).toBe(true);
    expect(hasDisplay({ platform: "darwin", env: {} })).toBe(true);
  });

  it("detects a headless Linux session", () => {
    expect(hasDisplay({ platform: "linux", env: {} })).toBe(false);
    expect(hasDisplay({ platform: "linux", env: { DISPLAY: "" } })).toBe(false);
  });

  it("accepts X11 or Wayland", () => {
    expect(hasDisplay({ platform: "linux", env: { DISPLAY: ":0" } })).toBe(true);
    expect(hasDisplay({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } })).toBe(true);
  });
});

describe("systemBrowser", () => {
  it("spawns the launcher with the URL as a single argument", async () => {
    const spawnImpl = vi.fn(() => fakeChild("spawn"));
    await systemBrowser({
      platform: "linux",
      env: { DISPLAY: ":0" },
      spawnImpl: spawnImpl as never,
    }).open("https://clerk.example.test/oauth/authorize?a=1&b=2");

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [file, args, opts] = spawnImpl.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(file).toBe("xdg-open");
    // One argument, un-split: argument-array spawn, per CLAUDE.md's hard rule.
    expect(args).toEqual(["https://clerk.example.test/oauth/authorize?a=1&b=2"]);
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe("ignore");
  });

  it("refuses on a headless machine, and says no device grant exists", async () => {
    const spawnImpl = vi.fn(() => fakeChild("spawn"));
    const browser = systemBrowser({
      platform: "linux",
      env: {},
      spawnImpl: spawnImpl as never,
    });
    await expect(browser.open("https://x.test")).rejects.toMatchObject({ kind: "no_browser" });
    // It must not have tried and hung: the check comes first.
    expect(spawnImpl).not.toHaveBeenCalled();

    expect(HEADLESS_MESSAGE).toContain("RFC 8628");
    expect(HEADLESS_MESSAGE).toContain("no device");
    expect(HEADLESS_MESSAGE).toContain("machine with a browser");
  });

  it("reports a missing launcher rather than waiting out the listener deadline", async () => {
    const spawnImpl = vi.fn(() => fakeChild("error"));
    const browser = systemBrowser({
      platform: "linux",
      env: { DISPLAY: ":0" },
      spawnImpl: spawnImpl as never,
    });
    await expect(browser.open("https://x.test")).rejects.toMatchObject({ kind: "no_browser" });
    await browser.open("https://x.test").catch((err: Error) => {
      expect(err.message).toContain("--no-browser");
    });
  });
});

describe("printingBrowser", () => {
  it("prints the URL instead of opening it, on any platform", async () => {
    const written: string[] = [];
    await printingBrowser((t) => written.push(t)).open(
      "https://clerk.example.test/oauth/authorize",
    );
    expect(written.join("")).toContain("https://clerk.example.test/oauth/authorize");
  });
});
