/**
 * R13.4 — the device CA on disk: create once, load thereafter.
 *
 * Separate from `src/proxy/loopback-cert.ts`'s `ensureLoopbackCert` because the
 * two CAs have opposite lifecycles. The loopback CA is regenerated freely when
 * it expires — nothing depends on its identity, only on its being trusted right
 * now. Regenerating the DEVICE CA invalidates every enrolled device at once, so
 * it is never done automatically: it is created if absent and otherwise left
 * alone, even close to expiry, and the CLI reports the expiry rather than acting
 * on it.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { type DeviceCa, generateDeviceCa } from "../proxy/loopback-cert.js";
import { deviceCaKeyPath, deviceCaPath, deviceDir } from "./paths.js";

/**
 * `0o600` on the CA key. Best-effort: on Windows the mode is largely advisory,
 * which is a real limitation and not one this file can fix — it is recorded
 * here rather than implied by a call that looks like it did something.
 */
const KEY_MODE = 0o600;

export interface LoadedDeviceCa extends DeviceCa {
  /** True when this call created the CA (first enrolment on this project). */
  readonly created: boolean;
}

/** Read the device CA, creating it on first use. */
export async function ensureDeviceCa(
  projectDir: string,
  options: { readonly nowMs?: number } = {},
): Promise<LoadedDeviceCa> {
  const existing = await readDeviceCa(projectDir);
  if (existing !== null) return { ...existing, created: false };

  const ca = await generateDeviceCa({
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
  });
  await mkdir(deviceDir(projectDir), { recursive: true });
  await writeFile(deviceCaPath(projectDir), ca.caPem, "utf8");
  await writeFile(deviceCaKeyPath(projectDir), ca.caKeyPem, { encoding: "utf8", mode: KEY_MODE });
  return { ...ca, created: true };
}

/**
 * Read the device CA without creating it. `null` when this project has never
 * enrolled a device — which is what lets the write server refuse to start
 * rather than silently minting an authority nobody asked for.
 */
export async function readDeviceCa(projectDir: string): Promise<DeviceCa | null> {
  try {
    const [caPem, caKeyPem] = await Promise.all([
      readFile(deviceCaPath(projectDir), "utf8"),
      readFile(deviceCaKeyPath(projectDir), "utf8"),
    ]);
    const { X509Certificate } = await import("node:crypto");
    const cert = new X509Certificate(caPem);
    return {
      caPem,
      caKeyPem,
      notBefore: new Date(cert.validFrom),
      notAfter: new Date(cert.validTo),
    };
  } catch {
    return null;
  }
}
