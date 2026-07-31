/**
 * R8.8 — render the model catalog (`golem models`).
 *
 * Two rules this file exists to keep:
 *
 * - **Ids print verbatim (spec Decision 49).** Every row shows the id exactly as
 *   it appears on the wire, next to the provider that serves it. No friendly
 *   names, no normalisation, no grouping that hides a distinct id.
 * - **An absent number renders as `—`, never as `0`.** A model with no known
 *   price is a fact worth showing; a model priced at zero is a claim, and a
 *   false one. The same goes for an unknown context window.
 *
 * Staleness is labelled rather than hidden: the catalog carries its own `asOf`,
 * and past `models.catalog_max_age_days` the header says so — the figures still
 * print, because a dated number a reader can judge beats a suppressed one.
 */

import {
  catalogAgeDays,
  type ModelCatalog,
  type ModelCatalogEntry,
} from "../telemetry/model-catalog.js";

function tokens(value: number | undefined): string {
  return value === undefined ? "—" : value.toLocaleString("en-US");
}

/** Prices span $0.10 → $50, so trim to 4 decimals and drop trailing zeros. */
function usd(value: number | undefined): string {
  if (value === undefined) return "—";
  const fixed = value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return `$${fixed}`;
}

function matchesFilter(entry: ModelCatalogEntry, filter: string): boolean {
  return `${entry.provider} ${entry.id}`.toLowerCase().includes(filter.toLowerCase());
}

/**
 * The catalog as a table, plus its provenance. `filter` is a case-insensitive
 * substring over `"<provider> <id>"` — 5,900 entries is a normal size for the
 * fetched half, so an unfiltered dump is rarely what a reader wants.
 */
export function renderModelCatalog(
  catalog: ModelCatalog,
  opts: { readonly nowMs: number; readonly maxAgeDays: number; readonly filter?: string },
): string {
  const filter = opts.filter;
  const rows = [...catalog.entries]
    .filter((entry) => filter === undefined || matchesFilter(entry, filter))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));

  const out: string[] = [];
  out.push(
    `Model catalog — ${catalog.entries.length.toLocaleString("en-US")} entry(ies)` +
      (filter === undefined ? "" : `, ${rows.length.toLocaleString("en-US")} matching "${filter}"`),
  );
  out.push(`  prices from: ${catalog.source} (as of ${catalog.asOf})`);
  const age = catalogAgeDays(catalog, opts.nowMs);
  if (age !== null && age > opts.maxAgeDays) {
    out.push(
      `  STALE — ${age} day(s) old (limit ${opts.maxAgeDays}); prices may have moved. ` +
        "Run `golem models refresh`.",
    );
  }
  out.push("");

  if (rows.length === 0) {
    out.push(
      filter === undefined
        ? "No entries. (The built-in table should never be empty — this is a bug.)"
        : `No entry matches "${filter}". Ids are matched verbatim, not normalised.`,
    );
    return `${out.join("\n")}\n`;
  }

  out.push(
    `${"provider".padEnd(14)}${"model id (verbatim)".padEnd(34)}` +
      `${"in/MTok".padStart(9)}${"out/MTok".padStart(10)}` +
      `${"cache rd".padStart(10)}${"cache wr".padStart(10)}` +
      `${"context".padStart(12)}${"max out".padStart(10)}`,
  );
  for (const entry of rows) {
    out.push(
      `${entry.provider.slice(0, 13).padEnd(14)}${entry.id.slice(0, 33).padEnd(34)}` +
        `${usd(entry.inputUsdPerMTok).padStart(9)}${usd(entry.outputUsdPerMTok).padStart(10)}` +
        `${usd(entry.cacheReadUsdPerMTok).padStart(10)}${usd(entry.cacheWriteUsdPerMTok).padStart(10)}` +
        `${tokens(entry.contextTokens).padStart(12)}${tokens(entry.maxOutputTokens).padStart(10)}`,
    );
    if (entry.note !== undefined) out.push(`${" ".repeat(14)}note: ${entry.note}`);
  }

  out.push("");
  out.push("A `—` means the catalog does not know that number — it is never priced as 0.");
  out.push("`golem bench cost` prices only what appears here; anything else reports tokens only.");
  return `${out.join("\n")}\n`;
}

/** What `golem models refresh` did, including what it deliberately did NOT do. */
export function renderRefreshResult(result: {
  readonly url: string;
  readonly fetched: number;
  readonly added: number;
  readonly builtin: number;
  readonly fetchedAt: string;
}): string {
  return (
    `Fetched ${result.fetched.toLocaleString("en-US")} model entry(ies) from ${result.url} ` +
    `at ${result.fetchedAt} and cached them locally.\n` +
    `  ${result.added.toLocaleString("en-US")} added beyond Golem's own ${result.builtin} ` +
    "built-in entry(ies), which always win on a collision — a third-party price can fill a\n" +
    "  gap but can never overwrite a price Golem verified itself.\n"
  );
}
