/**
 * The loopback certificate pair (R9.12; verification-notes §121→§124).
 *
 * WebFetch upgrades `http`→`https` and validates the certificate, so the only
 * shape Golem can serve a green WebFetch from is HTTPS on `127.0.0.1` behind a
 * certificate Claude Code trusts.
 *
 * **What ships, and why it is a CA.** §121 concluded "ship a leaf, never a CA"
 * after measuring against Node/OpenSSL, which accepts a self-signed `CA:FALSE`
 * leaf as its own trust anchor. §123 measured the client that actually matters —
 * Claude Code is a Bun/BoringSSL binary — and it refuses a leaf anchor outright.
 * §124 resolved the impasse without giving the CA real power: `nameConstraints`
 * permitting only `DNS:golem.invalid`, so the CA is accepted as an anchor yet
 * **cannot** issue a certificate for `api.anthropic.com` — measured, the client
 * refuses such a chain with `permitted subtree violation`. `pathlen:0` blocks
 * sub-CAs. The leaf it signs carries `IP:127.0.0.1` and nothing else.
 *
 * The DER is hand-encoded over `node:crypto` rather than adding a dependency or
 * shelling out to `openssl`: the project pins five runtime deps and this feature
 * is cosmetic, while `openssl` would make the green path depend on what happens
 * to be installed. The template never varies, so the ASN.1 surface stays small —
 * and the tests parse every result back with `node:crypto`'s own
 * `X509Certificate`, so a wrong encoding fails loudly rather than producing a
 * certificate that only breaks during a handshake.
 */

import {
  createPrivateKey,
  createSign,
  randomBytes as cryptoRandomBytes,
  generateKeyPair,
  generateKeyPairSync,
  type KeyObject,
  X509Certificate,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// ASN.1 DER primitives
// ---------------------------------------------------------------------------

const TAG_BOOLEAN = 0x01;
const TAG_INTEGER = 0x02;
const TAG_BIT_STRING = 0x03;
const TAG_OCTET_STRING = 0x04;
const TAG_OID = 0x06;
const TAG_UTF8_STRING = 0x0c;
const TAG_UTC_TIME = 0x17;
const TAG_SEQUENCE = 0x30;
const TAG_SET = 0x31;

/** DER length: short form below 128, else long form (leading byte = 0x80 | byte-count). */
function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** A single DER tag-length-value. */
function tlv(tag: number, contents: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(contents.length), contents]);
}

function derSequence(parts: readonly Buffer[]): Buffer {
  return tlv(TAG_SEQUENCE, Buffer.concat([...parts]));
}

function derSet(parts: readonly Buffer[]): Buffer {
  return tlv(TAG_SET, Buffer.concat([...parts]));
}

function derBoolean(value: boolean): Buffer {
  return tlv(TAG_BOOLEAN, Buffer.from([value ? 0xff : 0x00]));
}

/**
 * DER INTEGER from raw big-endian bytes. DER integers are signed, so a leading
 * byte with the high bit set would read as negative and needs a 0x00 pad.
 */
function derInteger(bytes: Buffer): Buffer {
  const first = bytes[0];
  const body =
    first !== undefined && (first & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes;
  return tlv(TAG_INTEGER, body);
}

/** DER OBJECT IDENTIFIER from dotted notation ("1.2.840.113549.1.1.11"). */
function derOid(dotted: string): Buffer {
  const arcs = dotted.split(".").map(Number);
  const first = arcs[0];
  const second = arcs[1];
  if (first === undefined || second === undefined) throw new Error(`bad OID: ${dotted}`);
  const out: number[] = [first * 40 + second];
  for (const arc of arcs.slice(2)) {
    // base-128, big-endian, continuation bit set on all but the final septet
    const septets: number[] = [arc & 0x7f];
    for (let n = arc >>> 7; n > 0; n >>>= 7) septets.unshift((n & 0x7f) | 0x80);
    out.push(...septets);
  }
  return tlv(TAG_OID, Buffer.from(out));
}

function derUtf8String(value: string): Buffer {
  return tlv(TAG_UTF8_STRING, Buffer.from(value, "utf8"));
}

function derOctetString(contents: Buffer): Buffer {
  return tlv(TAG_OCTET_STRING, contents);
}

/** DER BIT STRING; the first content byte is the count of unused trailing bits. */
function derBitString(contents: Buffer, unusedBits = 0): Buffer {
  return tlv(TAG_BIT_STRING, Buffer.concat([Buffer.from([unusedBits]), contents]));
}

/** DER UTCTime (`YYMMDDHHMMSSZ`, UTC). Valid for years 1950–2049 — ample here. */
function derUtcTime(date: Date): Buffer {
  const p = (n: number, width = 2): string => String(n).padStart(width, "0");
  const text =
    p(date.getUTCFullYear() % 100) +
    p(date.getUTCMonth() + 1) +
    p(date.getUTCDate()) +
    p(date.getUTCHours()) +
    p(date.getUTCMinutes()) +
    p(date.getUTCSeconds()) +
    "Z";
  return tlv(TAG_UTC_TIME, Buffer.from(text, "ascii"));
}

// ---------------------------------------------------------------------------
// X.509 structure
// ---------------------------------------------------------------------------

const OID_ECDSA_WITH_SHA256 = "1.2.840.10045.4.3.2";
const OID_COMMON_NAME = "2.5.4.3";
const OID_EXT_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_EXT_KEY_USAGE = "2.5.29.15";
const OID_EXT_SUBJECT_ALT_NAME = "2.5.29.17";
const OID_EXT_EXTENDED_KEY_USAGE = "2.5.29.37";
const OID_EXT_NAME_CONSTRAINTS = "2.5.29.30";
const OID_KP_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
const OID_KP_CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";

/** Context-specific primitive tags inside GeneralName (SAN). */
const SAN_TAG_DNS_NAME = 0x82; // [2] IA5String
const SAN_TAG_IP_ADDRESS = 0x87; // [7] OCTET STRING (4 raw bytes for IPv4)

/**
 * `AlgorithmIdentifier` for ecdsa-with-SHA256. RFC 5758 requires the parameters
 * field to be ABSENT for this algorithm — unlike RSA, where an explicit NULL is
 * required. Emitting a NULL here produces a certificate some verifiers reject.
 */
function signatureAlgorithm(): Buffer {
  return derSequence([derOid(OID_ECDSA_WITH_SHA256)]);
}

/** An X.501 `Name` carrying a single CN attribute. */
function commonNameOf(commonName: string): Buffer {
  return derSequence([derSet([derSequence([derOid(OID_COMMON_NAME), derUtf8String(commonName)])])]);
}

/** `Extension ::= SEQUENCE { extnID, critical DEFAULT FALSE, extnValue OCTET STRING }`. */
function extension(oid: string, critical: boolean, value: Buffer): Buffer {
  return derSequence([
    derOid(oid),
    // DER omits a DEFAULT-valued field, so `critical: false` is encoded by absence
    ...(critical ? [derBoolean(true)] : []),
    derOctetString(value),
  ]);
}

/**
 * Extensions for the SERVER leaf. `basicConstraints` is an EMPTY sequence: `cA`
 * defaults to FALSE and DER omits defaults, so this is exactly `CA:FALSE`.
 *
 * In the shipped shape the SAN carries **only** `IP:127.0.0.1`, for two measured
 * reasons (§124): WebFetch rejects `https://localhost:<port>` as `Invalid URL`,
 * so an IP literal is the only reachable target; and any dNSName outside the
 * issuing CA's permitted subtree makes the client refuse the chain with
 * `permitted subtree violation`.
 */
function leafExtensions(dnsNames: readonly string[], ipAddresses: readonly string[]): Buffer {
  const sanEntries: Buffer[] = [
    ...dnsNames.map((name) => tlv(SAN_TAG_DNS_NAME, Buffer.from(name, "ascii"))),
    ...ipAddresses.map((ip) => tlv(SAN_TAG_IP_ADDRESS, Buffer.from(ip.split(".").map(Number)))),
  ];
  return derSequence([
    extension(OID_EXT_BASIC_CONSTRAINTS, true, derSequence([])),
    // digitalSignature (bit 0) + keyEncipherment (bit 2) => 0b1010_0000, 5 unused bits
    extension(OID_EXT_KEY_USAGE, true, derBitString(Buffer.from([0xa0]), 5)),
    extension(OID_EXT_EXTENDED_KEY_USAGE, false, derSequence([derOid(OID_KP_SERVER_AUTH)])),
    extension(OID_EXT_SUBJECT_ALT_NAME, false, derSequence(sanEntries)),
  ]);
}

/**
 * `NameConstraints ::= SEQUENCE { permittedSubtrees [0] GeneralSubtrees OPTIONAL, … }`
 * with `GeneralSubtree ::= SEQUENCE { base GeneralName, … }`. `[0]` is IMPLICIT,
 * so it replaces the `SEQUENCE OF` tag rather than wrapping it.
 *
 * Only the **dNSName** form is constrained, deliberately (§124): BoringSSL cannot
 * parse an `iPAddress` constraint and rejects the entire anchor with
 * `unsupported name constraint type` when one is present. Constraining the DNS
 * form is what makes this CA unable to issue a certificate for
 * `api.anthropic.com` — measured live: such a chain is refused with
 * `permitted subtree violation`.
 */
function nameConstraintsExtension(permittedDnsNames: readonly string[]): Buffer {
  const subtrees = permittedDnsNames.map((name) =>
    derSequence([tlv(SAN_TAG_DNS_NAME, Buffer.from(name, "ascii"))]),
  );
  return extension(
    OID_EXT_NAME_CONSTRAINTS,
    true,
    derSequence([tlv(0xa0, Buffer.concat(subtrees))]),
  );
}

/**
 * Extensions for the constrained ISSUING CA. `pathlen:0` stops it minting
 * sub-CAs, `keyCertSign`+`cRLSign` are its only usages, and the name constraint
 * is what bounds the damage if the key is ever read.
 */
function caExtensions(permittedDnsNames: readonly string[]): Buffer {
  return derSequence([
    // SEQUENCE { cA BOOLEAN TRUE, pathLenConstraint INTEGER 0 }
    extension(
      OID_EXT_BASIC_CONSTRAINTS,
      true,
      derSequence([derBoolean(true), derInteger(Buffer.from([0]))]),
    ),
    // keyCertSign (bit 5) + cRLSign (bit 6) => 0b0000_0110, 1 unused trailing bit
    extension(OID_EXT_KEY_USAGE, true, derBitString(Buffer.from([0x06]), 1)),
    nameConstraintsExtension(permittedDnsNames),
  ]);
}

/** Wrap DER in PEM, 64 characters to a line (RFC 7468). */
function toPem(label: string, der: Buffer): string {
  const body = der.toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${body}${body.endsWith("\n") ? "" : "\n"}-----END ${label}-----\n`;
}

/** A random, positive, 16-byte serial number (high bit cleared, never zero). */
function randomSerial(randomBytes: (size: number) => Buffer): Buffer {
  const bytes = randomBytes(16);
  const first = bytes[0] ?? 1;
  bytes[0] = first & 0x7f || 1;
  return bytes;
}

export interface SelfSignedLeafOptions {
  /** Certificate CN. Cosmetic — TLS matching is done from the SAN. */
  readonly commonName?: string;
  /** Lifetime in days from `nowMs`. */
  readonly days?: number;
  /** Clock injection point (tests). */
  readonly nowMs?: number;
  /** SAN dNSName entries. */
  readonly dnsNames?: readonly string[];
  /** SAN iPAddress entries (IPv4 dotted-quad). */
  readonly ipAddresses?: readonly string[];
  /** Randomness injection point (tests); defaults to `node:crypto`. */
  readonly randomBytes?: (size: number) => Buffer;
}

export interface SelfSignedLeaf {
  readonly certPem: string;
  readonly keyPem: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
}

/** Backdate `notBefore` to absorb small clock differences between processes. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Assemble and sign one certificate. Self-signing is just the case where the
 * issuer name and signing key belong to the subject itself.
 */
function buildCertificate(params: {
  readonly subjectCn: string;
  readonly issuerCn: string;
  readonly subjectPublicKey: KeyObject;
  readonly issuerPrivateKey: KeyObject;
  readonly extensions: Buffer;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly serial: Buffer;
}): Buffer {
  const tbsCertificate = derSequence([
    tlv(0xa0, derInteger(Buffer.from([2]))), // [0] EXPLICIT version — v3
    derInteger(params.serial),
    signatureAlgorithm(),
    commonNameOf(params.issuerCn),
    derSequence([derUtcTime(params.notBefore), derUtcTime(params.notAfter)]),
    commonNameOf(params.subjectCn),
    spkiOf(params.subjectPublicKey),
    tlv(0xa3, params.extensions), // [3] EXPLICIT extensions
  ]);

  const signature = createSign("sha256").update(tbsCertificate).sign(params.issuerPrivateKey);
  return derSequence([tbsCertificate, signatureAlgorithm(), derBitString(signature, 0)]);
}

/**
 * Generate a self-signed `CA:FALSE` leaf. Retained because it is the shape §121
 * measured and the tests pin the DER against it, but it is NOT what ships: §124
 * measured that Claude Code (BoringSSL) refuses a leaf as a trust anchor with
 * `unable to verify the first certificate`. Use {@link generateLoopbackPair}.
 */
export function generateSelfSignedLeaf(options: SelfSignedLeafOptions = {}): SelfSignedLeaf {
  const {
    commonName = "golem loopback",
    days = 365,
    nowMs = Date.now(),
    dnsNames = ["localhost"],
    ipAddresses = ["127.0.0.1"],
    randomBytes = cryptoRandomBytes,
  } = options;

  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const notBefore = new Date(nowMs - CLOCK_SKEW_MS);
  const notAfter = new Date(nowMs + days * 24 * 60 * 60 * 1000);

  return {
    certPem: toPem(
      "CERTIFICATE",
      buildCertificate({
        subjectCn: commonName,
        issuerCn: commonName,
        subjectPublicKey: publicKey,
        issuerPrivateKey: privateKey,
        extensions: leafExtensions(dnsNames, ipAddresses),
        notBefore,
        notAfter,
        serial: randomSerial(randomBytes),
      }),
    ),
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    notBefore,
    notAfter,
  };
}

/** The DNS name the CA is permitted to issue for — reserved TLD, resolves nowhere. */
export const PERMITTED_DNS_NAME = "golem.invalid";

/**
 * P-256 keypair, off the event loop.
 *
 * EC rather than RSA, for cost: `golem init` generates this pair, and two
 * RSA-2048 keygens made every init-touching test slow enough that the suite
 * started timing out under parallel load (and made init itself sluggish). P-256
 * generation is effectively instant, and an ECDSA leaf is accepted by the same
 * clients — re-verified live against Claude Code after the switch.
 */
function generateEcKeyPair(): Promise<{ privateKey: KeyObject; publicKey: KeyObject }> {
  return new Promise((resolve, reject) => {
    generateKeyPair("ec", { namedCurve: "prime256v1" }, (err, publicKey, privateKey) => {
      if (err) reject(err);
      else resolve({ publicKey, privateKey });
    });
  });
}

export interface LoopbackPair {
  /** The constrained CA. This is the file `NODE_EXTRA_CA_CERTS` points at. */
  readonly caPem: string;
  readonly caKeyPem: string;
  /** The server certificate, signed by the CA, SAN `IP:127.0.0.1` only. */
  readonly leafPem: string;
  readonly leafKeyPem: string;
  /** leaf + CA, in that order — what the HTTPS server presents. */
  readonly chainPem: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
}

/**
 * Generate the shipped shape (§124): a DNS-name-constrained CA, plus a server
 * leaf it signs for `IP:127.0.0.1`.
 *
 * The CA is the trust anchor because BoringSSL will not accept a bare leaf as
 * one. Its `nameConstraints` bound what that trust is worth: it can issue
 * dNSName certificates only under {@link PERMITTED_DNS_NAME}, so it **cannot**
 * mint one for `api.anthropic.com` — the objection that blocked R9.7 and §120.
 * The `iPAddress` form is left unconstrained because constraining it makes
 * BoringSSL reject the anchor outright; that residual is documented in §124.
 */
export async function generateLoopbackPair(
  options: { readonly days?: number; readonly nowMs?: number } & Pick<
    SelfSignedLeafOptions,
    "randomBytes"
  > = {},
): Promise<LoopbackPair> {
  const { days = 365, nowMs = Date.now(), randomBytes = cryptoRandomBytes } = options;
  const notBefore = new Date(nowMs - CLOCK_SKEW_MS);
  const notAfter = new Date(nowMs + days * 24 * 60 * 60 * 1000);

  const caCn = "Golem loopback CA (constrained)";
  const leafCn = "Golem loopback";
  // ASYNC keygen, deliberately: `generateKeyPairSync` blocks the event loop for
  // seconds, and this runs inside the proxy daemon just after it binds its port —
  // a blocked loop means the readiness probe times out and `proxy restart`
  // reports "did not come up" for a proxy that is in fact fine (observed once).
  const [ca, leaf] = await Promise.all([generateEcKeyPair(), generateEcKeyPair()]);

  const caDer = buildCertificate({
    subjectCn: caCn,
    issuerCn: caCn,
    subjectPublicKey: ca.publicKey,
    issuerPrivateKey: ca.privateKey,
    extensions: caExtensions([PERMITTED_DNS_NAME]),
    notBefore,
    notAfter,
    serial: randomSerial(randomBytes),
  });
  const leafDer = buildCertificate({
    subjectCn: leafCn,
    issuerCn: caCn, // chains to the CA by name
    subjectPublicKey: leaf.publicKey,
    issuerPrivateKey: ca.privateKey, // signed BY the CA
    extensions: leafExtensions([], ["127.0.0.1"]),
    notBefore,
    notAfter,
    serial: randomSerial(randomBytes),
  });

  const caPem = toPem("CERTIFICATE", caDer);
  const leafPem = toPem("CERTIFICATE", leafDer);
  return {
    caPem,
    caKeyPem: ca.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    leafPem,
    leafKeyPem: leaf.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    chainPem: `${leafPem}${caPem}`,
    notBefore,
    notAfter,
  };
}

/**
 * The `SubjectPublicKeyInfo` DER. Node's SPKI export IS a SubjectPublicKeyInfo,
 * so this needs no hand-encoding — the one part of the certificate we can take
 * verbatim from the platform.
 */
function spkiOf(publicKey: KeyObject): Buffer {
  const der = publicKey.export({ type: "spki", format: "der" });
  return Buffer.isBuffer(der) ? der : Buffer.from(der);
}

/**
 * Parse a certificate back with the platform's own X.509 reader. Used by the
 * lifecycle path to decide whether a stored certificate is still usable, and by
 * tests to prove the hand-rolled DER is well-formed.
 */
export function readCertificate(certPem: string): X509Certificate {
  return new X509Certificate(certPem);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Where the loopback pair lives. This path is what `NODE_EXTRA_CA_CERTS` points at. */
export function loopbackCertDir(projectDir: string): string {
  return join(projectDir, ".golem", "loopback");
}

/** The constrained CA — the anchor `NODE_EXTRA_CA_CERTS` points at. */
export function loopbackCaPath(projectDir: string): string {
  return join(loopbackCertDir(projectDir), "ca.pem");
}

export function loopbackCaKeyPath(projectDir: string): string {
  return join(loopbackCertDir(projectDir), "ca.key.pem");
}

/** The server certificate the endpoint presents (SAN `IP:127.0.0.1`). */
export function loopbackLeafPath(projectDir: string): string {
  return join(loopbackCertDir(projectDir), "leaf.pem");
}

export function loopbackLeafKeyPath(projectDir: string): string {
  return join(loopbackCertDir(projectDir), "leaf.key.pem");
}

/** Regenerate once the remaining lifetime drops below this. */
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

export interface LoopbackCert {
  /** The anchor path — what `NODE_EXTRA_CA_CERTS` must point at. */
  readonly caPath: string;
  readonly caKeyPath: string;
  readonly leafPath: string;
  readonly leafKeyPath: string;
  readonly caPem: string;
  readonly caKeyPem: string;
  readonly leafPem: string;
  readonly leafKeyPem: string;
  /** leaf + CA, in that order — what the HTTPS server presents. */
  readonly chainPem: string;
  readonly notAfter: Date;
  /** True when this call created or replaced the pair (callers log a restart hint). */
  readonly regenerated: boolean;
}

/** Whether a stored certificate is still usable, or needs replacing. */
function isUsable(certPem: string, nowMs: number): boolean {
  try {
    const cert = readCertificate(certPem);
    const notAfter = Date.parse(cert.validTo);
    const notBefore = Date.parse(cert.validFrom);
    if (!Number.isFinite(notAfter) || !Number.isFinite(notBefore)) return false;
    // Not yet valid (clock moved backwards) or inside the renewal window → replace.
    return notBefore <= nowMs && notAfter - nowMs > RENEW_BEFORE_MS;
  } catch {
    return false; // unparseable → replace
  }
}

/**
 * Load the project's loopback CA + leaf, generating them when any file is
 * missing, unparseable, expired, or inside the renewal window. Both private keys
 * are written `0o600`; on Windows that maps onto the read-only attribute rather
 * than an ACL, so a key is only as private as the project directory — which
 * already holds the KB and the web cache. The CA key is the sensitive one: see
 * §124 for exactly what holding it does and does not permit.
 */
export async function ensureLoopbackCert(
  projectDir: string,
  options: { readonly nowMs?: number; readonly days?: number } = {},
): Promise<LoopbackCert> {
  const nowMs = options.nowMs ?? Date.now();
  const caPath = loopbackCaPath(projectDir);
  const caKeyPath = loopbackCaKeyPath(projectDir);
  const leafPath = loopbackLeafPath(projectDir);
  const leafKeyPath = loopbackLeafKeyPath(projectDir);

  try {
    const [caPem, caKeyPem, leafPem, leafKeyPem] = await Promise.all([
      readFile(caPath, "utf8"),
      readFile(caKeyPath, "utf8"),
      readFile(leafPath, "utf8"),
      readFile(leafKeyPath, "utf8"),
    ]);
    // Both halves must still be good: an expired leaf under a live CA is just as
    // unusable as the reverse.
    if (isUsable(caPem, nowMs) && isUsable(leafPem, nowMs)) {
      return {
        caPath,
        caKeyPath,
        leafPath,
        leafKeyPath,
        caPem,
        caKeyPem,
        leafPem,
        leafKeyPem,
        chainPem: `${leafPem}${caPem}`,
        notAfter: new Date(readCertificate(leafPem).validTo),
        regenerated: false,
      };
    }
  } catch {
    // missing or unreadable → fall through and generate
  }

  const pair = await generateLoopbackPair({
    nowMs,
    ...(options.days !== undefined ? { days: options.days } : {}),
  });
  await mkdir(loopbackCertDir(projectDir), { recursive: true });
  await Promise.all([
    writeFile(caPath, pair.caPem, { encoding: "utf8", mode: 0o644 }),
    writeFile(caKeyPath, pair.caKeyPem, { encoding: "utf8", mode: 0o600 }),
    writeFile(leafPath, pair.leafPem, { encoding: "utf8", mode: 0o644 }),
    writeFile(leafKeyPath, pair.leafKeyPem, { encoding: "utf8", mode: 0o600 }),
  ]);
  return {
    caPath,
    caKeyPath,
    leafPath,
    leafKeyPath,
    caPem: pair.caPem,
    caKeyPem: pair.caKeyPem,
    leafPem: pair.leafPem,
    leafKeyPem: pair.leafKeyPem,
    chainPem: pair.chainPem,
    notAfter: pair.notAfter,
    regenerated: true,
  };
}

// ---------------------------------------------------------------------------
// R13.4 — device client certificates (mTLS)
//
// The device CA is a SEPARATE anchor from the loopback CA above, deliberately.
// They answer different questions: the loopback CA exists so a client trusts
// Golem's server, and its certificate is installed in a trust store
// (`NODE_EXTRA_CA_CERTS`). The device CA exists so Golem's server can identify a
// client, and it is installed nowhere — it is only ever passed as the `ca` of
// Golem's own write server. Sharing one key would mean a device credential and
// the proxy's TLS identity could not be rotated or revoked independently, and it
// would put a key that signs client identities into a file the user is told to
// trust for server identities.
//
// It carries NO `nameConstraints`, and that is a considered choice rather than
// an omission. The constraint form that bounds the loopback CA is `dNSName`, and
// a device certificate has no `dNSName` — it has no SAN at all, because a client
// certificate is not matched against a hostname. A dNSName constraint over a
// certificate with no dNSName constrains nothing, and OpenSSL falls back to
// checking the subject CN against it, which would reject our own device CNs.
// What bounds this CA instead is that it is never a trust anchor for anything
// except Golem's write server, its leaves carry `clientAuth` and nothing else,
// and `verifyDeviceCert` checks that EKU explicitly rather than assuming a
// chain implies a purpose.
// ---------------------------------------------------------------------------

/**
 * Extensions for a DEVICE client certificate: `CA:FALSE`, `digitalSignature`
 * only, `clientAuth` only, and no SAN.
 *
 * `keyUsage` is `digitalSignature` alone (bit 0 gives `0b1000_0000`, 7 unused
 * bits) — narrower than the server leaf's `digitalSignature + keyEncipherment`,
 * because signing the TLS handshake is the entire job of a client certificate.
 */
function deviceCertExtensions(): Buffer {
  return derSequence([
    extension(OID_EXT_BASIC_CONSTRAINTS, true, derSequence([])),
    extension(OID_EXT_KEY_USAGE, true, derBitString(Buffer.from([0x80]), 7)),
    extension(OID_EXT_EXTENDED_KEY_USAGE, false, derSequence([derOid(OID_KP_CLIENT_AUTH)])),
  ]);
}

/** Extensions for the device-issuing CA: `CA:TRUE, pathlen:0`, cert/CRL signing only. */
function deviceCaExtensions(): Buffer {
  return derSequence([
    extension(
      OID_EXT_BASIC_CONSTRAINTS,
      true,
      derSequence([derBoolean(true), derInteger(Buffer.from([0]))]),
    ),
    extension(OID_EXT_KEY_USAGE, true, derBitString(Buffer.from([0x06]), 1)),
  ]);
}

/** The CN prefix every device certificate carries; the suffix is the device id. */
export const DEVICE_CN_PREFIX = "golem-device:";

/** The device-issuing CA's own CN. */
export const DEVICE_CA_CN = "Golem device CA";

export interface DeviceCa {
  readonly caPem: string;
  readonly caKeyPem: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
}

/**
 * Generate the device-issuing CA. Long-lived (10 years by default): rotating it
 * invalidates every enrolled device at once, which is a bigger event than any
 * single revocation and should be a deliberate act, not an expiry.
 */
export async function generateDeviceCa(
  options: { readonly days?: number; readonly nowMs?: number } & Pick<
    SelfSignedLeafOptions,
    "randomBytes"
  > = {},
): Promise<DeviceCa> {
  const { days = 3650, nowMs = Date.now(), randomBytes = cryptoRandomBytes } = options;
  const notBefore = new Date(nowMs - CLOCK_SKEW_MS);
  const notAfter = new Date(nowMs + days * 24 * 60 * 60 * 1000);
  const ca = await generateEcKeyPair();

  const der = buildCertificate({
    subjectCn: DEVICE_CA_CN,
    issuerCn: DEVICE_CA_CN,
    subjectPublicKey: ca.publicKey,
    issuerPrivateKey: ca.privateKey,
    extensions: deviceCaExtensions(),
    notBefore,
    notAfter,
    serial: randomSerial(randomBytes),
  });

  return {
    caPem: toPem("CERTIFICATE", der),
    caKeyPem: ca.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    notBefore,
    notAfter,
  };
}

export interface DeviceCertOptions {
  /** The device-issuing CA, from {@link generateDeviceCa}. */
  readonly ca: Pick<DeviceCa, "caPem" | "caKeyPem">;
  /** Device id — becomes the CN as `golem-device:<id>`. */
  readonly deviceId: string;
  /** Lifetime in days. Short by design: an unrevoked lost device still expires. */
  readonly days?: number;
  readonly nowMs?: number;
  readonly randomBytes?: (size: number) => Buffer;
}

export interface DeviceCert {
  readonly certPem: string;
  readonly keyPem: string;
  /** SHA-256 fingerprint, colon-separated uppercase hex — the catalog's key. */
  readonly fingerprint: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
}

/**
 * Issue one device client certificate from the device CA.
 *
 * The private key is generated HERE and returned once, to be handed to the
 * device during local enrolment and never stored by Golem. Golem keeps the
 * fingerprint, which is all it needs to recognise the device again and all an
 * attacker reading `.golem/devices/` would get.
 */
export async function issueDeviceCert(options: DeviceCertOptions): Promise<DeviceCert> {
  const { ca, deviceId, days = 90, nowMs = Date.now(), randomBytes = cryptoRandomBytes } = options;
  const notBefore = new Date(nowMs - CLOCK_SKEW_MS);
  const notAfter = new Date(nowMs + days * 24 * 60 * 60 * 1000);
  const device = await generateEcKeyPair();
  const caKey = createPrivateKey(ca.caKeyPem);

  const der = buildCertificate({
    subjectCn: `${DEVICE_CN_PREFIX}${deviceId}`,
    issuerCn: DEVICE_CA_CN,
    subjectPublicKey: device.publicKey,
    issuerPrivateKey: caKey,
    extensions: deviceCertExtensions(),
    notBefore,
    notAfter,
    serial: randomSerial(randomBytes),
  });

  const certPem = toPem("CERTIFICATE", der);
  return {
    certPem,
    keyPem: device.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    fingerprint: new X509Certificate(certPem).fingerprint256,
    notBefore,
    notAfter,
  };
}

/** Why a presented certificate was not accepted. */
export type DeviceCertRejection =
  | "not-signed-by-device-ca"
  | "expired"
  | "not-yet-valid"
  | "wrong-subject"
  | "not-client-auth";

export type DeviceCertVerdict =
  | { readonly ok: true; readonly deviceId: string; readonly fingerprint: string }
  | { readonly ok: false; readonly reason: DeviceCertRejection };

/**
 * Verify a presented client certificate against the device CA, structurally.
 *
 * Node's TLS layer already checks the chain when `rejectUnauthorized` is on —
 * but R13.4's write server deliberately runs with `requestCert: true` and
 * `rejectUnauthorized: false`, so a bad certificate produces a 401 naming what
 * was wrong instead of a TLS alert the phone renders as "cannot connect". That
 * choice moves the check here, so it is written out rather than assumed:
 * signature, validity window, subject shape, and the `clientAuth` EKU.
 */
export function verifyDeviceCert(
  certPem: string,
  caPem: string,
  nowMs: number = Date.now(),
): DeviceCertVerdict {
  let cert: X509Certificate;
  let ca: X509Certificate;
  try {
    cert = new X509Certificate(certPem);
    ca = new X509Certificate(caPem);
  } catch {
    return { ok: false, reason: "not-signed-by-device-ca" };
  }
  if (!cert.verify(ca.publicKey)) return { ok: false, reason: "not-signed-by-device-ca" };
  if (nowMs < Date.parse(cert.validFrom)) return { ok: false, reason: "not-yet-valid" };
  if (nowMs > Date.parse(cert.validTo)) return { ok: false, reason: "expired" };

  // The EKU is checked explicitly: a chain proves who signed a key, not what the
  // key is allowed to do, and a certificate this CA issued for some other
  // purpose must not authenticate a device by accident.
  if (!hasClientAuthEku(cert)) return { ok: false, reason: "not-client-auth" };

  const cn = /CN=(.+)$/m.exec(cert.subject)?.[1]?.trim();
  if (cn === undefined || !cn.startsWith(DEVICE_CN_PREFIX)) {
    return { ok: false, reason: "wrong-subject" };
  }
  const deviceId = cn.slice(DEVICE_CN_PREFIX.length);
  if (deviceId.length === 0) return { ok: false, reason: "wrong-subject" };

  return { ok: true, deviceId, fingerprint: cert.fingerprint256 };
}

/**
 * Does the certificate carry the `clientAuth` EKU?
 *
 * `X509Certificate` exposes `keyUsage` as the EXTENDED key usage OIDs (the
 * plain `keyUsage` bit string has no accessor), so this reads that array. A
 * certificate with no EKU extension at all reports `undefined`, which is
 * unconstrained in RFC 5280 terms — and treated here as a rejection, because
 * "the issuer did not say what this is for" is not the same as "the issuer said
 * it is for this", and only the second should authenticate a device.
 */
function hasClientAuthEku(cert: X509Certificate): boolean {
  return (cert.keyUsage ?? []).includes(OID_KP_CLIENT_AUTH);
}
