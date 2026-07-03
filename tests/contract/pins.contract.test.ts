/**
 * T-C4 guard: Headroom pins are exact and consistent everywhere.
 *
 * Spec Decision 18: the DEFAULT install has NO Headroom dependency (the
 * lossless stage is Golem-native TS). When the P2 sidecar work adds the npm
 * client, it must be pinned exactly to HEADROOM_CLIENT_NPM_PIN. Bumping either
 * pin is only allowed via the T-C4 upgrade playbook.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HEADROOM_CLIENT_NPM_PIN } from "../../src/compression/index.js";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");

interface PackageJson {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;

describe("Headroom pin discipline", () => {
  it("default dependencies contain no Headroom package (Decision 18)", () => {
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("headroom-ai");
  });

  it("if the headroom-ai npm client appears anywhere, it is pinned exactly", () => {
    const sections = [
      pkg.dependencies,
      pkg.devDependencies,
      pkg.optionalDependencies,
      pkg.peerDependencies,
    ];
    for (const section of sections) {
      const spec = section?.["headroom-ai"];
      if (spec !== undefined) {
        expect(spec).toBe(HEADROOM_CLIENT_NPM_PIN);
      }
    }
  });
});
