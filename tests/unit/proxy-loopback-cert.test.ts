/**
 * R9.12: the hand-rolled X.509 leaf (src/proxy/loopback-cert.ts).
 *
 * The DER is written by hand, so every test here parses the result back with
 * `node:crypto`'s own X509Certificate — a wrong encoding must fail loudly, not
 * produce a certificate that only breaks during a TLS handshake. The live
 * handshake half (trusted via NODE_EXTRA_CA_CERTS, untrusted without it) is
 * proven separately in the integration test, mirroring §121's measurement.
 */

import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  generateLoopbackPair,
  generateSelfSignedLeaf,
  PERMITTED_DNS_NAME,
  readCertificate,
} from "../../src/proxy/loopback-cert.js";

describe("generateSelfSignedLeaf", () => {
  it("emits a parseable, self-signed v3 certificate", () => {
    const leaf = generateSelfSignedLeaf();
    const cert = readCertificate(leaf.certPem);

    expect(cert.subject).toBe("CN=golem loopback");
    expect(cert.issuer).toBe(cert.subject); // self-signed: issuer == subject
    expect(cert.verify(cert.publicKey)).toBe(true);
  });

  it("is a LEAF, never a CA — the property that removes the MITM blast radius", () => {
    const cert = readCertificate(generateSelfSignedLeaf().certPem);
    expect(cert.ca).toBe(false);
  });

  it("carries both loopback SAN entries", () => {
    const cert = readCertificate(generateSelfSignedLeaf().certPem);
    expect(cert.subjectAltName).toContain("DNS:localhost");
    expect(cert.subjectAltName).toContain("IP Address:127.0.0.1");
  });

  it("honours custom SAN entries", () => {
    const cert = readCertificate(
      generateSelfSignedLeaf({ dnsNames: ["golem.test"], ipAddresses: ["127.0.0.2"] }).certPem,
    );
    expect(cert.subjectAltName).toContain("DNS:golem.test");
    expect(cert.subjectAltName).toContain("IP Address:127.0.0.2");
    expect(cert.subjectAltName).not.toContain("localhost");
  });

  it("requests serverAuth as its extended key usage", () => {
    const cert = readCertificate(generateSelfSignedLeaf().certPem);
    expect(cert.keyUsage).toContain("1.3.6.1.5.5.7.3.1");
  });

  it("backdates notBefore for clock skew and honours the requested lifetime", () => {
    const nowMs = Date.UTC(2026, 0, 15, 12, 0, 0);
    const leaf = generateSelfSignedLeaf({ nowMs, days: 30 });

    expect(leaf.notBefore.getTime()).toBe(nowMs - 5 * 60 * 1000);
    expect(leaf.notAfter.getTime()).toBe(nowMs + 30 * 24 * 60 * 60 * 1000);

    const cert = readCertificate(leaf.certPem);
    expect(Date.parse(cert.validFrom)).toBe(leaf.notBefore.getTime());
    expect(Date.parse(cert.validTo)).toBe(leaf.notAfter.getTime());
  });

  it("emits a positive serial number even when the random bytes are all high", () => {
    // High bit set in byte 0 would encode as a NEGATIVE DER integer; the
    // generator must mask it rather than emit a negative serial.
    const cert = readCertificate(
      generateSelfSignedLeaf({ randomBytes: (size) => Buffer.alloc(size, 0xff) }).certPem,
    );
    expect(cert.serialNumber.startsWith("7F")).toBe(true);
  });

  it("never emits a zero serial number", () => {
    const cert = readCertificate(
      generateSelfSignedLeaf({ randomBytes: (size) => Buffer.alloc(size, 0x00) }).certPem,
    );
    expect(BigInt(`0x${cert.serialNumber}`)).toBeGreaterThan(0n);
  });

  it("emits PEM wrapped at 64 characters, as RFC 7468 requires", () => {
    const lines = generateSelfSignedLeaf().certPem.trim().split("\n");
    expect(lines[0]).toBe("-----BEGIN CERTIFICATE-----");
    expect(lines.at(-1)).toBe("-----END CERTIFICATE-----");
    for (const line of lines.slice(1, -1)) expect(line.length).toBeLessThanOrEqual(64);
  });

  it("is NOT the shipped shape — a leaf anchor is refused by Claude Code (§123)", () => {
    // Pinned so nobody "simplifies" the CA away: BoringSSL rejects a CA:FALSE
    // anchor with `unable to verify the first certificate`, measured with an
    // openssl-generated control. generateLoopbackPair() is what ships.
    expect(readCertificate(generateSelfSignedLeaf().certPem).ca).toBe(false);
  });

  it("emits a private key usable by node:https", async () => {
    const leaf = generateSelfSignedLeaf();
    expect(leaf.keyPem).toContain("-----BEGIN PRIVATE KEY-----");

    // The real proof that cert and key match: a TLS server accepts the pair.
    const server = createServer({ cert: leaf.certPem, key: leaf.keyPem }, (_req, res) =>
      res.end("ok"),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    expect((server.address() as AddressInfo).port).toBeGreaterThan(0);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe("generateLoopbackPair (the shipped shape, §124)", () => {
  it("issues a CA anchor and a leaf that chains to it", async () => {
    const pair = await generateLoopbackPair();
    const ca = readCertificate(pair.caPem);
    const leaf = readCertificate(pair.leafPem);

    expect(ca.ca).toBe(true); // BoringSSL will not accept a leaf as an anchor
    expect(leaf.ca).toBe(false);
    expect(leaf.issuer).toBe(ca.subject);
    expect(leaf.verify(ca.publicKey)).toBe(true); // actually signed BY the CA
  });

  it("constrains the CA to a DNS name that resolves nowhere", async () => {
    const pair = await generateLoopbackPair();
    // node:crypto exposes no nameConstraints accessor, so assert on the DER:
    // the OID (2.5.29.30 => 55 1d 1e) and the permitted dNSName must be present.
    const der = Buffer.from(pair.caPem.replace(/-----[^-]+-----|\s/g, ""), "base64");
    expect(der.includes(Buffer.from([0x55, 0x1d, 0x1e]))).toBe(true);
    expect(der.includes(Buffer.from(PERMITTED_DNS_NAME, "ascii"))).toBe(true);
  });

  it("gives the CA no path length, so it cannot mint sub-CAs", async () => {
    const pair = await generateLoopbackPair();
    // basicConstraints SEQUENCE { cA TRUE, pathLenConstraint 0 } => 30 06 01 01 ff 02 01 00
    const der = Buffer.from(pair.caPem.replace(/-----[^-]+-----|\s/g, ""), "base64");
    expect(der.includes(Buffer.from([0x30, 0x06, 0x01, 0x01, 0xff, 0x02, 0x01, 0x00]))).toBe(true);
  });

  it("gives the leaf an IP SAN only — a dNSName would violate the constraint", async () => {
    const leaf = readCertificate((await generateLoopbackPair()).leafPem);
    expect(leaf.subjectAltName).toBe("IP Address:127.0.0.1");
    expect(leaf.subjectAltName).not.toContain("DNS:");
  });

  it("presents leaf before CA in the chain, as TLS requires", async () => {
    const pair = await generateLoopbackPair();
    expect(pair.chainPem).toBe(`${pair.leafPem}${pair.caPem}`);
    expect(pair.chainPem.indexOf("BEGIN CERTIFICATE")).toBeLessThan(
      pair.chainPem.lastIndexOf("BEGIN CERTIFICATE"),
    );
  });

  it("gives the CA and the leaf different keys", async () => {
    const pair = await generateLoopbackPair();
    expect(pair.caKeyPem).not.toBe(pair.leafKeyPem);
  });

  it("serves TLS with the chain and validates against the CA alone", async () => {
    const pair = await generateLoopbackPair();
    const server = createServer({ cert: pair.chainPem, key: pair.leafKeyPem }, (_req, res) =>
      res.end("ok"),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    // The real proof the chain is coherent: a client trusting ONLY the CA
    // completes a handshake to the IP the leaf is issued for.
    const { request } = await import("node:https");
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path: "/", ca: pair.caPem, rejectUnauthorized: true },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(200);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
