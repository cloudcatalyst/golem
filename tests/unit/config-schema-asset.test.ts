/**
 * `config-schema.json` — the published half of `golem config schema --json`.
 *
 * This artifact is attached to every release and fetched by the portal, which
 * validates team settings against it before those settings ever reach a
 * developer's machine. So it has one property the interactive output does not
 * need: **it must describe the schema and nothing about the machine that built
 * it.** A leaked header would publish absolute paths, the build box's proxy
 * port and its upstream account to every consumer of the release.
 *
 * The release workflow asserts the same thing before uploading, but that only
 * fires in CI. This pins the boundary where it is cheap to run.
 */

import { describe, expect, it } from "vitest";
import { schemaPayload } from "../../src/cli/commands/config.js";
import type { ControlSurface } from "../../src/config/control-surface.js";

/** A surface shaped like the real one, with both machine-describing fields set. */
const surface = {
  header: {
    version: "9.9.9-test",
    project_dir: "D:\\Personal\\Repos\\Golem",
  },
  groups: [
    {
      id: "knowledge",
      title: "Knowledge",
      controls: [
        { id: "setting:knowledge.enabled", kind: "toggle", value: true, layer: "default" },
      ],
    },
  ],
  warnings: ["unknown key foo.bar in D:\\Personal\\Repos\\Golem\\.golem\\settings.json"],
} as unknown as ControlSurface;

describe("the published config-schema.json payload", () => {
  it("drops the header AND the warnings — both describe the build machine", () => {
    const payload = schemaPayload(surface, false) as Record<string, unknown>;
    expect(payload.header).toBeUndefined();
    expect(payload.warnings).toBeUndefined();
    // Nothing machine-shaped survives anywhere in the serialized artifact.
    expect(JSON.stringify(payload)).not.toContain("project_dir");
    expect(JSON.stringify(payload)).not.toContain("Repos");
  });

  it("carries the version, because the portal caches schemas by it", () => {
    const payload = schemaPayload(surface, false) as Record<string, unknown>;
    expect(typeof payload.version).toBe("string");
    expect((payload.version as string).length).toBeGreaterThan(0);
  });

  it("keeps the groups — an artifact with no controls would validate nothing", () => {
    const payload = schemaPayload(surface, false) as { groups: readonly unknown[] };
    expect(payload.groups).toHaveLength(1);
  });

  it("returns the surface untouched when the header was asked for", () => {
    expect(schemaPayload(surface, true)).toBe(surface);
  });
});
