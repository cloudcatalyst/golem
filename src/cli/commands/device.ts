/**
 * `golem device` — R13.4's local half.
 *
 * Every command here runs on the developer's own machine, and that is the whole
 * security model of enrolment: there is no remote path to any of it. Pairing
 * starts here or not at all (ADR-0006 §3c-1 invariant 8, inherited verbatim).
 */

import type { Command } from "commander";
import { findProjectDir, loadConfig } from "../../config/index.js";
import {
  activeDeviceCount,
  cancelEnrolment,
  checkFactor,
  DEFAULT_ENROLMENT_TTL_MINUTES,
  ensureDeviceCa,
  isPasscodeSet,
  listDevices,
  lock,
  MIN_PASSCODE_LENGTH,
  PasscodeTooShortError,
  pendingEnrolmentInfo,
  readDeviceCa,
  revokeDevice,
  setPasscode,
  startEnrolment,
  unlock,
} from "../../security/index.js";
import { InitError } from "../init.js";

const _DEFAULT_DIR = findProjectDir(process.cwd()) ?? process.cwd();

function _fail(err: unknown): never {
  process.stderr.write(`golem: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(err instanceof InitError ? 2 : 1);
}

const out = (text: string): void => void process.stdout.write(text);

/** `2026-08-29T10:04:00.000Z` -> `2026-08-29 10:04` — dates a human reads at a glance. */
function short(iso: string | Date | undefined): string {
  if (iso === undefined) return "—";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 16).replace("T", " ");
}

export default function register(program: Command): void {
  const device = program
    .command("device")
    .description("Pair a phone, set the passcode, and revoke — all local-only (ADR-0007 §7)");

  device
    .command("enrol", { isDefault: false })
    .aliases(["enroll"])
    .description("Open a short-lived, single-use pairing code for one device")
    .argument("<label>", 'what to call it, e.g. "Pixel" or "work iPhone"')
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option(
      "--ttl <minutes>",
      "how long the code stays claimable",
      String(DEFAULT_ENROLMENT_TTL_MINUTES),
    )
    .action(async (label: string, opts: { dir: string; ttl: string }) => {
      try {
        const ttl = Number(opts.ttl);
        if (!Number.isFinite(ttl) || ttl <= 0) throw new InitError(`invalid --ttl "${opts.ttl}"`);
        const ca = await ensureDeviceCa(opts.dir);
        if (ca.created) out("created this project's device CA (.golem/devices/ca.pem)\n");
        if (!(await isPasscodeSet(opts.dir))) {
          // Not an error: pairing a device is still useful. But a paired device
          // with no passcode can never write, and finding that out on the phone
          // is a worse place to find it out than here.
          out(
            "\n⚠ No passcode is set, so this device will be able to authenticate and still not be able to send.\n" +
              "  Set one with `golem device passcode`.\n",
          );
        }
        const pending = await startEnrolment(opts.dir, { label, ttlMinutes: ttl });
        out(
          `\npairing code for "${label}":  ${pending.code}\n` +
            `  expires ${short(pending.expiresAt)} (${ttl} min), single use\n\n` +
            "On the device, open the Golem write surface and enter that code.\n" +
            "The code is the only way to claim this credential, and it works once.\n",
        );
      } catch (err) {
        _fail(err);
      }
    });

  device
    .command("cancel")
    .description("Close an open pairing window without using it")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .action(async (opts: { dir: string }) => {
      try {
        await cancelEnrolment(opts.dir);
        out("pairing window closed\n");
      } catch (err) {
        _fail(err);
      }
    });

  device
    .command("list", { isDefault: true })
    .description("Every device ever enrolled, with its state")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; json: boolean }) => {
      try {
        const devices = await listDevices(opts.dir);
        if (opts.json) {
          out(`${JSON.stringify(devices, null, 2)}\n`);
          return;
        }
        if (devices.length === 0) {
          out("no devices enrolled — `golem device enrol <label>` pairs one\n");
          return;
        }
        const nowMs = Date.now();
        for (const d of devices) {
          const expired = Date.parse(d.not_after) <= nowMs;
          const state =
            d.revoked_at !== undefined
              ? `REVOKED ${short(d.revoked_at)}`
              : expired
                ? `EXPIRED ${short(d.not_after)}`
                : `active until ${short(d.not_after)}`;
          out(
            `  ${d.id}  ${d.label.padEnd(16)} ${state.padEnd(28)} last seen ${short(d.last_seen_at)}\n` +
              `    ${d.fingerprint}\n`,
          );
        }
      } catch (err) {
        _fail(err);
      }
    });

  device
    .command("revoke")
    .description("Revoke a device — effective on its next request, not at a cache expiry")
    .argument("<id-or-fingerprint>")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .action(async (target: string, opts: { dir: string }) => {
      try {
        const outcome = await revokeDevice(opts.dir, target, new Date().toISOString());
        if (outcome === "not-found") throw new InitError(`no device matches "${target}"`);
        out(
          outcome === "already-revoked"
            ? `${target} was already revoked\n`
            : `revoked ${target} — its next request is refused\n`,
        );
      } catch (err) {
        _fail(err);
      }
    });

  device
    .command("passcode")
    .description("Set or change the passcode that unlocks sending")
    .argument("<passcode>", `at least ${MIN_PASSCODE_LENGTH} characters`)
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .action(async (passcode: string, opts: { dir: string }) => {
      try {
        await setPasscode(opts.dir, passcode);
        out("passcode set — this also locked any open unlock window\n");
      } catch (err) {
        if (err instanceof PasscodeTooShortError) _fail(new InitError(err.message));
        _fail(err);
      }
    });

  device
    .command("unlock")
    .description("Open an unlock window so paired devices can send")
    .argument("<passcode>")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .action(async (passcode: string, opts: { dir: string }) => {
      try {
        const { settings } = await loadConfig({ projectDir: opts.dir });
        const window = await unlock(opts.dir, passcode, {
          windowMinutes: settings.security.unlock_window_minutes,
        });
        if (window === null) throw new InitError("wrong passcode");
        out(`unlocked until ${short(window.expiresAt)}\n`);
      } catch (err) {
        _fail(err);
      }
    });

  device
    .command("lock")
    .description("Close the unlock window now")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .action(async (opts: { dir: string }) => {
      try {
        await lock(opts.dir);
        out("locked\n");
      } catch (err) {
        _fail(err);
      }
    });

  device
    .command("serve")
    .description("Run the mutual-TLS write surface (R13.5 mounts the session host behind it)")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--port <port>", "listen port (overrides config security.write_port)")
    .option("--lan", "bind every interface so a paired phone can reach it")
    .action(async (opts: { dir: string; port?: string; lan?: boolean }) => {
      try {
        const { settings } = await loadConfig({ projectDir: opts.dir });
        const port = opts.port === undefined ? settings.security.write_port : Number(opts.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new InitError(`invalid port "${opts.port}"`);
        }
        const deviceCa = await readDeviceCa(opts.dir);
        if (deviceCa === null) {
          // Refuse rather than mint an authority nobody asked for. A write
          // surface with a CA created by starting it would be a surface whose
          // trust root appeared as a side effect of running a server.
          throw new InitError(
            "no device CA for this project — run `golem device enrol <label>` first",
          );
        }
        const lan = opts.lan === true || settings.security.write_lan;
        const { ensureLoopbackCert } = await import("../../proxy/loopback-cert.js");
        const tls = await ensureLoopbackCert(opts.dir);
        const { startWriteServer } = await import("../../security/index.js");
        // R13.7 — the sessions this surface can address are the ones the PROXY
        // has seen, read from its snapshot: this process observes no requests of
        // its own. Mounted whether or not injection is enabled, because a device
        // that cannot see a conversation cannot be told why it may not write to
        // it — the listing carries `injectionEnabled` and the refusal says so.
        const { createJoinedTransport, sessionTransportHandler } = await import(
          "../../session/index.js"
        );
        const joined = await createJoinedTransport({
          projectDir: opts.dir,
          injectionEnabled: settings.security.join_injection,
        });
        const handle = await startWriteServer({
          projectDir: opts.dir,
          port,
          ...(lan ? { host: "0.0.0.0" } : {}),
          serverKeyPem: tls.leafKeyPem,
          serverCertPem: tls.chainPem,
          deviceCa,
          handler: sessionTransportHandler({
            lookup: (id) => joined.lookup(id),
            listSessions: () => joined.listSessions(),
          }),
        });
        out(`golem write surface on ${handle.url} (Ctrl+C to stop)\n`);
        if (!(await isPasscodeSet(opts.dir))) {
          out("⚠ no passcode set — every request will be refused at the user claim\n");
        }
        if (lan) {
          const { lanUrls } = await import("../../dashboard/index.js");
          out(
            "\n⚠ LAN mode: this surface can ACT. It still requires a paired device AND your passcode,\n" +
              "  and enrolment can only be started here, on this machine.\n",
          );
          for (const url of lanUrls(handle.port)) {
            out(`    ${url.replace("http://", "https://")}\n`);
          }
        }
        const shutdown = (): void => {
          void handle.close().finally(() => process.exit(0));
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
      } catch (err) {
        _fail(err);
      }
    });

  device
    .command("status")
    .description("Where the write surface stands: CA, devices, passcode, unlock window")
    .option("--dir <path>", "project directory", _DEFAULT_DIR)
    .option("--json", "machine-readable output", false)
    .action(async (opts: { dir: string; json: boolean }) => {
      try {
        const { settings } = await loadConfig({ projectDir: opts.dir });
        const [ca, active, total, factor, pending, passcodeSet] = await Promise.all([
          readDeviceCa(opts.dir),
          activeDeviceCount(opts.dir),
          listDevices(opts.dir).then((d) => d.length),
          checkFactor(opts.dir, { idleMinutes: settings.security.idle_relock_minutes }),
          pendingEnrolmentInfo(opts.dir),
          isPasscodeSet(opts.dir),
        ]);
        const report = {
          device_ca: ca === null ? null : { not_after: ca.notAfter.toISOString() },
          devices: { active, total },
          passcode_set: passcodeSet,
          unlocked: factor.live,
          unlock_reason: factor.live ? null : factor.reason,
          unlocked_until: factor.live ? factor.window.expiresAt.toISOString() : null,
          pairing_open: pending === null ? null : pending.expiresAt.toISOString(),
          write_lan: settings.security.write_lan,
          write_port: settings.security.write_port,
        };
        if (opts.json) {
          out(`${JSON.stringify(report, null, 2)}\n`);
          return;
        }
        out(
          `device CA:      ${ca === null ? "not created (no device has been paired)" : `valid until ${short(ca.notAfter)}`}\n` +
            `devices:        ${active} active of ${total} enrolled\n` +
            `passcode:       ${passcodeSet ? "set" : "NOT SET — paired devices cannot send"}\n` +
            `unlock:         ${factor.live ? `open until ${short(factor.window.expiresAt)}` : `locked (${factor.reason})`}\n` +
            `pairing window: ${pending === null ? "closed" : `OPEN until ${short(pending.expiresAt)} for "${pending.label}"`}\n` +
            `write surface:  port ${settings.security.write_port}, ${
              settings.security.write_lan ? "reachable from your NETWORK" : "loopback only"
            }\n`,
        );
        if (settings.security.write_lan) {
          // Invariant 9: Golem neither prevents this nor pretends it has not
          // happened. If the developer has put it on a VPN, that is their call.
          out(
            "\n⚠ The write surface is bound to every interface. Anything that can reach this\n" +
              "  machine can attempt to send — it still needs a paired device AND your passcode.\n",
          );
        }
      } catch (err) {
        _fail(err);
      }
    });
}
