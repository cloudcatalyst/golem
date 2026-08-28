/**
 * R12.5 — the companion app: a phone-shaped, read-only, installable view of the
 * dashboard that already existed.
 *
 * Three things this file pins, because all three are load-bearing for the gate:
 *   1. **Read-only is structural**, not a policy check — no write route exists
 *      and every method but GET/HEAD is refused, on every path, LAN bind or not.
 *   2. **Installable** — a real manifest and real PNG icons, generated with no
 *      dependency and decodable as images rather than merely served.
 *   3. **Never optimism** — the page carries the machinery to go stale, and no
 *      control affordance of any kind ships.
 *
 * What this file CANNOT prove is the half of the gate that names a real device:
 * "installable to a home screen on at least one platform, verified on a real
 * device". No test here holds a phone. See the task's close-out.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { StatsReport } from "../../src/cli/stats.js";
import {
  type DashboardHandle,
  type DashboardSnapshot,
  ICON_SIZES,
  iconPng,
  iconSizeForPath,
  LAN_HOST,
  LOOPBACK_HOST,
  lanAddresses,
  lanUrls,
  MANIFEST_PATH,
  manifestJson,
  startDashboard,
} from "../../src/dashboard/index.js";

const STATS: StatsReport = {
  source: "live",
  project_id: null,
  requests: 3,
  tokens_before: 900,
  tokens_after: 400,
  tokens_saved: 500,
  per_stage: {},
  ccr_refs_stored: 0,
  ccr_refs_retrieved: 0,
  note: "companion test",
};

function snapshot(): Promise<DashboardSnapshot> {
  return Promise.resolve({
    project_dir: "/tmp/example-project",
    compression: { level: "1", name: "lossless" },
    stats: STATS,
    generated_at: "2026-08-28T00:00:00.000Z",
    blocked: {
      waiting: true,
      status: "waiting",
      kind: "permission",
      project_name: "golem",
      since: "2026-08-28T00:00:00.000Z",
      tool: { name: "Bash", action_class: "destructive", argument: "rm -rf node_modules" },
    },
  });
}

describe("R12.5 — read-only is structural", () => {
  let handle: DashboardHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  // The whole security argument for putting this on a LAN is that there is
  // nothing to reach. If a method guard ever softens, that argument is gone —
  // so it is asserted per-method AND per-path rather than once.
  it("refuses every mutating method on every route", async () => {
    handle = await startDashboard({ port: 0, snapshot });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const path of ["/", "/api/stats", "/api/state", MANIFEST_PATH, "/icon-192.png"]) {
        const res = await fetch(new URL(path, handle.url), { method });
        expect(res.status, `${method} ${path}`).toBe(405);
      }
    }
  });

  it("ships no control affordance — no form, no button, no input", async () => {
    handle = await startDashboard({ port: 0, snapshot });
    const body = await (await fetch(handle.url)).text();
    expect(body).not.toMatch(/<form\b/i);
    expect(body).not.toMatch(/<button\b/i);
    expect(body).not.toMatch(/<input\b/i);
    expect(body).not.toMatch(/<textarea\b/i);
    // Nothing that could POST an answer back, either.
    expect(body).not.toMatch(/method\s*:\s*["']POST["']/i);
  });

  it("says out loud that it can answer nothing", async () => {
    handle = await startDashboard({ port: 0, snapshot });
    const body = await (await fetch(handle.url)).text();
    expect(body).toContain("This screen is read-only");
    expect(body).toContain("nothing here can answer the agent or start a turn");
  });

  it("still shows the block itself, argument included", async () => {
    handle = await startDashboard({ port: 0, snapshot });
    const body = await (await fetch(handle.url)).text();
    expect(body).toContain("Waiting on you");
    expect(body).toContain("rm -rf node_modules");
  });
});

describe("R12.5 — the bind", () => {
  let handle: DashboardHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  // The default must not move. Every caller that predates the companion app
  // omits `host`, and an omitted field has to keep meaning loopback.
  it("defaults to loopback when host is omitted", async () => {
    handle = await startDashboard({ port: 0, snapshot });
    expect(handle.host).toBe(LOOPBACK_HOST);
    expect(handle.url).toContain(LOOPBACK_HOST);
  });

  it("binds every interface on the opt-in, and still reports a browsable URL", async () => {
    handle = await startDashboard({ port: 0, host: LAN_HOST, snapshot });
    expect(handle.host).toBe(LAN_HOST);
    // `0.0.0.0` is a bind target, not a destination — the URL must not be it.
    expect(handle.url).not.toContain(LAN_HOST);
    expect(handle.url).toContain(LOOPBACK_HOST);
    // …and loopback still serves, so the desktop view is unaffected by the flag.
    expect((await fetch(handle.url)).status).toBe(200);
  });

  it("lists reachable LAN addresses, IPv4 first, skipping internal and link-local", () => {
    const addresses = lanAddresses({
      lo: [
        {
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8",
        },
      ],
      "Wi-Fi": [
        {
          address: "fe80::1",
          netmask: "ffff:ffff:ffff:ffff::",
          family: "IPv6",
          mac: "aa:bb:cc:dd:ee:ff",
          internal: false,
          cidr: "fe80::1/64",
          scopeid: 4,
        },
        {
          address: "2001:db8::5",
          netmask: "ffff:ffff:ffff:ffff::",
          family: "IPv6",
          mac: "aa:bb:cc:dd:ee:ff",
          internal: false,
          cidr: "2001:db8::5/64",
          scopeid: 0,
        },
        {
          address: "192.168.1.42",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "aa:bb:cc:dd:ee:ff",
          internal: false,
          cidr: "192.168.1.42/24",
        },
      ],
    });
    expect(addresses.map((a) => a.host)).toStrictEqual(["192.168.1.42", "[2001:db8::5]"]);
    expect(lanUrls(4654, { "Wi-Fi": [] })).toStrictEqual([]);
  });
});

describe("R12.5 — installable", () => {
  let handle: DashboardHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it("serves a web manifest that a home-screen install can use", async () => {
    handle = await startDashboard({ port: 0, snapshot });
    const res = await fetch(new URL(MANIFEST_PATH, handle.url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/manifest+json");
    const manifest = JSON.parse(await res.text());
    // `standalone` is what makes the launched icon open without browser chrome;
    // without it the install is a bookmark.
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toStrictEqual(
      ICON_SIZES.map((s) => `${s}x${s}`),
    );
  });

  it("serves every icon the manifest promises, as a decodable PNG", async () => {
    handle = await startDashboard({ port: 0, snapshot });
    for (const size of ICON_SIZES) {
      const res = await fetch(new URL(`/icon-${size}.png`, handle.url));
      expect(res.status, `icon-${size}`).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      const png = Buffer.from(await res.arrayBuffer());
      // Not "some bytes were served" — a real PNG signature, and an IHDR whose
      // declared dimensions match the size the manifest advertised.
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
      expect(png.subarray(12, 16).toString("latin1")).toBe("IHDR");
      expect(png.subarray(png.length - 8, png.length - 4).toString("latin1")).toBe("IEND");
    }
  });

  it("404s an icon size it never advertised", async () => {
    handle = await startDashboard({ port: 0, snapshot });
    expect((await fetch(new URL("/icon-64.png", handle.url))).status).toBe(404);
    expect(iconSizeForPath("/icon-64.png")).toBeNull();
    expect(iconSizeForPath("/icon-192.png")).toBe(192);
    expect(iconSizeForPath("/nope")).toBeNull();
  });

  it("generates icons deterministically and memoises them", () => {
    expect(iconPng(192).equals(iconPng(192))).toBe(true);
    expect(iconPng(192)).toBe(iconPng(192)); // same Buffer instance: cached
  });

  it("links the manifest and the iOS-only tags the manifest cannot cover", async () => {
    handle = await startDashboard({ port: 0, snapshot });
    const body = await (await fetch(handle.url)).text();
    expect(body).toContain(`<link rel="manifest" href="${MANIFEST_PATH}">`);
    // iOS ignores the manifest entirely; without these an Add to Home Screen
    // gets a screenshot for an icon and opens in Safari chrome.
    expect(body).toContain('<link rel="apple-touch-icon" href="/icon-180.png">');
    expect(body).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(body).toContain("viewport-fit=cover");
  });

  it("makes the manifest cacheable but never the state", async () => {
    handle = await startDashboard({ port: 0, snapshot });
    const manifest = await fetch(new URL(MANIFEST_PATH, handle.url));
    expect(manifest.headers.get("cache-control")).toContain("max-age");
    for (const path of ["/", "/api/stats"]) {
      const res = await fetch(new URL(path, handle.url));
      expect(res.headers.get("cache-control"), path).toBe("no-store");
    }
  });

  it("manifestJson is valid JSON on its own", () => {
    expect(() => JSON.parse(manifestJson())).not.toThrow();
  });
});

describe("R12.5 — phone-shaped and never optimistic", () => {
  let handle: DashboardHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it("carries the disconnected state, not a silent retry", async () => {
    handle = await startDashboard({ port: 0, snapshot });
    const body = await (await fetch(handle.url)).text();
    expect(body).toContain("Not connected — this screen is not updating");
    // The stale class is what greys the readout; a banner with no styling behind
    // it would leave live-looking numbers next to a "not connected" line.
    expect(body).toContain("body.stale");
    expect(body).toContain("visibilitychange");
    expect(body).toContain('window.addEventListener("offline"');
  });

  it("is laid out for a phone first, widening at a breakpoint", async () => {
    handle = await startDashboard({ port: 0, snapshot });
    const body = await (await fetch(handle.url)).text();
    expect(body).toContain("@media (min-width: 40rem)");
    expect(body).toContain("env(safe-area-inset-");
    // The wide table scrolls in its own box rather than making the body scroll.
    expect(body).toContain('class="scroll-x"');
  });
});
