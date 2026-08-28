/**
 * WS-E E3 — `golem status` rendering.
 *
 * The pure half of the status engine: no I/O, no config loading. Everything here
 * takes a {@link StatusReport} (or one of its pieces) and returns a string, or
 * shapes an already-collected value into the JSON report's snake_case form.
 *
 * Split out of `./status.ts`, which remains the public surface and re-exports
 * everything below that was exported before the split.
 */

import type { EffectiveCompression } from "../compression/effective-level.js";
import { KNOWN_WORKERS } from "../inference/workers.js";
import {
  type CompressionLevel,
  coerceCompressionLevel,
  compressionName,
} from "../interfaces/policy.js";
import type { DialInfo } from "./dials.js";
import type { DialStatus, StatusReport } from "./status.js";
// Pure display helpers live in ./upstream-display.js so the `golem` control panel can
// render an upstream label without loading this module (see that file).
import { renderUpstream } from "./upstream-display.js";

/** One line that says which of the three states this session is in, and the fix. */
function renderWebFetchGreen(report: StatusReport): string {
  const g = report.webfetch_green;
  if (g === undefined) return "loopback CA state unknown";
  if (g.trusted && g.endpoint) return "cache-served WebFetch renders green";
  if (g.trusted && !g.endpoint) {
    return "loopback CA trusted, but the serve endpoint is down — start the proxy";
  }
  if (g.foreign_ca !== undefined) {
    return `NODE_EXTRA_CA_CERTS is owned by ${g.foreign_ca} — left alone; served WebFetches show as denied (red)`;
  }
  if (g.wired) {
    return "loopback CA wired but NOT in this session — restart Claude Code (env is read once at startup)";
  }
  return "loopback CA not wired — served WebFetches show as denied (red); `golem init` wires it";
}

/**
 * One dial, rendered for the human `golem status`. Mirrors `describeDial` in
 * dials.ts but works off the JSON report (which is what the VS Code panel and
 * any script read), so the two surfaces cannot disagree.
 */
/**
 * One dial's line. `effectiveValue` (§103) overrides the displayed value when the
 * dial's setting is not what the pipeline will apply — the compression dial can
 * read "3" while the upstream gate makes it behave as 1, and showing the setting
 * alone is the misreport this exists to prevent.
 */
function renderDial(kind: string, dial: DialStatus, effectiveValue?: string): string {
  const shown =
    effectiveValue !== undefined && effectiveValue !== dial.effective
      ? `${dial.effective}→${effectiveValue}`
      : dial.effective;
  // R11.1: no preset above the dial, so no "(auto — follows slider N)" branch.
  // What survives is the distinction that still carries information — a value
  // someone chose, versus the one Golem ships.
  return `${kind} ${shown} (${dial.layer === "default" ? "default" : `set by ${dial.layer}`})`;
}

/** One-line rendering of the usage-limit prediction + freshness. */
export function renderLimits(limits: NonNullable<StatusReport["limits"]>): string {
  const pct = Math.round(limits.five_hour_utilization * 100);
  const park = limits.enforced ? "enforced" : "advisory";
  // Task `subagent-park`: say when spawns are gated, the way the line already says
  // whether the park is advisory or enforced. `off` is worth printing too — the
  // gate being disabled is exactly the state whose consequences are invisible.
  const spawnCost =
    limits.spawn_cost_fraction === undefined
      ? ""
      : ` ~${Math.round(limits.spawn_cost_fraction * 100)}%/agent`;
  const spawns =
    limits.spawn_gate === false
      ? " · spawns ungated"
      : limits.spawn_gate === undefined
        ? ""
        : ` · spawns ${limits.spawn_blocked === true ? "REFUSED" : "allowed"}${spawnCost}`;
  if (limits.stale) {
    const age = limits.age_minutes < 0 ? "unknown" : `${limits.age_minutes}m ago`;
    // A stale reading cannot say "allowed": the gate warns once and then proceeds.
    const staleSpawns = limits.spawn_gate === false ? " · spawns ungated" : " · spawns warn-once";
    return `Limits: STALE (last reading ${age}, 5h ${pct}%) — auto-park blind; active account may not emit rate-limit headers · park ${park}${staleSpawns}`;
  }
  const reset = limits.reset_at !== null ? ` (resets ${limits.reset_at})` : "";
  return `Limits: 5h window ${pct}% used${reset} · observed ${limits.age_minutes}m ago · park ${park}${spawns}`;
}

export function dialJson(dial: DialInfo): DialStatus {
  return {
    setting: dial.setting,
    effective: dial.effective,
    layer: dial.layer,
    ...(dial.source !== undefined && { source: dial.source }),
  };
}

/**
 * The compression dial's value as a {@link CompressionLevel}.
 *
 * R11.1: this took a `fallback` (the slider's own level) for a dial that could
 * read `"auto"` or something out of range. There is no slider to fall back to,
 * and `coerceCompressionLevel` is the one place that decides what an unexpected
 * value means — status must never invent a second answer.
 */
export function compressionFromDial(dialEffective: string): CompressionLevel {
  return coerceCompressionLevel(dialEffective);
}

export function effectiveCompressionJson(
  eff: EffectiveCompression,
): StatusReport["effective_compression"] {
  return {
    nominal: String(eff.nominal),
    nominal_name: compressionName(eff.nominal),
    effective: String(eff.effective),
    effective_name: compressionName(eff.effective),
    degraded: eff.degraded,
    ...(eff.reason !== undefined && { reason: eff.reason }),
  };
}

function checkbox(ok: boolean): string {
  return ok ? "[ok]" : "[--]";
}

/** Human-readable rendering (the default, non---json output). */
export function renderStatus(report: StatusReport): string {
  const lines: string[] = [];
  lines.push(`Golem ${report.version} — ${report.project_dir}`);
  lines.push("");

  const init = report.initialized;
  lines.push(`Project wiring ${init.overall ? "(initialized)" : "(run `golem init`)"}`);
  lines.push(`  ${checkbox(init.claude_settings)} .claude settings -> proxy base URL`);
  lines.push(`  ${checkbox(init.mcp_registered)} .mcp.json -> golem MCP server`);
  lines.push(`  ${checkbox(init.skills)} /golem/* skills installed`);
  lines.push(`  ${checkbox(init.golem_settings)} .golem/settings.json present`);
  lines.push(
    `  ${checkbox(report.webfetch_green?.trusted === true)} ${renderWebFetchGreen(report)}`,
  );
  lines.push("");

  lines.push(
    `Proxy: ${report.proxy.url} — ${
      report.proxy.reachable
        ? "reachable (run `golem off` to passthrough, `golem on` to re-enable)"
        : "not running — the SessionStart hook restarts it on project open"
    }`,
  );
  // A running daemon serves the code AND the config it started with, so
  // "reachable" was true for an 18-hour-old process still routing to a target
  // the current config no longer named. Same lesson as the R8.32 note below:
  // say it on the proxy line the eye lands on, not somewhere it must be inferred.
  if (report.proxy.reachable && report.proxy.stale === true) {
    // R10.13: staleness now has two causes, and the version-mismatch wording is
    // nonsense for the other one — it rendered "running build 0.22.0, not
    // 0.22.0" for a daemon whose VERSION matched and whose CODE did not, which
    // is the case the fingerprint was added to catch.
    const running = report.proxy.running_version;
    lines.push(
      running === undefined
        ? `  ⚠ running an unknown build, not ${report.version} — it is still serving the code and config it started with.`
        : running !== report.version
          ? `  ⚠ running build ${running}, not ${report.version} — it is still serving the code and config it started with.`
          : `  ⚠ running build ${running}, but from an earlier build of it — Golem has been rebuilt since this daemon started, so it is still serving the older code and the config it started with.`,
    );
    lines.push("    Fix: `golem proxy restart`");
  }
  // R8.32: the `[--] .claude settings` checkbox above and this "reachable"
  // line could contradict each other two lines apart, and the reader was left to
  // notice. Say it here, attached to the proxy line the eye actually lands on.
  if (report.proxy.reachable && report.proxy.in_path === false) {
    const foreign = report.proxy.wiring === "foreign";
    lines.push(
      `  ⚠ NOT in the request path — ${
        foreign
          ? `Claude Code is wired to ${report.proxy.wiring_base_url} (another gateway owns it; Golem will not change that)`
          : "Claude Code has no ANTHROPIC_BASE_URL and talks to the upstream directly"
      }.`,
    );
    // `golem init` is what the checkbox above recommends, and it is far heavier
    // than restoring one env key.
    if (!foreign) lines.push("    Fix: `golem proxy wire` (then reload the window).");
  }
  lines.push(`Upstream: ${renderUpstream(report.upstream)}`);
  // R9.2: with many targets in play, one Upstream line is not the whole truth —
  // the responding model must be visible per target (21e correctness rail).
  if (report.targets !== undefined) {
    lines.push(`Targets: ${report.targets.length} configured`);
    for (const t of report.targets) {
      const mark = t.is_default ? "*" : " ";
      const model = t.model ?? "(client's own id)";
      const served =
        t.last_served_model !== undefined
          ? ` — last served ${t.last_served_model}`
          : " — nothing served yet";
      lines.push(`  ${mark} ${t.id} (${t.provider}, trust=${t.trust}) ${model}${served}`);
    }
  }
  const ec = report.effective_compression;
  const comp = report.dials.compression;
  // §103: the LABEL carries the truth. A warning line under a headline that still
  // reads "aggressive" leaves the headline wrong — which is exactly what the first
  // pass at this got wrong.
  const effSuffix = ec.degraded ? ` → effectively ${ec.effective} (${ec.effective_name})` : "";
  lines.push(
    `Compression: ${ec.nominal} (${ec.nominal_name})${effSuffix} — ` +
      `${comp.layer === "default" ? "default" : `set by ${comp.layer}`}` +
      (comp.source !== undefined ? ` (${comp.source})` : ""),
  );
  // R11.1: brevity gets its own line-part; compression is already the headline
  // above, so it is not repeated here.
  lines.push(`Dials: ${renderDial("brevity", report.dials.brevity)}`);
  // The headline already says the effective level; this line says WHY and what to
  // do about it, which does not fit in a label.
  if (ec.degraded) {
    lines.push(`  ⚠ level ${ec.nominal} (${ec.nominal_name}) is inert here: ${ec.reason ?? ""}`);
  }
  // R10.19: a key that cannot reach Headroom, said WHERE the user is already
  // looking when they wonder why compression did nothing. Both facts together —
  // either alone misleads: the key would still be filtered if the stage were on,
  // and the stage may be off regardless of the key.
  const unreachable = report.unreachable_headroom_config ?? [];
  if (unreachable.length > 0) {
    lines.push(
      `  ⚠ compression.headroom_config: ${unreachable.join(", ")} ` +
        `${unreachable.length === 1 ? "is not a" : "are not"} Headroom config field` +
        `${unreachable.length === 1 ? "" : "s"} — set, but never applied` +
        (ec.degraded ? ", and the stage it would configure is off on this upstream anyway" : ""),
    );
  }
  if (report.dials.brevity.effective !== "off") {
    lines.push(
      `  ⚠ brevity ${report.dials.brevity.effective} is active: replies are shortened ` +
        `(output tokens only; code/commands/errors stay verbatim). Check it pays: golem stats --brevity`,
    );
  }
  // Inference topology: a reachable local model makes Golem local+upstream —
  // available via the `coder` MCP tool at any level (Decision 30/31). Name the
  // concrete coder model when known. If the coder tool is disabled, show only
  // the upstream backend (the local model may still be used for rerank/local-answer).
  // R9.4: name the two models by ROLE rather than by locality — after R9.3 the
  // coder end can be any target, so "local + upstream" described a constraint
  // that no longer exists.
  const chatModel = report.upstream.last_served_model ?? report.upstream.default_model;
  // A configured target answers regardless of local reachability; otherwise a
  // reachable local model counts even when its id is unknown — "there is a coder
  // backend" and "we know which model it runs" are different facts, and only the
  // first decides whether to show the role at all.
  //
  // Rendered generically over N workers so a new one needs no change here.
  lines.push(`Inference: chat ${chatModel ?? report.upstream.provider}`);
  const workers = report.workers ?? [];
  const localModel = report.local_model.model ?? "local";
  for (const worker of KNOWN_WORKERS) {
    const configured = workers.find((w) => w.worker === worker);
    if (configured === undefined) {
      // A report from before R10.8 (or a caller that built one by hand) has no
      // row for an unconfigured worker. Keep the old reading for those rather
      // than claiming a route this report cannot vouch for.
      lines.push(
        report.local_model.reachable
          ? `  ${worker}: ${localModel} (local)`
          : `  ${worker}: unavailable — no target configured and the local model is not reachable`,
      );
      continue;
    }
    // A target that resolves to nothing means the worker throws on EVERY
    // dispatch. Naming its model would advertise something that can never run.
    if (configured.target_unknown === true) {
      lines.push(
        `  ${worker}: FAILS CLOSED — target "${configured.target}" is in neither proxy.targets ` +
          "nor proxy.gateways, and it will not fall back to the local model. " +
          "Fix it or unset it: golem target list",
      );
      continue;
    }
    // A worker resolved to a LOCAL target still depends on the local runtime
    // being up; saying which model it would run while nothing answers on that
    // port is the dishonest-signal class this project exists to close.
    if (configured.local === true && report.local_model.reachable === false) {
      lines.push(
        `  ${worker}: unavailable — target "${configured.target}" is local and the local ` +
          "model is not reachable",
      );
      continue;
    }
    const model = configured.model ?? configured.target;
    const same = chatModel != null && model === chatModel ? " — same model as chat" : "";
    // R10.8: name the step that chose the target. "went to your upstream" and
    // "went to your upstream because nothing named anything else" are different
    // facts, and only the second one is a prompt to go and configure something.
    // R13.11: the harness step is not an assured destination. Golem can only
    // dispatch there if it holds a credential of its own for that upstream — on
    // the default `inherit` path the credential is the CLIENT's and Golem never
    // sees it, so the dispatch declines and the work falls back to the session.
    // Predicting "it drafts here" would be the dishonest-signal class again, and
    // so would predicting "it declines": that depends on whether a key is stored,
    // which `golem target list` already answers and this line will not read the
    // credential store on every status render to duplicate.
    const via =
      configured.route === "harness"
        ? " — nothing routes `coder`, so it falls through to the harness default " +
          "upstream: it drafts there only if a key is stored for that upstream " +
          "(`golem target list`), and otherwise declines and leaves the work to the session"
        : configured.route === "default_target"
          ? " — via inference.default_target"
          : "";
    lines.push(`  ${worker}: ${model} (target ${configured.target})${same}${via}`);
  }
  if (report.update !== undefined) {
    lines.push(
      report.update.available
        ? `Update: ${report.update.current} → ${report.update.latest} available (run \`golem update\`)`
        : `Update: up to date (${report.update.current})`,
    );
  }
  if (report.limits !== undefined) {
    lines.push(renderLimits(report.limits));
  }
  lines.push("");

  lines.push("Config (value — layer):");
  for (const [key, entry] of Object.entries(report.config)) {
    const value = JSON.stringify(entry.value);
    const source = entry.source !== undefined ? ` (${entry.source})` : "";
    lines.push(`  ${key} = ${value} — ${entry.layer}${source}`);
  }

  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of report.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
