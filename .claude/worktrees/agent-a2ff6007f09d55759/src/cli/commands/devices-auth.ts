/**
 * golem device — enrol, list, and revoke paired devices.
 *
 * Invariant 8: all operations are local-only. No remote enrolment path exists,
 * no relay message type for one, so a compromised relay cannot introduce a
 * device any laptop will accept.
 */

import { bold, cyan, dim, green, red, yellow } from "kleur/colors"

import { createDeviceStore, verifyClientCert } from "../../auth/device-store"
import { defaultUserDir } from "../../config/paths"
import { generateLoopbackPair } from "../../proxy/loopback-cert"
import type { Command } from "commander"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getOrCreateCA() {
  return generateLoopbackPair()
}

/** Print a human-readable device summary table. */
function printDevices(devices: { label: string; enrolledAt: string; lastSeenAt?: string }[], json: boolean) {
  if (json) { console.log(JSON.stringify(devices, null, 2)); return }

  if (!devices.length) {
    console.log(green("No paired devices."))
    return
  }

  const pad = (s: string, n: number) => s.padEnd(n)

  console.log(bold("Paired devices"))
  console.log(dim("-".repeat(80)))
  for (const d of devices) {
    const seen = d.lastSeenAt ? "  " + dim("(seen " + new Date(d.lastSeenAt).toISOString().slice(0, 19) + ")") : ""
    console.log("  " + pad(d.label, 30) + green("  " + d.enrolledAt.slice(0, 10)) + seen)
  }
}

// ---------------------------------------------------------------------------
// enroll
// ---------------------------------------------------------------------------

export function registerEnroll(sub: Command) {
  sub.command("enroll")
    .description("Enrol a new device (issue a client certificate)")
    .option("-l, --label <name>", "Device label (default: prompt)", "none")
    .action(async (opts: { label: string }) => {
      const userDir = defaultUserDir()
      const store = await createDeviceStore(userDir)
      const ca = await getOrCreateCA()

      // Prompt for label if none given
      let label = opts.label
      if (label === "none") {
        const readline = await import("node:readline")
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        label = await new Promise<string>((resolve) => {
          rl.question("Device label? ", (ans) => resolve(ans.trim() || "device-" + Math.random().toString(36).slice(2, 10)))
        })
        rl.close()
      }

      const rec = await store.enrol({ label, caCertPem: ca.certPem, caKeyPem: ca.keyPem, days: 365 })
      console.log("")
      console.log(green("Device enrolled"))
      console.log("  ID:     " + dim(rec.id))
      console.log("  Label:  " + cyan(rec.label))
      console.log("  Expire: " + dim(new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10)))
      console.log("")
      console.log(dim("Certificate written to ~/.golem/devices/" + rec.id))
      console.log("")
    })
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export function registerList(sub: Command) {
  sub.command("list")
    .description("List paired devices")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { json: boolean }) => {
      const userDir = defaultUserDir()
      const store = await createDeviceStore(userDir)
      const devices = await store.list()
      printDevices(devices, opts.json)
    })
}

// ---------------------------------------------------------------------------
// revoke
// ---------------------------------------------------------------------------

export function registerRevoke(sub: Command) {
  sub.command("revoke <id>")
    .description("Revoke a paired device — effective on next request")
    .action(async (id: string) => {
      const userDir = defaultUserDir()
      const store = await createDeviceStore(userDir)
      await store.revoke(id)
      console.log(red("Device revoked:") + " " + id)
      console.log("")
      console.log(yellow("Revocation is effective on the next write request."))
    })
}

// ---------------------------------------------------------------------------
// export-cert
// ---------------------------------------------------------------------------

export function registerExportCert(sub: Command) {
  sub.command("export-cert <id>")
    .description("Print a device certificate in PEM format (for manual trust or debugging)")
    .action(async (id: string) => {
      const userDir = defaultUserDir()
      const store = await createDeviceStore(userDir)
      const devices = await store.list()
      const dev = devices.find((d) => d.id === id || d.label === id)
      if (!dev) {
        console.error(red("Unknown device: " + id))
        console.error("Run \x27golem device list\x27 to see available devices.")
        return
      }

      // Read cert PEM from disk
      const { readFile } = await import("node:fs/promises")
      const { join } = await import("node:path")
      const certPem = await readFile(join(userDir, ".golem", "devices", id, "cert.pem"), "utf8")
      console.log(certPem)
    })
}

// ---------------------------------------------------------------------------
// register — called from src/cli/program.ts
// ---------------------------------------------------------------------------

export function register(cmd: Command) {
  const device = cmd.command("device").description("Manage paired devices (mTLS authentication)")

  registerEnroll(device)
  registerList(device)
  registerRevoke(device)
  registerExportCert(device)
}
