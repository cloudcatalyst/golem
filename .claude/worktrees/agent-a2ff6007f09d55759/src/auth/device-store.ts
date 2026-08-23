/**
 * Device credential store — enrolled devices, their client certificates,
 * revocation list, and metadata (label, last-seen).
 *
 * Invariant 8 (ADR-0007 §5): enrolment is local-only, forever. There is no
 * relay-mediated pairing and no message type for one, so a compromised relay
 * or account cannot introduce a device any laptop will accept. This store is
 * never reachable over the network — only via a local CLI command.
 */


import {
  createPrivateKey,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
  X509Certificate,
} from "node:crypto"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------


export interface DeviceRecord {
  readonly id: string;
  readonly label: string;
  readonly certPem: string;
  readonly keyPem: string;
  readonly enrolledAt: string;
  readonly lastSeenAt?: string;
}


export interface DeviceSummary {
  readonly id: string;
  readonly label: string;
  readonly enrolledAt: string;
  readonly lastSeenAt?: string;
}


export interface CertVerificationResult {
  valid: boolean;
  error?: string;
  serialHex?: string;
}


export interface DeviceStore {
  enrol(opts: {
    label: string;
    caCertPem: string;
    caKeyPem: string;
    days?: number;
  }): Promise<DeviceRecord>
  list(): Promise<DeviceSummary[]>
  revoke(id: string): Promise<boolean>
  isRevoked(serialHex: string): Promise<boolean>
  touchLastSeen(id: string, nowMs?: number): Promise<void>
}


// File layout: ~/.golem/devices/<hex-id>/meta.json + cert.pem + key.pem
function devDir(d: string) { return join(d, ".golem", "devices") }
function metaPath(d: string, i: string) { return join(d, i, "meta.json") }
function certFile(d: string, i: string) { return join(d, i, "cert.pem") }
function keyFile(d: string, i: string) { return join(d, i, "key.pem") }
function revPath(d: string) { return join(d, "_revocations.json") }


function rndHex(n: number) { return randomBytes(n).toString("hex") }

async function loadJson<T>(p: string): Promise<T | null> {
  try { return JSON.parse(await readFile(p, "utf8")) as T } catch { return null }
}

async function saveJson(p: string, d: unknown) {
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, JSON.stringify(d, null, 2), "utf8")
}

async function loadRevs(dir: string): Promise<Set<string>> {
  const r = await loadJson<string[]>(revPath(dir))
  if (!r) return new Set()
  return new Set(r.map((s) => s.toLowerCase()))
}

async function saveRevs(dir: string, s: Set<string>) {
  await saveJson(revPath(dir), [...s].sort())
}


export async function verifyClientCert(
  certPem: string,
  caCertPem: string,
): Promise<CertVerificationResult> {
  try {
    const cert = new X509Certificate(certPem)
    const ca = new X509Certificate(caCertPem)
    // @ts-expect-error @types/node@22 types lag runtime — validFrom/to are Date in Node 24
    const vFrom: Date = cert.validFrom;
    // @ts-expect-error same reason
    const vTo: Date = cert.validTo;
    if (new Date() < vFrom || new Date() > vTo) {
      return {
        valid: false,
        // @ts-expect-error serial missing from @types/node@22
        error: "certificate expired: valid " + vFrom.toISOString() + " to " + vTo.toISOString() + ", serial " + cert.serial.toLowerCase(),
      }
    }
    // @ts-expect-error checkIssued missing from @types/node@22
    if (!cert.checkIssued(ca)) {
      return { valid: false, error: "certificate not issued by trusted CA" }
    }
    // @ts-expect-error purposes missing from @types/node@22
    if (!cert.purposes(false, true).client) {
      return { valid: false, error: "certificate does not include clientAuth usage" }
    }
    // @ts-expect-error serial missing from @types/node@22
    return { valid: true, serialHex: cert.serial.toLowerCase() }
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : "unknown certificate error" }
  }
}


// ASN.1 DER primitives (from src/proxy/loopback-cert.ts)
const TAG_BOOLEAN = 0x01
const TAG_INTEGER = 0x02
const TAG_BIT_STRING = 0x03
const TAG_OCTET_STRING = 0x04
const TAG_OID = 0x06
const TAG_UTF8_STRING = 0x0c
const TAG_UTC_TIME = 0x17
const TAG_SEQUENCE = 0x30
const TAG_SET = 0x31

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const bLen = Math.floor(Math.log2(length)) + 1
  const bytes: number[] = []
  let n = length
  for (let i = 0; i < bLen; i++) { bytes.unshift(n & 0xff); n >>= 8 }
  return Buffer.from([0x80 | bLen, ...bytes])
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value])
}

function derBoolean(val: boolean): Buffer { return tlv(TAG_BOOLEAN, Buffer.from(val ? [0xff] : [0x00])) }
function derInteger(val: Buffer): Buffer { return tlv(TAG_INTEGER, val) }

function derOid(s: string): Buffer {
  const nums = s.split(".").map(Number)
  const buf = Buffer.from([nums[0]! * 40 + nums[1]!])
  for (let i = 2; i < nums.length; i++) {
    let v = nums[i]!
    if (v < 128) { ;(buf as unknown as number[]).push(v) } else {
      const bb: number[] = []
      do { bb.unshift(v & 0x7f | (v > 127 ? 0x80 : 0)); v >>>= 7 } while (v > 0)
      ;(buf as unknown as number[]).push(...bb)
    }
  }
  return tlv(TAG_OID, buf)
}

function derUtf8String(s: string): Buffer { return tlv(TAG_UTF8_STRING, Buffer.from(s, "utf8")) }

function derUtcTime(date: Date): Buffer {
  const p = (n: number) => String(n).padStart(2, "0")
  const text = p(date.getUTCFullYear() % 100)
    + p(date.getUTCMonth() + 1) + p(date.getUTCDate())
    + p(date.getUTCHours()) + p(date.getUTCMinutes()) + p(date.getUTCSeconds()) + "Z"
  return tlv(TAG_UTC_TIME, Buffer.from(text, "ascii"))
}

function derSequence(contents: Buffer[]): Buffer { return tlv(TAG_SEQUENCE, Buffer.concat(contents)) }
function derSet(contents: Buffer[]): Buffer { return tlv(TAG_SET, Buffer.concat(contents)) }
function derBitString(payload: Buffer, unusedBits: number): Buffer {
  return tlv(TAG_BIT_STRING, Buffer.concat([Buffer.from([unusedBits]), payload]))
}
function derOctetString(value: Buffer): Buffer { return tlv(TAG_OCTET_STRING, value) }


// Certificate OIDs, extensions, signing
const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2"
const OID_COMMON_NAME = "2.5.4.3"
const OID_EXT_BASIC_CONSTRAINTS = "2.5.29.19"
const OID_EXT_KEY_USAGE = "2.5.29.15"
const OID_EXT_SUBJECT_ALT_NAME = "2.5.29.17"
const OID_EXT_EXTENDED_KEY_USAGE = "2.5.29.37"
const OID_CLIENT_AUTH = "1.3.6.1.5.5.7.3.2"
const SAN_TAG_IP = 0x87

function sigAlgo(): Buffer { return derSequence([derOid(OID_ECDSA_SHA256)]) }

function nameOf(cn: string): Buffer {
  return derSequence([derSet([derSequence([derOid(OID_COMMON_NAME), derUtf8String(cn)])])])
}

function extBlock(oid: string, critical: boolean, value: Buffer): Buffer {
  return derSequence([derOid(oid), ...(critical ? [derBoolean(true)] : []), derOctetString(value)])
}

/** Client EKU=clientAuth, SAN=IP */
function clientExts(ipAddrs: readonly string[]): Buffer {
  const san = ipAddrs.map((ip) => tlv(SAN_TAG_IP, Buffer.from(ip.split(".").map(Number))))
  return derSequence([
    extBlock(OID_EXT_BASIC_CONSTRAINTS, true, derSequence([])),
    extBlock(OID_EXT_KEY_USAGE, true, derBitString(Buffer.from([0xa0]), 5)),
    extBlock(OID_EXT_EXTENDED_KEY_USAGE, false, derSequence([derOid(OID_CLIENT_AUTH)])),
    extBlock(OID_EXT_SUBJECT_ALT_NAME, false, derSequence(san)),
  ])
}

function genSerial(fn: (size: number) => Buffer): Buffer {
  const b = fn(16); const f = b[0] || 1; b[0] = f & 0x7f || 1; return b
}

function toPem(label: string, der: Buffer): string {
  const newline = "\n"
  const body = der.toString("base64").replace(/(.{64})/g, "$1" + newline)
  return "-----BEGIN " + label + newline + body + (body.endsWith(newline) ? "" : newline) + "-----END " + label + newline
}

function spki(pub: KeyObject): Buffer { return pub.export({ format: "der", type: "spki" }) as Buffer }
const CLOCK_SKEW_MS = 5 * 60 * 1000

function buildCertificate(p: {
  subjectCn: string; issuerCn: string; pubKey: KeyObject; privKey: KeyObject;
  exts: Buffer; notBefore: Date; notAfter: Date; serial: Buffer
}): Buffer {
  const tbs = derSequence([
    tlv(0xa0, derInteger(Buffer.from([2]))), // v3
    derInteger(p.serial), sigAlgo(), nameOf(p.issuerCn),
    derSequence([derUtcTime(p.notBefore), derUtcTime(p.notAfter)]),
    nameOf(p.subjectCn), spki(p.pubKey), tlv(0xa3, p.exts)
  ])
  const s = createSign("sha256"); s.update(tbs)
  const sig = s.sign(p.privKey)
  return derSequence([tbs, sigAlgo(), derBitString(sig, 0)])
}


async function generateClientCert(opt: { label: string; caPem: string; caKey: string; days?: number }) {
  const { label, caPem, caKey, days = 365 } = opt
  const now = Date.now()
  const nb = new Date(now - CLOCK_SKEW_MS)
  const na = new Date(now + days * 86400000)
  const { privateKey: dk, publicKey: dp } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  const cn = label || "device-" + rndHex(8)
  const der = buildCertificate({
    subjectCn: cn, issuerCn: "golem lan-ca", pubKey: dp,
    privKey: createPrivateKey(caKey.trimEnd()),
    exts: clientExts(["127.0.0.1"]), notBefore: nb, notAfter: na,
    serial: genSerial(randomBytes)
  })
  return {
    certPem: toPem("CERTIFICATE", der),
    keyPem: dk.export({ type: "pkcs8", format: "pem" }).toString()
  }
}


export async function createDeviceStore(userDir: string): Promise<DeviceStore> {
  const dir = devDir(userDir)
  return {
    enrol: async ({ label, caCertPem, caKeyPem, days }) => {
      await mkdir(dir, { recursive: true })
      const did = rndHex(16)
      const now = Date.now()
      const { certPem, keyPem } = await generateClientCert({ label, caPem: caCertPem, caKey: caKeyPem, days: days ?? 365 })
      const rec: DeviceRecord = { id: did, label, certPem, keyPem, enrolledAt: new Date(now).toISOString() }
      await saveJson(metaPath(dir, did), { id: rec.id, label: rec.label, enrolledAt: rec.enrolledAt })
      await writeFile(certFile(dir, did), certPem, "utf8")
      await writeFile(keyFile(dir, did), keyPem, "utf8")
      return rec
    },

    list: async () => {
      await mkdir(dir, { recursive: true })
      const entries = await readdir(dir)
      const out: DeviceSummary[] = []
      for (const e of entries) {
        if (e.startsWith("_")) continue
        const r = await loadJson<DeviceSummary>(metaPath(dir, e))
        if (r) out.push(r)
      }
      return out.sort((a, b) => a.label.localeCompare(b.label))
    },

    revoke: async (id) => {
      await mkdir(dir, { recursive: true })
      const revs = await loadRevs(dir)
      try {
        const raw = await readFile(certFile(dir, id), "utf8")
        const c = new X509Certificate(raw)
        // @ts-expect-error serial missing from @types/node@22
        revs.add(c.serial.toLowerCase())
      } catch { /* non-fatal — device may already be removed */ }
      await saveRevs(dir, revs)
      await rm(join(dir, id), { force: true, recursive: true })
      return true
    },

    isRevoked: async (serialHex) => {
      const revs = await loadRevs(dir)
      return revs.has(serialHex.toLowerCase())
    },

    touchLastSeen: async (id, nowMs) => {
      await mkdir(dir, { recursive: true })
      const rec = await loadJson<DeviceSummary>(metaPath(dir, id))
      if (!rec) return
      const u = { ...rec, lastSeenAt: new Date(nowMs ?? Date.now()).toISOString() }
      await saveJson(metaPath(dir, id), u)
    },
  }
}
