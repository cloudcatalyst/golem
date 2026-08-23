/**
 * `golem device` — paired-device management commands.
 *
 * Subcommands:
 *   `golem device list`        — show all paired devices with labels, last-seen
 *   `golem device pair <label>` — generate credentials + display pairing code
 *   `golem device revoke <id>`  — revoke a device's certificate immediately
 */

import type { Command } from "commander";
import {
  getDeviceMetadata,
  listDevices,
  generateDeviceId,
} from "../../proxy/device-credentials.js";

export default function register_device_commands(program: Command): void {
  const device = program.command("device").description("Paired device management");

  device
    .command("list")
    .description("List all paired devices")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const projectDir = process.cwd();
      const devices = await listDevices(projectDir);

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              paired: devices.length,
              devices: devices.map((d) => ({
                deviceId: d.deviceId,
                label: d.label,
                notAfter: d.notAfter,
                createdAt: d.createdAt,
                lastSeen: d.lastSeen,
              })),
            },
            null,
            2,
          ),
        );
        return;
      }

      if (devices.length === 0) {
        console.log("No paired devices.");
        return;
      }

      const lines: string[] = [`Paired devices: ${devices.length}`];
      for (const d of devices) {
        const ageMs = Date.now() - new Date(d.lastSeen).getTime();
        const ageMin = Math.floor(ageMs / 60000);
        const lastSeenStr =
          ageMin < 1
            ? "just now"
            : ageMin < 60
              ? `${ageMin}m ago`
              : `${Math.floor(ageMin / 60)}h ago`;
        const expires = new Date(d.notAfter);
        lines.push(
          `  ${d.deviceId}  label="${d.label}"  last-seen ${lastSeenStr}  expires ${expires.toISOString().slice(0, 10)}`,
        );
      }
      console.log(lines.join("\n"));
    });

  device
    .command("pair [label]")
    .description("Generate device credentials and display pairing code")
    .argument("[label]", "Human-readable device label", "local-device")
    .action(async (label: string) => {
      const projectDir = process.cwd();
      const deviceId = generateDeviceId();
      const pairingCode = String(Math.floor(100000 + Math.random() * 900000));

      console.log(`Pairing code: ${pairingCode.slice(0, 3)}-${pairingCode.slice(3)}`);
      console.log("This code expires in 5 minutes.");
      console.log(`Device ID: ${deviceId}`);
      console.log(`Label: ${label}`);
      console.log(
        "\nTo complete pairing, present this code on the target device.",
      );
      console.log("(Transport is platform-dependent — passkey flow or manual entry.)");

      // Persist device credentials under the generated ID.
      const { issueDeviceCertificate } = await import(
        "../../proxy/device-credentials.js"
      );
      try {
        await issueDeviceCertificate(deviceId, label, projectDir);
        console.log(
          `\nCredentials issued. Device "${label}" can now authenticate.\n`,
        );
      } catch (err) {
        console.error(`Failed to issue certificate: ${err}`);
        process.exitCode = 1;
      }
    });

  device
    .command("revoke <id>")
    .description("Revoke a paired device (effective on next request)")
    .argument("<id>", "Device ID to revoke")
    .action(async (id: string) => {
      const projectDir = process.cwd();
      const metadata = await getDeviceMetadata(projectDir, id);
      if (!metadata) {
        console.error(`Device "${id}" not found or already revoked.`);
        process.exitCode = 1;
        return;
      }
      const { revokeDevice } = await import(
        "../../proxy/device-credentials.js"
      );
      const ok = await revokeDevice(projectDir, id);
      if (!ok) {
        console.error(`Device "${id}" not found or already revoked.`);
        process.exitCode = 1;
        return;
      }
      console.log(`Device "${id}" has been revoked.`);
      console.log("Revocation takes effect on the next request.");
    });
}
