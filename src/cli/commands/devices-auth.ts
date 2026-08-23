/**
 * CLI command registration for `golem device` — enroll, list, revoke, status.
 *
 * Handles local enrollment of mTLS-capable devices: generate keypairs, produce
 * short-lived pairing codes, verify codes against the CA, manage a revocation
 * catalog. Also shows user-factor session status.
 *
 * Enrollment is local-only, forever (ADR-0006 section 3c-1). There is no
 * relay-mediated pairing and no message type for one.
 */

import { Command } from "commander";
import process from "node:process";

import { findProjectDir } from "../../config/index.js";
import {
  enroll,
  getClientCertAndKey,
  isDeviceRevoked,
  listDevices,
  loadDevice,
  PairingCodeResult,
  RevocationError,
  ExpiryError,
} from "../../security/device-credentials.js";
import { DEVICE_CN_PREFIX } from "../../security/device-cert-builder.js";
import { devicesDir } from "../../security/device-catalog.js";
import { loopbackCaPath, loopbackCaKeyPath } from "../../proxy/loopback-cert.js";
import { checkStatus, isActive } from "../../security/user-factor.js";

const _DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();

async function fail(err: unknown): Promise<never> {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`golem: ${msg}\n`);
  process.exit(1);
}

export default function register(program: Command): void {
  const cmd = program.command("device").description("Manage paired devices (mTLS)");

  // ---- enroll ----
  cmd
    .command("enroll")
    .description("Start a new device enrollment; prints a pairing code")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .argument("[label]", "human-readable device label", "laptop")
    .action(async (label: string, opts: { dir: string }) => {
      try {
        const result: PairingCodeResult = await enroll(opts.dir, label);
        console.log(
          `\nPairing code for device ${result.deviceId}:`,
          result.pairingCode.code,
          `(expires in 90s)\n`,
        );
        console.log("Confirm this on both screens to complete enrollment.");
      } catch (e) {
        await fail(e);
      }
    });

  // ---- complete-enroll ----
  cmd
    .command("complete <deviceId> <code>")
    .description("Complete enrollment after verifying the pairing code")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .action(async (deviceId: string, code: string, opts: { dir: string }) => {
      try {
        const caCertPem = await import("node:fs/promises")
          .then((fs) => fs.readFile(loopbackCaPath(opts.dir), "utf8"));
        const caKeyPem = await import("node:fs/promises")
          .then((fs) => fs.readFile(loopbackCaKeyPath(opts.dir), "utf8"));
        const result = await completeEnrollment(
          opts.dir,
          deviceId,
          code,
          caCertPem.toString(),
          caKeyPem.toString(),
        );
        const len = Buffer.byteLength(result.certPem);
        console.log(
          `Device "${deviceId}" enrolled successfully.`,
          `cert PEM: ${len} bytes`,
        );
        if (opts.json) {
          console.log(JSON.stringify({ certPem: result.certPem }));
        }
      } catch (e) {
        await fail(e);
      }
    });

  // ---- list ----
  cmd
    .command("list")
    .alias("show")
    .description("List paired devices")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--json", "machine-readable output", false)
    .option("--include-revoked", "include revoked devices", false)
    .action(async (opts: { dir: string; json: boolean; includeRevoked: boolean }) => {
      try {
        const devices = await listDevices(opts.dir, opts.includeRevoked);
        if (opts.json) {
          console.log(JSON.stringify(devices, null, 2));
          return;
        }
        if (devices.length === 0) {
          console.log("No devices paired.");
          return;
        }
        for (const d of devices) {
          const status = d.revoked ? "REVOKED" : "active";
          const lastSeen = d.lastSeen ? `  last-seen: ${d.lastSeen.toISOString()}` : "";
          console.log(`  ${status}  ${d.label.padEnd(20)}  (${d.deviceId.slice(0, 8)})${lastSeen}`);
        }
      } catch (e) {
        await fail(e);
      }
    });

  // ---- revoke ----
  cmd
    .command("revoke <deviceId>")
    .description("Revoke a paired device (effective on next request)")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .argument("deviceId", "device ID to revoke")
    .action(async (deviceId: string, opts: { dir: string }) => {
      try {
        await revokeDevice(opts.dir, deviceId);
        console.log(`Device ${deviceId} revoked.`);
      } catch (e) {
        if (e instanceof RevocationError || (e as Error).message.includes("not found")) {
          await fail(e);
        }
        await fail(e);
      }
    });

  // ---- status ----
  cmd
    .command("status")
    .description("Show authentication summary: paired devices and user factor")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--user-dir <path>", "user directory for factor storage")
    .action(async (opts: { dir: string; userDir?: string }) => {
      try {
        const devices = await listDevices(opts.dir);
        const allDevices = await listDevices(opts.dir, true);
        const active = devices.filter((d) => !d.revoked).length;

        let ufStatus: string;
        try {
          const userDir = opts.userDir ?? require("node:path").join(require("node:os").homedir(), ".golem");
          const status = await checkStatus(userDir);
          const alive = await isActive(userDir);
          ufStatus = `${status}${alive ? " (active)" : ""}`;
        } catch {
          ufStatus = "unknown";
        }

        console.log("\nGolem Authentication Summary");
        console.log(`  Paired devices:    ${active}/${allDevices.length} active`);
        console.log(`  User factor:       ${ufStatus}`);
        console.log(`  Project dir:       ${opts.dir}`);
        const devDirPath = devicesDir(opts.dir);
        console.log(`  Device catalog:    ${devDirPath}`);
        console.log("");
      } catch (e) {
        await fail(e);
      }
    });
}

// ---------------------------------------------------------------------------
// Exported helpers so the proxy can call them directly
// ---------------------------------------------------------------------------

/** Proxy for completeEnrollment when the caller wants raw certs back. */
export async function runCompleteEnrollment(
  projectDir: string,
  deviceId: string,
  code: string,
): Promise<{ certPem: string; keyPem: string }> {
  const fs = await import("node:fs/promises");
  const caCertPem = await fs.readFile(loopbackCaPath(projectDir), "utf8");
  const caKeyPem = await fs.readFile(loopbackCaKeyPath(projectDir), "utf8");
  return completeEnrollment(projectDir, deviceId, code, caCertPem.toString(), caKeyPem.toString());
}

async function revokeDevice(projectDir: string, deviceId: string): Promise<void> {
  const cat = await import("../../security/device-catalog.js").then((m) => m.readOrCreate(projectDir));
  if (!cat.entries[deviceId]) throw new Error(`device not found: ${deviceId}`);
  cat.entries[deviceId].revoked = true;
  await import("../../security/device-catalog.js").then((m) => m.writeCatalog(projectDir, cat));
}

async function completeEnrollment(
  projectDir: string,
  deviceId: string,
  code: string,
  caCertPem: string,
  caKeyPem: string,
): Promise<{ certPem: string; keyPem: string }> {
  // Delegate to the main module's implementation.
  const dc = await import("../../security/device-credentials.js");
  return dc.completeEnrollment(projectDir, deviceId, code, caCertPem, caKeyPem);
}
