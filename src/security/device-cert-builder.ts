/**
 * Minimal X.509 client-auth certificate builder using DER primitives.
 *
 * Mirrors the buildCertificate pattern in loopback-cert.ts for signing client
 * certificates under the constrained GoLem loopback CA. Same ASN.1 encoding,
 * same tags, same OIDs -- except extendedKeyUsage targets clientAuth rather
 * than serverAuth.
 *
 * Zero new npm dependencies: pure node:crypto.
 */

import { createSign, type KeyObject } from "node:crypto";

// ---------------------------------------------------------------------------
// Public types and constants
// ---------------------------------------------------------------------------

export interface BuildCertParams {
  readonly subjectCn: string;
  readonly issuerCn: string;
  readonly subjectPublicKey: KeyObject;
  readonly issuerPrivateKey: KeyObject;
  /** Lifetime in days from now. Default 365. */
  readonly days?: number;
}

/** CN prefix prepended to the device label in issued certificates. */
export const DEVICE_CN_PREFIX = "Golem device:";

// OIDs used in extensions.
const OID_CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_KEY_USAGE = "2.5.29.15";
const OID_EXT_KEY_USAGE = "2.5.29.37";
const OID_SIGN_ALGO = "1.2.840.10045.4.3.2";
const OID_COMMON_NAME = "2.5.4.3";

// ASN.1 tag constants -- identical to loopback-cert.ts.
const T_BOOL = 0x01;
const T_INT = 0x02;
const T_BITSTR = 0x03;
const T_OCTSTR = 0x04;
const T_OID = 0x06;
const T_UTF8 = 0x0c;
const T_UTC = 0x17;
const T_SEQ = 0x30;
const T_SET = 0x31;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a signed X.509 v3 certificate as PEM.
 *
 * The cert carries clientAuth EKU, basicConstraints CA:FALSE, and
 * keyUsage digitalSignature only. Signed by `issuerPrivateKey`.
 */
export function buildClientCertificate(params: BuildCertParams): string {
  const notBefore = new Date(Date.now() - CLOCK_SKEW_MS);
  const notAfter = new Date(Date.now() + (params.days ?? 365) * DAY_MS);

  const tbs = derSequence([
    mkTLV(0xa0, intBuf(Buffer.from([2]))), // [0] EXPLICIT version v3
    intBuf(clientRandomBytes(16)),
    sigAlgoDer(),
    cnOfDer(params.issuerCn),
    derSequence([utcTimeDer(notBefore), utcTimeDer(notAfter)]),
    cnOfDer(params.subjectCn),
    spkiBuf(params.subjectPublicKey),
    mkTLV(0xa3, clientExtensions()), // [3] EXPLICIT extensions
  ]);

  const sig = createSign("sha256").update(tbs).sign(params.issuerPrivateKey);
  return toPem("CERTIFICATE", derSequence([tbs, sigAlgoDer(), bitStr(sig, 0)]));
}

// ---------------------------------------------------------------------------
// Certificate extensions
// ---------------------------------------------------------------------------

/** Extensions for a client-auth leaf: CA:FALSE + digitalSignature + clientAuth EKU. */
function clientExtensions(): Buffer {
  return derSequence([
    ext(OID_BASIC_CONSTRAINTS, true, derSequence([])),
    // digitalSignature only: 0b1000_0000, 1 unused trailing bit
    ext(OID_KEY_USAGE, true, bitStr(Buffer.from([0x80]), 1)),
    ext(OID_EXT_KEY_USAGE, false, derSequence([derOid(OID_CLIENT_AUTH)])),
  ]);
}

// ---------------------------------------------------------------------------
// DER primitives -- same provenance as loopback-cert.ts (§124)
// ---------------------------------------------------------------------------

function encLen(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  return Buffer.concat([Buffer.from([0x80 | bytes.length, ...bytes])]);
}

function mkTLV(tag: number, contents: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encLen(contents.length), contents]);
}

function derSequence(parts: readonly Buffer[]): Buffer {
  return mkTLV(T_SEQ, Buffer.concat([...parts]));
}

function derSet(parts: readonly Buffer[]): Buffer {
  return mkTLV(T_SET, Buffer.concat([...parts]));
}

function derBool(v: boolean): Buffer {
  return mkTLV(T_BOOL, Buffer.from([v ? 0xff : 0x00]));
}

function intBuf(bytes: Buffer): Buffer {
  const first = bytes[0];
  const body =
    first !== undefined && (first & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes;
  return mkTLV(T_INT, body);
}

function derOid(dotted: string): Buffer {
  const arcs = dotted.split(".").map(Number);
  const first = arcs[0];
  const second = arcs[1];
  if (first === undefined || second === undefined) throw new Error(`bad OID: ${dotted}`);
  const out: number[] = [first * 40 + second];
  for (const arc of arcs.slice(2)) {
    const septets: number[] = [arc & 0x7f];
    for (let n = arc >>> 7; n > 0; n >>>= 7) septets.unshift((n & 0x7f) | 0x80);
    out.push(...septets);
  }
  return mkTLV(T_OID, Buffer.from(out));
}

function derUtf8(value: string): Buffer {
  return mkTLV(T_UTF8, Buffer.from(value, "utf8"));
}

function utcTimeDer(date: Date): Buffer {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  const text =
    p(date.getUTCFullYear() % 100) +
    p(date.getUTCMonth() + 1) +
    p(date.getUTCDate()) +
    p(date.getUTCHours()) +
    p(date.getUTCMinutes()) +
    p(date.getUTCSeconds()) +
    "Z";
  return mkTLV(T_UTC, Buffer.from(text, "ascii"));
}

function bitStr(data: Buffer, unusedBits = 0): Buffer {
  return mkTLV(T_BITSTR, Buffer.concat([Buffer.from([unusedBits]), data]));
}

function ext(oid: string, critical: boolean, value: Buffer): Buffer {
  return derSequence([derOid(oid), ...(critical ? [derBool(true)] : []), mkTLV(T_OCTSTR, value)]);
}

function sigAlgoDer(): Buffer {
  return derSequence([derOid(OID_SIGN_ALGO)]);
}

function cnOfDer(commonName: string): Buffer {
  return derSequence([derSet([derSequence([derOid(OID_COMMON_NAME), derUtf8(commonName)])])]);
}

function spkiBuf(publicKey: KeyObject): Buffer {
  const d = publicKey.export({ type: "spki", format: "der" });
  return Buffer.isBuffer(d) ? d : Buffer.from(d);
}

/** Wrap DER in PEM per RFC 7468 (64 chars / line). */
function toPem(label: string, der: Buffer): string {
  const body = der.toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${body}${body.endsWith("\n") ? "" : "\n"}-----END ${label}-----\n`;
}

function clientRandomBytes(n: number): Buffer {
  return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(n)));
}

const CLOCK_SKEW_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
