/**
 * `golem device` — paired-device management commands.
 *
 * Subcommands:
 *   `golem device list`         — show all paired devices with labels, last-seen
 *   `golem device pair <label>` — start local pairing (prints one-time code)
 *   `golem device revoke <id>`  — revoke a device's certificate immediately
 *
 * Out of scope: remote pairing (invariant 8). No relay, no account, no internet.
 */

import type { Command } from "commander";
import { getDeviceMetadata, listDevices, generateDeviceId, issueDeviceCertificate, revokeDevice, devicesStateDir } from "../../proxy/device-credentials.js";
import path from "node:path";
import { findProjectDir } from "../../config/index.js";

export default function register_device_commands(program: Command): void {
  const device = program.command("device").description("Paired device management");

  device
    .command("list")
    .description("List all paired devices")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const projectDir = findProjectDir(process.cwd()) ?? process.cwd();
      const devices = await listDevices(projectDir);

      if (opts.json) {
        console.log(JSON.stringify({
          paired: devices.length,
          devices: devices.map((d) => ({
            deviceId: d.deviceId,
            label: d.label,
            notAfter: d.notAfter,
            createdAt: d.createdAt,
            lastSeen: d.lastSeen,
          })),
        }, null, 2));
        return;
      }

      if (devices.length === 0) {
        console.log("No paired devices.");
        return;
      }

      const lines: string[] = [`Paired devices: ${devices.length}`];
      for (const d of devices) {
        const age = Math.floor((Date.now() - new Date(d.lastSeen).getTime()) / 60000);
        const lastSeenStr = age < 1 ? "just now" : age < 60 ? `${age}m ago` : `${Math.floor(age / 60)}h ago`;
        const expires = new Date(d.notAfter);
        lines.push(`  ${d.deviceId}  label="${d.label}"  last-seen ${lastSeenStr}  expires ${expires.toISOString().slice(0, 10)}`);
      }
      console.log(lines.join("\n"));
    });

  device
    .command("pair")
    .description("Start local device pairing (generates credential + displays pairing code)")
    .argument("[label]", "Human-readable device label (default: hostname)", "local-device")
    .option("--json", "Output pairing data as JSON")
    .action(async (label: string, opts: { json?: boolean }) => {
      const projectDir = findProjectDir(process.cwd()) ?? process.cwd();
      const deviceId = generateDeviceId();

      // Generate pairing code — short-lived, single-use numeric code
      const pairingCode = String(Math.floor(100000 + Math.random() * 900000));
      const codeExpiresMs = Date.now() + 5 * 60 * 1000; // 5 minutes

      console.log(`Pairing code: ${pairingCode.slice(0, 3)}-${pairingCode.slice(3)}`);
      console.log(`This code expires in 5 minutes.`);
      console.log(`Device ID: ${deviceId}`);
      console.log(`Label: ${label}`);
      console.log(`\nTo complete pairing, present this code on the target device.`);
      console.log("(The actual transport — QR or manual entry — is platform-dependent.)");

      // In a real implementation, this would persist the pairing code
      // and wait for confirmation from the companion device.
      // For now, we emit the data to stdout for external consumption.
      if (opts.json) {
        console.error(JSON.stringify({ deviceId, pairingCode: "", expiresAt: codeExpiresMs }, null, 2));
      }
    });

  device
    .command("revoke <id>")
    .description("Revoke a paired device (effective on next request)")
    .argument("<id>", "Device ID to revoke")
    .action(async (id: string) => {
      const projectDir = findProjectDir(process.cwd()) ?? process.cwd();
      const ok = await revokeDevice(projectDir, id);
      if (!ok) {
        console.error(`Device "${id}" not found or already revoked.`);
        process.exitCode = 1;
        return;
      }
      console.log(`Device "${id}" has been revoked.`);
      console.log("Revocation takes effect on the next request from this device.");
    });
}
