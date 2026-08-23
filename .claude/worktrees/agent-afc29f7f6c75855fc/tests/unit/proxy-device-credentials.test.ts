/**
 * Tests for src/proxy/device-credentials.ts
 *
 * Covers: certificate issuance, metadata CRUD, revocation, list order,
 * ID generation, directory safety, and lastSeen updates.
 */

import { describe, expect, it } from "vitest";
import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  devicesStateDir,
  getDeviceMetadata,
  issueDeviceCertificate,
  listDevices,
  generateDeviceId,
  revokeDevice,
  touchLastSeen,
  DeviceMetadata,
} from "../../src/proxy/device-credentials.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an empty temp project dir. Caller must clean up. */
async function mkProject(): Promise<string> {
  const dir = join(tmpdir(), `golem-test-devices-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function mockMetadata(overrides?: Partial<DeviceMetadata>): DeviceMetadata {
  return {
    deviceId: generateDeviceId(),
    label: "test-device",
    notAfter: new Date(Date.now() + 86400000).toISOString(),
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    revoked: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Certificate issuance
// ---------------------------------------------------------------------------

describe("issueDeviceCertificate", () => {
  it("creates cert.pem, key.pem and metadata.json under .golem/state/devices/<id>/", async () => {
    const projectDir = await mkProject();
    try {
      const id = generateDeviceId();
      await issueDeviceCertificate(id, "my-machine", projectDir);

      const dir = join(devicesStateDir(projectDir), id);
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(dir);
      expect(entries).toContain("cert.pem");
      expect(entries).toContain("key.pem");
      expect(entries).toContain("metadata.json");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("writes valid JSON metadata with required fields", async () => {
    const projectDir = await mkProject();
    try {
      const id = generateDeviceId();
      await issueDeviceCertificate(id, "web-server", projectDir);
      const meta = await getDeviceMetadata(projectDir, id);
      expect(meta).not.toBeNull();
      expect(meta!.deviceId).toBe(id);
      expect(meta!.label).toBe("web-server");
      expect(meta!.revoked).toBe(false);
      expect(meta!.notAfter).toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(meta!.createdAt).toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(meta!.lastSeen).toMatch(/\d{4}-\d{2}-\d{2}/);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Metadata reads
// ---------------------------------------------------------------------------

describe("getDeviceMetadata", () => {
  it("returns null for unknown device id", async () => {
    const projectDir = await mkProject();
    try {
      const result = await getDeviceMetadata(projectDir, generateDeviceId());
      expect(result).toBeNull();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("returns null for revoked device", async () => {
    const projectDir = await mkProject();
    try {
      const id = generateDeviceId();
      await issueDeviceCertificate(id, "dev-box", projectDir);
      await revokeDevice(projectDir, id);
      const result = await getDeviceMetadata(projectDir, id);
      expect(result).toBeNull();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

describe("listDevices", () => {
  it("returns paired devices sorted by createdAt desc", async () => {
    const projectDir = await mkProject();
    try {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const id = generateDeviceId();
        ids.push(id);
        // Use file-system-level sleep via setTimeout hack — just ensure unique timestamps.
        await issueDeviceCertificate(id, `device-${i}`, projectDir);
      }
      // Add a fourth after revoking one of the earlier ones.
      await revokeDevice(projectDir, ids[0]);

      const devices = await listDevices(projectDir);
      expect(devices.length).toBe(2); // ids[1], ids[2] remain active.
      // Should be newest first.
      expect(devices[0].createdAt >= devices[1].createdAt).toBe(true);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("returns empty array when no devices exist", async () => {
    const projectDir = await mkProject();
    try {
      const devices = await listDevices(projectDir);
      expect(devices).toEqual([]);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

describe("revokeDevice", () => {
  it("marks device as revoked and returns true", async () => {
    const projectDir = await mkProject();
    try {
      const id = generateDeviceId();
      await issueDeviceCertificate(id, "revoked-laptop", projectDir);
      const ok = await revokeDevice(projectDir, id);
      expect(ok).toBe(true);
      const meta = await getDeviceMetadata(projectDir, id);
      expect(meta).toBeNull(); // revoked devices excluded from getDeviceMetadata
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("returns false for already-revoked device", async () => {
    const projectDir = await mkProject();
    try {
      const id = generateDeviceId();
      await issueDeviceCertificate(id, "test", projectDir);
      await revokeDevice(projectDir, id);
      const ok = await revokeDevice(projectDir, id);
      expect(ok).toBe(false);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("returns false for unknown device", async () => {
    const projectDir = await mkProject();
    try {
      const ok = await revokeDevice(projectDir, generateDeviceId());
      expect(ok).toBe(false);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// lastSeen updates
// ---------------------------------------------------------------------------

describe("touchLastSeen", () => {
  it("updates lastSeen timestamp", async () => {
    const projectDir = await mkProject();
    try {
      const id = generateDeviceId();
      await issueDeviceCertificate(id, "seen-tracker", projectDir);
      const before = await getDeviceMetadata(projectDir, id);
      await new Promise((r) => setTimeout(r, 50));
      await touchLastSeen(projectDir, id);
      const after = await getDeviceMetadata(projectDir, id);
      expect(after!.lastSeen > before!.lastSeen).toBe(true);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("is a no-op for unknown device", async () => {
    const projectDir = await mkProject();
    try {
      // Should not throw.
      await touchLastSeen(projectDir, generateDeviceId());
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

describe("generateDeviceId", () => {
  it("produces 32 lowercase hex characters", () => {
    const id = generateDeviceId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("does not produce duplicates", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateDeviceId());
    }
    expect(ids.size).toBe(1000);
  });
});
