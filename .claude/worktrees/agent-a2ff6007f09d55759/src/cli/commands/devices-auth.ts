/**
 * golem device — enrol, list, and revoke paired devices.
 *
 * Invariant 8: all operations are local-only. No remote enrolment path exists,
 * no relay message type for one, so a compromised relay cannot introduce a
 * device any laptop will accept.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";

import { createDeviceStore, verifyClientCert } from "../../auth/device-store.js"
import { defaultUserDir } from "../../config/paths.js"
import { generateLoopbackPair } from "../../proxy/loopback-cert.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getOrCreateCA() {
  return generateLoopbackPair();
}

/** Print a human-readable device summary table. */
function printDevices(devices: { label: string; enrolledAt: string; lastSeenAt?: string }[], json: boolean) {
  const pad = (s: string, n: number) => s.padEnd(n);

  if (json) { console.log(JSON.stringify(devices, null, 2)); return; }

  if (!devices.length) {
    process.stdout.write("\nNo paired devices.\n");
    return;
  }

  process.stdout.write("\nPaired devices\n");
  process.stdout.write("-".repeat(80) + "\n");
  for (const d of devices) {
    const seen = d.lastSeenAt ? "  (seen " + new Date(d.lastSeenAt).toISOString().slice(0, 19) + ")" : "";
    process.stdout.write("  " + pad(d.label, 30) + "  " + d.enrolledAt.slice(0, 10) + seen + "\n");
  }
  process.stdout.write("\n");
}

// ---------------------------------------------------------------------------
// enroll
// ---------------------------------------------------------------------------

export default function register(cmd: Command): void {
  const device = cmd.command("device").description("Manage paired devices (mTLS authentication)");

  device
    .command("enroll")
    .description("Enrol a new device (issue a client certificate)")
    .option("-l, --label <name>", "Device label (default: prompt)", "none")
    .action(async (opts: { label: string }) => {
      try {
        const userDir = defaultUserDir();
        const store = await createDeviceStore(userDir);
        const ca = await getOrCreateCA();

        let label = opts.label;
        if (label === "none") {
          const readline = await import("node:readline");
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          label = await new Promise<string>((resolve) => {
            rl.question("Device label? ", (ans) => resolve(ans.trim() || "device-" + Math.random().toString(36).slice(2, 10)));
          });
          rl.close();
        }

        const rec = await store.enrol({ label, caCertPem: ca.certPem, caKeyPem: ca.keyPem, days: 365 });
        process.stdout.write("\n");
        process.stdout.write("Device enrolled\n");
        process.stdout.write("  ID:     " + rec.id + "\n");
        process.stdout.write("  Label:  " + rec.label + "\n");
        process.stdout.write("  Expire: " + new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10) + "\n");
        process.stdout.write("\n");
        process.stdout.write("Certificate written to ~/.golem/devices/" + rec.id + "\n");
        process.stdout.write("\n");
      } catch (err) {
        process.stderr.write("error: " + (err instanceof Error ? err.message : String(err)) + "\n");
        process.exit(1);
      }
    });

  device
    .command("list")
    .description("List paired devices")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { json: boolean }) => {
      try {
        const userDir = defaultUserDir();
        const store = await createDeviceStore(userDir);
        const devices = await store.list();
        printDevices(devices, opts.json);
      } catch (err) {
        process.stderr.write("error: " + (err instanceof Error ? err.message : String(err)) + "\n");
        process.exit(1);
      }
    });

  device
    .command("revoke <id>")
    .description("Revoke a paired device — effective on next request")
    .action(async (id: string) => {
      try {
        const userDir = defaultUserDir();
        const store = await createDeviceStore(userDir);
        await store.revoke(id);
        process.stdout.write("Device revoked: " + id + "\n");
        process.stdout.write("\nRevocation is effective on the next write request.\n");
        process.stdout.write("\n");
      } catch (err) {
        process.stderr.write("error: " + (err instanceof Error ? err.message : String(err)) + "\n");
        process.exit(1);
      }
    });

  device
    .command("export-cert <id>")
    .description("Print a device certificate in PEM format")
    .action(async (id: string) => {
      try {
        const userDir = defaultUserDir();
        const store = await createDeviceStore(userDir);
        const devices = await store.list();
        const dev = devices.find((d: { id: string }) => d.id === id);
        if (!dev) {
          process.stderr.write("Unknown device: " + id + "\n");
          process.stderr.write("Run 'golem device list' to see available devices.\n");
          return;
        }

        const certPem = await readFile(join(userDir, ".golem", "devices", id, "cert.pem"), "utf8");
        process.stdout.write(certPem);
      } catch (err) {
        process.stderr.write("error: " + (err instanceof Error ? err.message : String(err)) + "\n");
        process.exit(1);
      }
    });
}
