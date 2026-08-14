/**
 * R10.19 — which `compression.headroom_config` keys can actually reach Headroom.
 *
 * R9.8 shipped an ignored-key warning, but only inside the adapter, so it fired
 * only when Headroom actually compressed something. On a prompt-caching upstream
 * the semantic stage is gated off before the adapter is ever reached, so it never
 * fired at all: a real project carried a no-op
 * `plugins: [openrouter-context-compression]` for weeks with zero log lines —
 * exactly the silent-drop failure R9.8 existed to prevent.
 *
 * These cover the pure check `golem status` calls, which runs regardless of
 * whether the stage will ever execute.
 */

import { describe, expect, it } from "vitest";
import {
  KNOWN_HEADROOM_CONFIG_FIELDS,
  unreachableHeadroomConfigKeys,
} from "../../../src/compression/headroom-adapter.js";

describe("unreachableHeadroomConfigKeys (R10.19)", () => {
  it("flags `plugins`, the key that motivated R9.8 and then went unreported", () => {
    expect(
      unreachableHeadroomConfigKeys({ plugins: [{ name: "openrouter-context-compression" }] }),
    ).toEqual(["plugins"]);
  });

  it("passes every documented CompressConfig field", () => {
    const all = Object.fromEntries(KNOWN_HEADROOM_CONFIG_FIELDS.map((k) => [k, true]));
    expect(unreachableHeadroomConfigKeys(all)).toEqual([]);
  });

  it("says nothing about an empty config", () => {
    expect(unreachableHeadroomConfigKeys({})).toEqual([]);
  });

  it("defers to a live worker's supported_config when one is available", () => {
    // The worker introspects the INSTALLED CompressConfig, so it is authoritative
    // and stays correct across Headroom releases; the static list does not. The
    // static list may therefore fail to warn, but must never warn wrongly.
    expect(unreachableHeadroomConfigKeys({ brand_new_field: 1 }, ["brand_new_field"])).toEqual([]);
    expect(unreachableHeadroomConfigKeys({ protect_recent: 1 }, ["brand_new_field"])).toEqual([
      "protect_recent",
    ]);
  });

  it("reports several unreachable keys at once, in config order", () => {
    expect(
      unreachableHeadroomConfigKeys({ plugins: [], protect_recent: 2, nonsense: true }),
    ).toEqual(["plugins", "nonsense"]);
  });
});
