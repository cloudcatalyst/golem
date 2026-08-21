// Decision 21c — VS Code renderer: pure model + HTML/status-bar builders.
// No `vscode` imports here so this is unit-testable with `node --test`.
"use strict";

/**
 * The compression scale (R11.1 / ADR-0004 — mirrors `COMPRESSION_NAMES` in
 * src/interfaces/policy.ts). Single source of truth for the panel buttons and the
 * status-bar quick-pick so neither drifts to a stale range.
 *
 * `0` is deliberately absent. It used to be the slider's full bypass — the one
 * value that turned REDACTION off — and a panel button is exactly the wrong place
 * for that: one click, no confirmation, no mention of redaction in the label.
 * It is now `proxy.bypass_all`, which the Settings section renders with its own
 * danger confirmation.
 */
const COMPRESSION_LEVELS = [
  { level: "off", name: "Off" },
  { level: "1", name: "Lossless" },
  { level: "2", name: "Balanced" },
  { level: "3", name: "Aggressive" },
];

/**
 * R10.11 — every `golem status --json` path this file reads, declared once.
 *
 * The extension consumes `status --json` as an untyped blob, so a CLI rename is
 * invisible here until a human notices a wrong label. That is how the
 * `coder_model` / `coder_enabled` / `accounts` drifts each survived four
 * releases. `tests/contract/vscode-status-fields.contract.test.ts` resolves these
 * paths against a REAL `collectStatus` report, so a rename fails at its source
 * instead of shipping.
 *
 * Paths are arrays of keys, not dotted strings, because `config` is keyed BY
 * dotted name (`config["proxy.upstream_base_url"]`) and escaping that in a dotted
 * path is a bug waiting to happen.
 *
 * Each entry carries exactly one classification:
 *
 * - `required` — the CLI always emits it; the contract asserts it is present.
 * - `stateful` — emitted only in a particular state (traffic seen, probe
 *   answered, update check cached). The contract drives that state where it can.
 * - `legacy` — a back-compat read for an OLDER `golem` on the PATH. The current
 *   CLI deliberately does NOT emit it, and the contract asserts that, so a
 *   "legacy" label can never quietly become the live shape.
 * - `unemitted` — read here, emitted by nothing. A genuine gap, named with the
 *   task that owns it. The contract asserts these are absent, so it trips the
 *   day the gap is closed and this list has to be updated.
 */
const STATUS_FIELDS_READ = [
  { path: ["version"], required: true },
  { path: ["proxy", "reachable"], required: true },
  // Decision 56 — the redaction-only bypass shim. Emitted by `collectStatus`
  // since R10.12 restored the shim and the third desired-state; optional
  // because it is present only while the shim is actually serving.
  { path: ["proxy", "bypass"], required: false },
  // R10.24 — is Claude Code actually POINTED at the proxy? The status bar had no
  // notion of this, so a running-but-unwired daemon (R8.32) rendered as a
  // confident filled hexagon. Optional so an older CLI that omits it is treated
  // as wired rather than raising a false alarm.
  { path: ["proxy", "in_path"], required: false },
  // R11.1: `status --json` no longer carries a `slider` block (ADR-0004); the
  // dials below are the whole control surface.
  { path: ["dials", "compression", "effective"], required: true },
  { path: ["dials", "brevity", "effective"], required: true },

  { path: ["dials", "compression", "effective"], required: true },

  { path: ["upstream", "provider"], required: true },
  { path: ["upstream", "account"], required: true },
  { path: ["upstream", "base_url"], required: true },
  { path: ["upstream", "default_model"], required: true },
  // Only after the proxy has actually served a request.
  { path: ["upstream", "last_served_model"], stateful: "a request has been served" },
  // R10.24 — every target the model picker can offer (gateway AND model).
  // `collectStatus` has emitted these since R9.1; the extension read only the
  // gateway list, which is why a gateway fronting several models could offer
  // exactly one of them.
  // `status --json` emits these only when the registry holds MORE than the
  // synthetic default — i.e. when the proxy is actually routing. The picker
  // therefore falls back to `golem target list` (which always lists the default)
  // before it falls back to the gateway picker.
  { path: ["targets"], stateful: "more than the synthetic default target is configured" },
  { path: ["local_model", "reachable"], required: true },
  { path: ["local_model", "base_url"], required: true },
  // Only when the local runtime answered the probe.
  { path: ["local_model", "model"], stateful: "the local runtime answered the probe" },
  // R9.10 — top-level, one row per worker.
  { path: ["workers"], required: true },
  // Only once `golem update --check` has cached an answer.
  { path: ["update", "available"], stateful: "an update check is cached" },
  { path: ["update", "latest"], stateful: "an update check is cached" },
  { path: ["update", "current"], stateful: "an update check is cached" },
  // Provenance map, keyed by dotted name — the pre-`upstream`-block fallbacks.
  { path: ["config", "proxy.upstream_base_url", "value"], required: true },
  { path: ["config", "inference.ollama_base_url", "value"], required: true },
  // Back-compat only — see the block comments at each read site.
  { path: ["local_model", "coder_enabled"], legacy: "R9.23 removed the flag" },
  { path: ["local_model", "coder_model"], legacy: "the field is `local_model.model`" },
  { path: ["local_model", "workers"], legacy: "R9.10 moved workers to the top level" },
];

/** Compact token formatting: 1_520_615 -> "1.5M", 139_560 -> "139.6k". */
function fmtTokens(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

function upstreamLabel(url) {
  try {
    const host = new URL(url).host.toLowerCase();
    if (host.includes("azure")) return "foundry";
    if (host === "api.anthropic.com") return "anthropic";
    if (host.includes("openrouter")) return "openrouter";
    return host;
  } catch {
    return "upstream";
  }
}

/** First upper, rest lower — `lossless` → `Lossless`. */
function cap(s) {
  return typeof s === "string" && s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
}

/** Split a `vendor/model-name` id into its parts; `defaultVendor` is used when there is no `/`. */
function parseVendorModel(modelId, defaultVendor = "anthropic") {
  const slash = modelId.indexOf("/");
  if (slash === -1) return { vendor: defaultVendor, modelName: modelId };
  return { vendor: modelId.slice(0, slash), modelName: modelId.slice(slash + 1) };
}

/**
 * The destination label: `<gateway> (<model id>)`.
 *
 * R10.24 — outside the parentheses belongs the GATEWAY you switched to, which is
 * what the CLI has always shown there. This used to print the vendor parsed out
 * of the model id, so an OpenRouter target rendered `deepseek (deepseek-v4-flash)`
 * — naming a vendor Golem does not talk to, and hiding the one gateway fact the
 * reader needs (which of their configured gateways is carrying this traffic).
 * Model ids stay verbatim inside the parentheses (Decision 49).
 */
function formatGatewayModel(gatewayLabel, modelId) {
  return modelId ? `${gatewayLabel} (${modelId})` : gatewayLabel;
}

/**
 * The compression level label, "Passthrough" whenever Golem isn't transforming
 * traffic (proxy stopped, or level 0 full bypass — Decision 30). Shared by the
 * status bar and the hover summary so they never disagree.
 */
function levelLabel(model) {
  // Decision 56: the bypass shim is serving and redacting, so it is neither
  // "stopped" nor a level-0 passthrough — it gets its own label.
  if (model.proxyBypass) return "Bypass";
  if (!model.proxyReachable) return "Passthrough";
  return model.compressionName ? cap(model.compressionName) : String(model.compression);
}

/**
 * R10.24 — the ONE word for what Golem is doing with traffic right now, in the
 * same vocabulary as the CLI status line: `running` (the resting case, which
 * needs no word), `bypass`, `unwired`, `off`.
 *
 * These four used to be spelled differently on each surface, and "unwired" —
 * daemon up, nothing pointed at it (R8.32) — did not exist in the status bar at
 * all. Precedence matters: a proxy nothing is talking to is misconfigured
 * whatever its dials say, so it outranks bypass.
 */
/**
 * The compression dial as the status BAR spells it: the CLI's own lowercase level
 * name (`lossless`), or the `L<n>` fallback left uppercase — lowercasing that one
 * produced `l1`, which reads as a typo rather than a level.
 */
function dialLabel(model) {
  const label = levelLabel(model);
  return model.compressionName ? label.toLowerCase() : label;
}

function proxyStateWord(model) {
  if (!model.proxyReachable) return "off";
  if (model.proxyInPath === false) return "unwired";
  if (model.proxyBypass) return "bypass";
  return "";
}

/**
 * One line describing both dials.
 *
 * R11.1 dropped the "(pinned)"/"(auto)" suffixes: they existed to say whether the
 * slider was driving a dial, and there is no slider. A dial's value is its value.
 */
function dialsSummary(model) {
  // Decision 56: in bypass neither dial is in force. Say so rather than
  // reporting the configuration as though it were running.
  if (model.proxyBypass) return "pipeline off (bypass) — redaction only";
  return `brevity ${model.brevity || "off"} · compression ${model.compressionLevel || model.compression || "1"}`;
}

/**
 * The rows out of `golem gateway list --json`, whatever shape they arrive in.
 *
 * `golem gateway list --json` returns the GatewaysReport OBJECT
 * (`{active, active_unknown, gateways:[…]}`), not a bare array. Testing only for
 * an array left the extension's cache permanently `[]`, so the "Switch upstream…"
 * quick-pick found no cache and re-ran the multi-second CLI call (it probes every
 * gateway's credential store) on every open.
 *
 * R9.23 renamed the key `accounts` -> `gateways`; R10.10 found the extension had
 * never followed, and R10.11 found `pickAccount`'s cold path in extension.js was
 * STILL reading `.accounts` directly — a fourth instance of the same drift, and
 * the reason this normalization lives in one exported function now rather than
 * being open-coded per call site. Both keys are accepted so a newer extension
 * paired with an older CLI still works.
 */
function gatewayRows(report) {
  if (Array.isArray(report)) return report;
  if (!report || typeof report !== "object") return [];
  if (Array.isArray(report.gateways)) return report.gateways;
  if (Array.isArray(report.accounts)) return report.accounts;
  return [];
}

/**
 * Build the view model from `golem stats --json`, `golem status --json`, and
 * (optionally) `golem update --check --json`. The update arg wins; otherwise we
 * fall back to the `update` block `golem status` embeds from its cached check.
 */
function buildModel(stats, status, update, accounts, surface) {
  const s = stats && typeof stats === "object" ? stats : {};
  const st = status && typeof status === "object" ? status : {};
  // See gatewayRows: `gateway list --json` is an object, and the key has been
  // renamed once. One function knows that, and both call sites use it.
  const accountList = gatewayRows(accounts);
  // Normalize the two shapes: `golem update --json` → {updateAvailable,latest,current};
  // `golem status --json`.update → {available,latest,current}.
  const up =
    (update && typeof update === "object" && update) ||
    (st.update && typeof st.update === "object" && st.update) ||
    null;
  const updateAvailable = !!(up && (up.updateAvailable === true || up.available === true));
  const latestVersion = up && up.latest ? String(up.latest) : null;
  const currentVersion = up && up.current ? String(up.current) : st.version ? String(st.version) : null;
  const before = Number(s.tokens_before) || 0;
  const after = Number(s.tokens_after) || 0;
  const savedPct = before > 0 && after <= before ? Math.round(((before - after) / before) * 100) : 0;

  const perStage = [];
  const ps = s.per_stage && typeof s.per_stage === "object" ? s.per_stage : {};
  for (const [stage, d] of Object.entries(ps)) {
    if (d && typeof d === "object") {
      perStage.push({
        stage,
        before: Number(d.tokens_before) || 0,
        after: Number(d.tokens_after) || 0,
        saved: Number(d.tokens_saved) || 0,
      });
    }
  }

  // R6.2: prefer the account-aware `status.upstream` block (provider/account/
  // model that the proxy actually fronts). Fall back to the legacy config path
  // only for an older CLI that predates the block — that path is account-BLIND
  // (it reads the top-level base URL), so it can misreport when an account is
  // active; the block is the fix.
  const u = st.upstream && typeof st.upstream === "object" ? st.upstream : null;
  const upstream =
    (u && u.base_url) ||
    (st.config &&
      st.config["proxy.upstream_base_url"] &&
      st.config["proxy.upstream_base_url"].value) ||
    "https://api.anthropic.com";
  const account = u && typeof u.account === "string" ? u.account : null;
  const provider = u && typeof u.provider === "string" ? u.provider : null;
  const defaultModel = u && u.default_model ? String(u.default_model) : null;
  const lastServedModel = u && u.last_served_model ? String(u.last_served_model) : null;
  // Live/current model: what was last served, else the configured default. Both
  // verbatim — the id as served/configured, never a prettified family name
  // (mirrors the CLI, see src/providers/model-display.ts).
  const model = lastServedModel || defaultModel;
  // Label prefers the account id (that's what the user switched to), matching
  // the CLI's providerUpstreamLabel; else the URL-derived host/provider name.
  // The panel pill uses this; the status-bar destination uses upstreamDisplay.
  const label = account || upstreamLabel(upstream);
  // R10.24: `<gateway> (<model>)`, the same shape and the same precedence as the
  // CLI's `destinationLabel` — the LIVE model (last served) first, the configured
  // default second. This read them the other way round, so a session that had
  // switched gateway kept naming the configured model until the new upstream
  // served something. When no model is known at all (a plain Anthropic
  // passthrough), the gateway label stands alone.
  const upstreamDisplay = formatGatewayModel(label, model);

  return {
    // `golem config schema --json`: the control surface the Settings section
    // renders. Null when the CLI didn't answer (older golem, or a non-Golem
    // window) — settingsHtml degrades to a hint rather than an empty section.
    surface: surface && typeof surface === "object" ? surface : null,
    requests: Number(s.requests) || 0,
    before,
    after,
    savedPct,
    savedTokens: Math.max(0, before - after),
    perStage,
    // R11.1: the compression dial replaces the slider. `dials.compression` is
    // where it lives; an older CLI's `slider.level` is read as a fallback so a
    // stale daemon does not blank the panel.
    compression:
      (st.dials && st.dials.compression && st.dials.compression.effective) ||
      (st.slider && String(st.slider.level)) ||
      "1",
    compressionName:
      (st.effective_compression && st.effective_compression.nominal_name) ||
      (st.slider && st.slider.name) ||
      "",
    // Decision 52: the slider is a preset over two dials. `brevity` changes how
    // the MODEL talks, so it is surfaced in the status bar too — an unexplained
    // terse assistant should trace back to a visible dial, not look like a
    // model regression. Older CLIs have no `dials` block; default to off.
    brevity: (st.dials && st.dials.brevity && st.dials.brevity.effective) || "off",
    compressionLevel: (st.dials && st.dials.compression && st.dials.compression.effective) || "",
    upstream,
    upstreamLabel: label,
    upstreamDisplay,
    account,
    provider,
    model,
    defaultModel,
    lastServedModel,
    // R10.24 — every target (gateway AND model) the picker can offer, straight
    // from `golem status --json`, which has carried them since R9.1 while the
    // extension read only the gateway list. That is why the model picker could
    // not show models: a gateway fronting several collapsed to its first.
    targets: Array.isArray(st.targets) ? st.targets : [],
    // The selected TARGET id, when the CLI reports one (R10.24). Older CLIs have
    // no such field, and null then means "the gateway's own default".
    activeTarget:
      accounts && typeof accounts === "object" && typeof accounts.active_target === "string"
        ? accounts.active_target
        : null,
    proxyReachable: !!(st.proxy && st.proxy.reachable),
    // R10.24 — `proxy.in_path`: is Claude Code actually POINTED at the proxy?
    // The CLI status line has rendered this since R8.32 (a yellow ⬡ for "the
    // daemon is up and nothing is talking to it"), and the status bar had no
    // notion of it at all — so the one state that most looks like Golem working
    // while it does nothing rendered as a confident filled hexagon. Unknown
    // (an older CLI) is treated as wired, so an unreadable answer never invents
    // an alarm — the same fail-safe the CLI uses.
    proxyInPath: !(st.proxy && st.proxy.in_path === false),
    // Decision 56: reachable, but the redaction-only shim is answering rather
    // than the pipeline. Absent on an older CLI → false, i.e. the pre-56 display.
    proxyBypass: !!(st.proxy && st.proxy.bypass),
    localModelReachable: !!(st.local_model && st.local_model.reachable),
    // Was `inference.coder_enabled`, which R9.23 REMOVED — the coder tool is now
    // always offered, so `status --json` no longer emits the flag and this
    // always takes the `true` branch. Kept rather than deleted so an older CLI
    // that still sends it is still honoured; see R10.10.
    coderEnabled:
      st.local_model && typeof st.local_model.coder_enabled === "boolean"
        ? st.local_model.coder_enabled
        : true,
    // The local model counts as ACTIVE only when it is enabled AND reachable —
    // reachability alone is not enough. Ollama running with the coder tool turned
    // off used to still render as `local + …` here (the CLI statusline already
    // gated on both), claiming a hybrid Golem isn't actually offering.
    localModelActive:
      !!(st.local_model && st.local_model.reachable) &&
      (st.local_model && typeof st.local_model.coder_enabled === "boolean"
        ? st.local_model.coder_enabled
        : true),
    // R10.10: `status --json` emits `local_model.model`; this read
    // `local_model.coder_model`, a name the CLI never had, so the status bar
    // showed a bare "local" instead of the model id for as long as anyone can
    // tell. `coder_model` is still accepted in case an older CLI ever emitted
    // it, but `model` is the real field.
    coderModel:
      st.local_model && typeof st.local_model.model === "string"
        ? st.local_model.model
        : st.local_model && typeof st.local_model.coder_model === "string"
          ? st.local_model.coder_model
          : null,
    // R9.4 — the model behind `inference.coder_target`, when set and resolvable.
    // Wins over coderModel: a configured target is what `coder` will
    // actually draft on, local or not. Absent on an older CLI → null, i.e. the
    // pre-R9.4 local-only display.
    // R9.4 — one row per tool worker with a configured target. A row whose
    // target does not resolve carries no `model`: that worker fails closed on
    // every dispatch, so naming a model would advertise something that can
    // never run. Absent on an older CLI → [], i.e. the local-only display.
    workers:
      Array.isArray(st.workers)
        ? st.workers
        : st.local_model && Array.isArray(st.local_model.workers)
        ? st.local_model.workers
        : [{ worker: "coder" }],
    // The local (Ollama) base URL for the hover summary's `Local:` line — from
    // the status `local_model` block, falling back to the config value.
    localBaseUrl:
      (st.local_model && typeof st.local_model.base_url === "string" && st.local_model.base_url) ||
      (st.config &&
        st.config["inference.ollama_base_url"] &&
        st.config["inference.ollama_base_url"].value) ||
      null,
    // The savings window actually applied by `golem stats --window` (24h/7d/all),
    // for the summary's `saved …%` label. Null for an older CLI (all-time).
    savingsWindow:
      typeof s.window_applied === "string"
        ? s.window_applied
        : typeof s.window === "string"
          ? s.window
          : null,
    source: typeof s.source === "string" ? s.source : "live",
    accounts: accountList,
    updateAvailable,
    latestVersion,
    currentVersion,
  };
}

/**
 * The VS Code status-bar line. Intentionally distinct from `golem statusline`
 * (the terminal line): the status bar is a compact, at-a-glance presence
 * indicator — brand, then which upstream the traffic fronts, then the dials:
 *
 *   `⬢ Golem → ◆ openrouter (deepseek/deepseek-v4-flash) · 🗜 lossless · ✂ full`
 *
 * It deliberately OMITS cumulative savings, which live in the hover tooltip (see
 * extension.js) and the panel instead.
 *
 * When Golem isn't transforming traffic — the proxy is stopped, or it's running
 * at slider level 0 (full bypass, Decision 30) — the level reads "Passthrough".
 * The destination is still shown in every state (it's the configured upstream);
 * a hollow glyph (⬡) signals a stopped proxy.
 *
 * When a local model is reachable AND the coder tool is enabled, `local` is
 * folded into the destination ahead of the upstream provider
 * (`→ local + <provider>`) at ANY slider level — Golem is then a local+upstream
 * hybrid (`coder` at every level; auto-draft / local-first at level 3),
 * Decision 30. A disabled coder tool means no local traffic, so the segment is
 * omitted however reachable Ollama happens to be. The arrow always precedes the
 * destination, whether it's one provider or local-plus-provider.
 *
 * R6.2: the current model (last-served, else configured default) is shown as
 * `→ <provider> (<model>)`, e.g. `→ kimi (kimi-k3)`. Omitted when no model is
 * known (a plain Anthropic passthrough stays `→ anthropic`).
 */
function statusBarText(model) {
  // Filled = pipeline carrying traffic; hollow = either bypass (serving, inert)
  // or down. The label beside it says which (Decision 56).
  // R10.24: filled ONLY when the pipeline is both running and actually in
    // Claude Code's path. Hollow covers bypass, unwired and stopped; the label
    // beside it says which.
    const glyph =
      model.proxyReachable && !model.proxyBypass && model.proxyInPath !== false ? "⬢" : "⬡";
  // The update nudge shows regardless of proxy state — it's about the install,
  // not the traffic. `$(arrow-up)` is a VS Code codicon; harmless as text too.
  const badge = model.updateAvailable ? " $(arrow-up)" : "";
  // Decision 52: brevity is visible in the status bar whenever it is on, for the
  // same reason the CLI status line shows it — it changes the model's own output
  // style, and that must always be traceable to a dial the user can see.
  // Decision 56: not while the bypass shim is serving — it runs no brevity
  // stage, so the configured dial would advertise a transform that is not
  // happening.
  const state = proxyStateWord(model);
  // R10.24: the dials describe transforms the pipeline is applying. When it is
  // not applying any — stopped, unwired, or the redaction-only bypass shim —
  // printing them advertises work that is not happening, which is the misreport
  // R8.32/Decision 56 both turned on. The existing bypass rule for brevity is
  // now the rule for both dials and all three states.
  const inForce = state === "";
  const dials = inForce
    ? ` · 🗜 ${dialLabel(model)}` +
      (model.brevity && model.brevity !== "off" ? ` · ✂ ${model.brevity}` : "")
    : "";
  // R10.24: ONE canonical order, shared with `golem statusline` — brand (plus a
    // state word when it is not simply running), then the arrow and where traffic
    // goes, then the dials. This line used to read `⬢ Golem · Lossless → …`,
    // putting a dial between the brand and the arrow, so the two surfaces a user
    // reads in the same window disagreed about the shape of the same
    // information. Pinned by tests/unit/cli/statusline-parity.test.ts.
    return `${glyph} Golem${state === "" ? "" : ` ${state}`} → ${destinationLabel(
      model,
    )}${dials}${badge}`;
}

/**
 * R9.4 — the role markers on the destination segment.
 *
 * **Placeholders: pick the final glyphs here.** This is the SECOND of two
 * copies — the CLI's lives in `src/cli/statusline.ts` (`ROLE_MARKS`), and the
 * extension is plain JS sharing no module with it. Change both together; a test
 * pins that they agree.
 */
/**
 * What joins the model segments (R11.6). The CLI's `MODEL_JOIN` is the other
 * copy — change both together, as with the glyphs below.
 */
const MODEL_JOIN = " + ";

const ROLE_MARKS = {
  /** The model the conversation itself runs on. */
  chat: "◆",
  /** The model `coder` drafts on. */
  coder: "✎",
  /** Fallback for a worker with no glyph of its own yet. */
  worker: "✦",
};

/**
 * The model `coder` drafts on by default: `inference.coder_target` when set
 * (R9.4), otherwise the local model. Null when there is no coder backend to
 * report — the tool is disabled, or it would use a local model that is not
 * reachable. It must NOT fall back to the chat model: claiming a coder backend
 * that cannot serve a draft is the R8.32 failure in miniature.
 */
function workerModels(model) {
  const localModel = model.localModelActive ? model.coderModel || "local" : null;
  // No `workers` at all (a hand-built model, or an older CLI) → the implicit
  // coder-on-the-local-model row, which is the pre-R9.4 behaviour.
  const rows = model.workers && model.workers.length > 0 ? model.workers : [{ worker: "coder" }];
  return rows.map((w) => {
    // A configured target that resolves carries its own model; one that does not
    // carries none, and the worker is then omitted rather than advertised.
    // R11.6: `gateway` rides along so a worker can be spelled the way the chat
    // model is — `<gateway> (<model>)`. An older CLI sends no gateway, and the
    // segment then falls back to the bare id rather than inventing one.
    if (w.target) return { worker: w.worker, model: w.model || null, gateway: w.gateway || null };
    // No configured target → the local model, which has to actually be up.
    if (model.coderEnabled === false && w.worker === "coder") {
      return { worker: w.worker, model: null, gateway: null };
    }
    return { worker: w.worker, model: localModel, gateway: w.gateway || null };
  });
}

/**
 * The one-liner destination, naming the two models that actually matter now
 * that either end can be any target (R9.1–R9.4):
 *
 *   `◆ openrouter (deepseek/deepseek-v4-flash) + ✎ ollama (qwen2.5-coder:7b)`
 *
 * R11.6 — every model segment wears `<gateway> (<model>)`, and `+` joins them:
 * they are the same kind of thing, where `·` separates different kinds (models ·
 * dials · brevity). `MODEL_JOIN` in `src/cli/statusline.ts` is the other half of
 * this string; `statusline-parity.test.ts` demands they match.
 *
 * **Flattened to one segment when both are the same model** — printing the same
 * id twice under two symbols tells the reader nothing and costs width the rest
 * of the line needs. The old shape (`local (…) + anthropic (…)`) hard-coded the
 * assumption this work removed: that drafting is local and only the upstream is
 * a real choice. Shown in every state (including passthrough/off): it is the
 * configured destination traffic goes to.
 */
function destinationLabel(model) {
  // R6.2: use the vendor/model-name display label (e.g. `moonshotai (kimi-k3)`)
  // built in buildModel; it already incorporates the last-served or configured
  // model and matches the CLI's `golem status` output.
  const chatSeg = `${ROLE_MARKS.chat} ${model.upstreamDisplay || model.upstreamLabel || "upstream"}`;
  // Compare the raw ids, not the vendor-formatted labels, so `anthropic (x)`
  // and `x` still match.
  const chatModel = model.lastServedModel || model.model || model.defaultModel;
  const diverging = workerModels(model)
    .filter((w) => w.model && w.model !== chatModel)
    .map((w) => {
      const mark = ROLE_MARKS[w.worker] || ROLE_MARKS.worker;
      return `${mark} ${w.gateway ? `${w.gateway} (${w.model})` : w.model}`;
    });
  // R10.24: the chat destination LEADS, as it does in the CLI. It used to trail
  // the workers, so the arrow pointed at the drafting model.
  return [chatSeg, ...diverging].join(MODEL_JOIN);
}

function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/** Full webview HTML. `nonce` gates inline script under the CSP. */
/**
 * The Settings section, rendered from `golem config schema --json` (the same
 * control surface the `golem ui` terminal panel uses).
 *
 * Nothing about the key set is hard-coded here: labels, widget kinds, current
 * values, provenance, and writable scopes all come from the CLI. A new settings
 * key therefore appears in this panel with no extension change and no version
 * skew between the two.
 *
 * `surface` is the parsed JSON, or null when the CLI didn't answer (an older
 * `golem` without `config schema`, or a non-Golem window).
 */
function settingsHtml(surface) {
  if (!surface || !Array.isArray(surface.groups) || surface.groups.length === 0) {
    return '<h2>Settings</h2><div class="sub">Run <code>golem init</code>, or upgrade the golem CLI, to manage settings here.</div>';
  }
  const groups = surface.groups
    .map((group) => {
      const rows = (group.controls || []).map((c) => controlRowHtml(c)).join("");
      if (!rows) return "";
      const summary = group.summary ? `<div class="sub gsum">${esc(group.summary)}</div>` : "";
      return `<details class="grp" open><summary>${esc(group.title || group.id)}</summary>${summary}${rows}</details>`;
    })
    .join("");
  return `<h2>Settings</h2>${groups}`;
}

/**
 * One control as a labelled row. The `data-*` attributes carry everything the
 * webview script needs to post back an apply message, so the script itself stays
 * generic — it never knows what any particular setting means.
 */
function controlRowHtml(control) {
  const id = esc(control.id);
  const label = esc(control.label || control.id);
  // Provenance is the answer to "why is it that value?", so it's always shown.
  const layer = esc(control.layer || "default");
  const title = esc(
    control.locked
      ? `${control.summary || ""}\n\nLocked: ${control.locked}`
      : control.detail || control.summary || "",
  );
  const scopes = Array.isArray(control.writableScopes) ? control.writableScopes : [];
  // Pre-select the scope that currently OWNS the value. Config precedence is
  // default < user < project < local < env, so defaulting to the first option
  // ("project") wrote a change that a higher `local` layer immediately masked —
  // the row snapped back on the next refresh and the control looked dead. When the
  // owning layer isn't writable (`default`, `env`), fall back to the first option.
  const scopeSelect =
    scopes.length > 1
      ? `<select class="scope" data-id="${id}" title="Which settings scope a change is written to">${scopes
          .map(
            (s) =>
              `<option value="${esc(s)}"${s === control.layer ? " selected" : ""}>${esc(s)}</option>`,
          )
          .join("")}</select>`
      : "";

  let input;
  if (control.locked) {
    input = `<span class="sub">${esc(controlValueText(control))} 🔒</span>`;
  } else if (control.kind === "toggle") {
    input = `<input type="checkbox" class="ctl" data-id="${id}" data-kind="toggle"${
      control.value === true ? " checked" : ""
    }>`;
  } else if (control.kind === "enum" && Array.isArray(control.options)) {
    input = `<select class="ctl" data-id="${id}" data-kind="enum">${control.options
      .map(
        (o) =>
          `<option value="${esc(o.value)}"${
            String(control.value) === String(o.value) ? " selected" : ""
          }>${esc(o.label || o.value)}</option>`,
      )
      .join("")}</select>`;
  } else if (control.kind === "opaque") {
    input = `<span class="sub">${esc(controlValueText(control))}</span>`;
  } else {
    // text / number / url / list / color all edit as one line of text; the CLI
    // validates against the zod schema and rejects anything invalid.
    input = `<input type="text" class="ctl txt" data-id="${id}" data-kind="${esc(
      control.kind,
    )}" value="${esc(controlValueText(control, ""))}" placeholder="(unset)">`;
  }

  const danger = control.danger ? ` data-danger="${esc(control.danger)}"` : "";
  const advanced = control.advanced ? " adv" : "";
  return (
    `<div class="crow${advanced}"${danger} title="${title}">` +
    `<span class="clabel">${label}</span>` +
    `<span class="cval">${input}${scopeSelect}<span class="lay">${layer}</span></span>` +
    "</div>"
  );
}

/** A control's value as display text. `fallback` is used for unset values. */
function controlValueText(control, fallback = "(unset)") {
  const v = control.value;
  if (v === undefined || v === null) return fallback;
  if (Array.isArray(v)) {
    if (v.length === 0) return fallback === "" ? "" : "(none)";
    return v.every((i) => typeof i !== "object" || i === null)
      ? v.join(", ")
      : `${v.length} entr${v.length === 1 ? "y" : "ies"}`;
  }
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function renderHtml(model, nonce) {
  const compressionButtons = COMPRESSION_LEVELS.map(
    (l) =>
      `<button class="lvl ${l.level === String(model.compression) ? "on" : ""}" data-level="${l.level}" title="${esc(
        l.name,
      )}">${l.level}</button>`,
  ).join("");
  const stageRows = model.perStage
    .map(
      (p) =>
        `<tr><td>${esc(p.stage)}</td><td>${fmtTokens(p.before)}</td><td>${fmtTokens(
          p.after,
        )}</td><td class="save">${fmtTokens(p.saved)}</td></tr>`,
    )
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body{font:12px var(--vscode-font-family);color:var(--vscode-foreground);padding:10px}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;opacity:.7;margin:14px 0 6px}
  .big{font-size:26px;font-weight:600;color:var(--vscode-charts-green,#3fb950)}
  .sub{opacity:.7}
  .row{display:flex;justify-content:space-between;margin:3px 0}
  .lvl{width:26px;height:26px;margin-right:4px;border:1px solid var(--vscode-widget-border,#444);
       background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);
       border-radius:5px;cursor:pointer}
  .lvl.on{background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:700}
  table{width:100%;border-collapse:collapse;margin-top:4px}
  td,th{text-align:right;padding:2px 4px}td:first-child,th:first-child{text-align:left;opacity:.85}
  .save{color:var(--vscode-charts-green,#3fb950)}
  .warn{color:var(--vscode-charts-yellow,#d7ba7d)}
  .ok{color:var(--vscode-charts-green,#3fb950)}
  .pill{display:inline-block;padding:1px 7px;border-radius:9px;background:var(--vscode-badge-background);
        color:var(--vscode-badge-foreground)}
  .toggle{margin-left:8px;padding:1px 9px;border:1px solid var(--vscode-widget-border,#444);
       background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);
       border-radius:5px;cursor:pointer;font:11px var(--vscode-font-family)}
  .toggle:hover{background:var(--vscode-button-secondaryHoverBackground,var(--vscode-button-background))}
  /* Settings section (rendered from the golem config schema control surface). */
  .grp{margin:6px 0}
  .grp>summary{cursor:pointer;font-weight:600;opacity:.9;padding:2px 0}
  .gsum{margin:0 0 4px 2px;font-size:11px}
  .crow{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:2px 0 2px 2px}
  .crow:hover{background:var(--vscode-list-hoverBackground)}
  .clabel{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cval{flex:0 0 auto;display:flex;align-items:center;gap:6px}
  .lay{font-size:10px;opacity:.55;min-width:46px;text-align:right}
  .ctl.txt{width:110px}
  .ctl,.scope{background:var(--vscode-input-background);color:var(--vscode-input-foreground);
       border:1px solid var(--vscode-input-border,var(--vscode-widget-border,#444));border-radius:4px;
       font:11px var(--vscode-font-family);padding:1px 3px}
  .scope{opacity:.75}
  .hideadv .adv{display:none}
</style></head><body>
  <div class="big">${model.savedPct}%</div>
  <div class="sub">saved · ${fmtTokens(model.before)} → ${fmtTokens(model.after)} tokens · ${
    model.requests
  } req${model.savingsWindow ? ` · ${esc(model.savingsWindow)}` : ""}</div>

  <h2>Status</h2>
  <div class="row"><span>Proxy</span><span>
    <span class="${model.proxyBypass ? "warn" : model.proxyReachable ? "ok" : "warn"}">${
      model.proxyBypass ? "bypass — pipeline off" : model.proxyReachable ? "running" : "stopped"
    }</span>
    <button class="toggle" id="proxyToggle" data-running="${
      model.proxyReachable && !model.proxyBypass ? "1" : "0"
    }">${model.proxyReachable && !model.proxyBypass ? "Stop" : "Start"}</button>
  </span></div>
  <div class="row"><span>Upstream</span><span class="pill">${esc(
    model.upstreamLabel,
  )}${model.provider && model.provider !== model.upstreamLabel ? ` · ${esc(model.provider)}` : ""}${
    model.model ? ` · ${esc(model.model)}` : ""
  }</span></div>
  <div class="row"><span>Inference</span><span class="sub">${
    model.localModelActive
      ? `local + upstream${model.coderModel ? ` · coder ${esc(model.coderModel)}` : ""}`
      : model.coderEnabled === false
        ? "upstream only · local coder disabled"
        : "upstream only"
  }</span></div>
  <div class="row"><span>Stats source</span><span class="sub">${esc(model.source)}</span></div>
  <div class="row"><span>Version</span><span>${
    model.updateAvailable
      ? `<span class="warn">${esc(model.currentVersion || "")} → ${esc(
          model.latestVersion || "",
        )}</span><button class="toggle" id="updateBtn">Update</button>`
      : `<span class="sub">${esc(model.currentVersion || "unknown")}</span>`
  }</span></div>

  <h2>Compression (${esc(String(model.compression))}${model.compressionName ? ` · ${esc(model.compressionName)}` : ""})</h2>
  <div>${compressionButtons}</div>
  <div class="row"><span>Dials</span><span class="sub">${esc(dialsSummary(model))}</span></div>${
    model.brevity !== "off"
      ? `\n  <div class="row"><span class="warn">Brevity active</span><span class="sub">replies are shortened (${esc(
          model.brevity,
        )}) — output tokens only; code and errors stay verbatim</span></div>`
      : ""
  }

  <h2>Per-stage savings</h2>
  <table><tr><th>stage</th><th>before</th><th>after</th><th>saved</th></tr>${
    stageRows || '<tr><td colspan="4" class="sub">no traffic yet</td></tr>'
  }</table>

  ${settingsHtml(model.surface)}
  <div class="row"><span class="sub">
    <label><input type="checkbox" id="advToggle"> show advanced</label>
  </span></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    for (const b of document.querySelectorAll('.lvl')) {
      b.addEventListener('click', () => vscode.postMessage({ type: 'setCompression', level: String(b.dataset.level) }));
    }
    const pt = document.getElementById('proxyToggle');
    if (pt) pt.addEventListener('click', () => vscode.postMessage({ type: pt.dataset.running === '1' ? 'proxyStop' : 'proxyStart' }));
    const ub = document.getElementById('updateBtn');
    if (ub) ub.addEventListener('click', () => vscode.postMessage({ type: 'update' }));

    // Advanced rows are hidden by default; the preference lives in the webview's
    // own state so it survives a repaint (the panel re-renders on every refresh).
    const advBox = document.getElementById('advToggle');
    const saved = vscode.getState && vscode.getState();
    const showAdv = !!(saved && saved.showAdvanced);
    if (advBox) advBox.checked = showAdv;
    document.body.classList.toggle('hideadv', !showAdv);
    if (advBox) advBox.addEventListener('change', () => {
      document.body.classList.toggle('hideadv', !advBox.checked);
      if (vscode.setState) vscode.setState({ showAdvanced: advBox.checked });
    });

    // The scope select is per-row and only chooses WHERE the next write goes; it
    // never applies anything on its own.
    const scopeFor = (id) => {
      const sel = document.querySelector('.scope[data-id="' + id + '"]');
      return sel ? sel.value : 'project';
    };
    const apply = (el, value) => {
      const row = el.closest('.crow');
      const danger = row && row.dataset.danger;
      // A dangerous change needs an explicit confirm, same as the terminal panel.
      if (danger && !confirm(danger + '\\n\\nApply it?')) {
        vscode.postMessage({ type: 'refresh' });
        return;
      }
      vscode.postMessage({ type: 'apply', id: el.dataset.id, value: value, scope: scopeFor(el.dataset.id) });
    };
    for (const el of document.querySelectorAll('.ctl')) {
      if (el.dataset.kind === 'toggle') {
        el.addEventListener('change', () => apply(el, el.checked));
      } else if (el.tagName === 'SELECT') {
        el.addEventListener('change', () => apply(el, el.value));
      } else {
        // Commit on blur or Enter, not per keystroke — every apply is a CLI spawn.
        el.addEventListener('change', () => apply(el, el.value === '' ? null : el.value));
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); });
      }
    }
  </script>
</body></html>`;
}

module.exports = {
  COMPRESSION_LEVELS,
  STATUS_FIELDS_READ,
  gatewayRows,
  fmtTokens,
  upstreamLabel,
  levelLabel,
  destinationLabel,
  buildModel,
  statusBarText,
  renderHtml,
  settingsHtml,
  controlRowHtml,
  controlValueText,
  dialsSummary,
};
