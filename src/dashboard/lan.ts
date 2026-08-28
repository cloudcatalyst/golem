/**
 * R12.5 — which addresses a phone on the same network can actually reach.
 *
 * The dashboard binds loopback by DEFAULT and always has (`startDashboard`'s
 * hard requirement since WS-E E3). The companion app needs the opposite, so the
 * LAN bind is an explicit opt-in — and an opt-in the user cannot act on unless
 * Golem prints the URL to type into the phone. `127.0.0.1` is not that URL.
 *
 * Pure over an injected interface map so tests never depend on the host's real
 * network.
 */

import { networkInterfaces } from "node:os";

/** A reachable address the dashboard is serving on. */
export interface LanAddress {
  /** The interface name the OS reports (`Wi-Fi`, `en0`, `eth0`). */
  readonly iface: string;
  /** The address itself, already bracketed if it is IPv6. */
  readonly host: string;
  readonly family: "IPv4" | "IPv6";
}

type InterfaceMap = ReturnType<typeof networkInterfaces>;

/**
 * Non-internal, non-link-local addresses, IPv4 first.
 *
 * Link-local IPv6 (`fe80::/10`) is excluded deliberately: it needs a zone index
 * (`%en0`) that means nothing on the phone, so printing it as a URL to type
 * would be printing something that cannot work.
 */
export function lanAddresses(interfaces: InterfaceMap = networkInterfaces()): LanAddress[] {
  const out: LanAddress[] = [];
  for (const [iface, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.internal) continue;
      const family = String(addr.family) === "6" || addr.family === "IPv6" ? "IPv6" : "IPv4";
      if (family === "IPv6" && addr.address.toLowerCase().startsWith("fe80")) continue;
      out.push({
        iface,
        host: family === "IPv6" ? `[${addr.address}]` : addr.address,
        family,
      });
    }
  }
  return out.sort((a, b) => (a.family === b.family ? 0 : a.family === "IPv4" ? -1 : 1));
}

/** The URLs to type into a phone, in the order worth trying. */
export function lanUrls(port: number, interfaces: InterfaceMap = networkInterfaces()): string[] {
  return lanAddresses(interfaces).map((a) => `http://${a.host}:${port}/`);
}
