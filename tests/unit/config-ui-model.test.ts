/**
 * The settings presentation layer: every leaf is described, and widget kinds are
 * derived from zod rather than hand-maintained.
 *
 * The exhaustiveness of SETTING_META is enforced at COMPILE time by its
 * `satisfies { [P in LeafPath]: SettingMeta }` annotation; the runtime check here
 * catches the reverse direction (a stale entry for a leaf that was removed) and
 * the quality rules a type can't express (non-empty labels, no trailing period).
 */

import { describe, expect, it } from "vitest";
import {
  allLeafPaths,
  deriveKind,
  enumOptionsFor,
  leafSchema,
  numericRangeFor,
  SECTION_META,
  SECTION_NAMES,
  SETTING_META,
  sectionsInDisplayOrder,
  settingKind,
  settingMeta,
} from "../../src/config/index.js";

describe("SETTING_META covers the schema exactly", () => {
  it("describes every leaf and nothing more", () => {
    const leaves = [...allLeafPaths()].sort();
    const described = Object.keys(SETTING_META).sort();
    expect(described).toEqual(leaves);
  });

  it("gives every leaf a usable label and summary", () => {
    for (const path of allLeafPaths()) {
      const meta = settingMeta(path);
      expect(meta, path).toBeDefined();
      expect(meta?.label.length, path).toBeGreaterThan(0);
      expect(meta?.summary.length, path).toBeGreaterThan(0);
      // Row text reads badly with a trailing period; the detail pane may have them.
      expect(meta?.summary.endsWith("."), path).toBe(false);
    }
  });

  it("names a real control in every ownedBy hint", () => {
    // A leaf claiming another control owns it must point at a runtime control that
    // actually exists, or the key would be silently unreachable in every UI.
    const runtimeIds = new Set(["runtime:slider", "runtime:account", "runtime:proxy"]);
    // Via settingMeta(), not Object.entries: `as const satisfies` keeps each entry's
    // narrow literal type, so the union's members don't all declare `ownedBy`.
    for (const path of allLeafPaths()) {
      const ownedBy = settingMeta(path)?.ownedBy;
      if (ownedBy === undefined) continue;
      expect(runtimeIds.has(ownedBy), `${path} -> ${ownedBy}`).toBe(true);
    }
  });

  it("describes every section, and orders them uniquely", () => {
    for (const section of SECTION_NAMES) {
      expect(Object.keys(SECTION_META), section).toContain(section);
    }
    const orders = Object.values(SECTION_META).map((m) => m.order);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("sorts sections by their declared order", () => {
    const ordered = sectionsInDisplayOrder();
    expect(ordered).toHaveLength(SECTION_NAMES.length);
    // Knowledge (order 10) is what a user most often wants, so it leads.
    expect(ordered[0]).toBe("knowledge");
    const orders = ordered.map((s) => SECTION_META[s].order);
    expect([...orders]).toEqual([...orders].sort((a, b) => a - b));
  });
});

describe("deriveKind", () => {
  const kindOf = (section: string, key: string) => {
    const schema = leafSchema(section, key);
    if (schema === undefined) throw new Error(`no schema for ${section}.${key}`);
    return deriveKind(schema);
  };

  it("maps zod types onto widgets", () => {
    expect(kindOf("knowledge", "enabled")).toBe("toggle");
    expect(kindOf("proxy", "port")).toBe("number");
    expect(kindOf("proxy", "upstream_provider")).toBe("enum");
    expect(kindOf("proxy", "upstream_base_url")).toBe("url");
    expect(kindOf("knowledge", "wiki_dir")).toBe("text");
    expect(kindOf("knowledge", "watch_paths")).toBe("list");
  });

  it("unwraps optional and transformed leaves", () => {
    // proxy.upstream_model is `.optional()`; slider.level is `.transform()`ed
    // through the legacy 0-5 remap. Both must report their underlying type.
    expect(kindOf("proxy", "upstream_model")).toBe("text");
    expect(kindOf("knowledge", "vector_db_url")).toBe("url");
    expect(kindOf("slider", "level")).toBe("number");
  });

  it("treats a structured array as opaque, not an editable list", () => {
    // proxy.accounts is an array of objects — `golem account` owns it.
    expect(kindOf("proxy", "accounts")).toBe("opaque");
  });

  it("lets metadata override a derivation zod can't express", () => {
    const schema = leafSchema("ui", "pet_color");
    if (schema === undefined) throw new Error("no schema for ui.pet_color");
    // A hex colour is just a validated string to zod...
    expect(deriveKind(schema)).toBe("text");
    // ...so the meta table says what it really is.
    expect(settingKind("ui.pet_color", schema)).toBe("color");
  });
});

describe("enumOptionsFor / numericRangeFor", () => {
  it("lists an enum's values in declaration order", () => {
    const schema = leafSchema("ui", "color");
    if (schema === undefined) throw new Error("no schema for ui.color");
    expect(enumOptionsFor(schema)).toEqual(["auto", "always", "never"]);
  });

  it("returns undefined for a non-enum", () => {
    const schema = leafSchema("proxy", "port");
    if (schema === undefined) throw new Error("no schema for proxy.port");
    expect(enumOptionsFor(schema)).toBeUndefined();
  });

  it("reports declared numeric bounds", () => {
    const port = leafSchema("proxy", "port");
    if (port === undefined) throw new Error("no schema for proxy.port");
    expect(numericRangeFor(port)).toEqual({ min: 1, max: 65535, int: true });

    const confidence = leafSchema("knowledge", "local_answer_min_confidence");
    if (confidence === undefined) throw new Error("no schema for the confidence floor");
    expect(numericRangeFor(confidence)).toEqual({ min: 0, max: 1, int: false });
  });

  it("returns undefined for a non-number", () => {
    const schema = leafSchema("knowledge", "enabled");
    if (schema === undefined) throw new Error("no schema for knowledge.enabled");
    expect(numericRangeFor(schema)).toBeUndefined();
  });
});
