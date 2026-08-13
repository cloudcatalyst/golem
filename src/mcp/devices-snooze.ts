/**
 * Devices and snooze tools. Extracted from server.ts (R8.28).
 *
 * Registered unconditionally — they need no injected service, only the
 * always-available hardware-probe functions and the abort signal.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  availabilityWarning,
  createProbeRunner,
  DEFAULT_OLLAMA_BASE_URL,
  detectCapability,
  modelsForTier,
  OllamaNativeClient,
  resolveTierAvailability,
} from "../inference/index.js";
import type { HardwareTier } from "../interfaces/index.js";
import type { GolemMcpServerDeps } from "./deps.js";
import { errorResult, instrumented, type ToolTelemetry } from "./shared.js";
import { abortableSleep, DEFAULT_SNOOZE_MAX_MS, runSnooze, SnoozeInputError } from "./snooze.js";
import { persistSnoozeNote } from "./snooze-note.js";

/** `golem devices` CLI's tier→name map, duplicated here since it is a local const there. */
const DEVICE_TIER_NAMES: Readonly<Record<HardwareTier, string>> = {
  0: "P_CPU",
  1: "P_MIN",
  2: "P_MID",
  3: "P_MAX",
};

/**
 * P0 tool: report the detected local hardware tier and the models Golem
 * would use for it — the MCP twin of the `golem devices` CLI command.
 * Registered unconditionally: detection needs no injected service, only the
 * always-available hardware-probe functions, and `detectCapability` never
 * throws (every failure path degrades to P_CPU).
 */
export function registerDevicesTool(
  server: McpServer,
  deps: GolemMcpServerDeps,
  // R9.11: `devices` recorded nothing, so it read as "never called" when it was
  // only never measured — and it is one of the demotion candidates whose call
  // count was supposed to decide its fate.
  tel?: ToolTelemetry,
): void {
  server.registerTool(
    "devices",
    {
      title: "Show detected local hardware",
      description:
        "Report Golem's detected local hardware tier (GPU/accelerator, memory) and " +
        "the local models Golem would use at that tier — including, per role, whether " +
        "that model is actually downloaded and callable. Same info as the " +
        "`golem devices` CLI command.",
      outputSchema: {
        tier: z.number().int().min(0).max(3),
        tier_name: z.string(),
        source: z.string(),
        device: z.string().optional(),
        memory_mib: z.number().optional(),
        detail: z.string(),
        models: z.array(z.string()),
        endpoint: z.string(),
        endpoint_reachable: z.boolean(),
        model_slots: z.array(
          z.object({
            slot: z.string(),
            model: z.string(),
            state: z.enum(["pulled", "not-pulled", "unknown"]),
          }),
        ),
        missing: z.array(z.string()),
      },
    },
    async () => {
      const startMs = Date.now();
      const facts = await detectCapability(createProbeRunner());
      const models = modelsForTier(facts.tier);
      const tierName = DEVICE_TIER_NAMES[facts.tier];
      const endpoint = deps.localEndpoint ?? DEFAULT_OLLAMA_BASE_URL;
      const availability = await resolveTierAvailability(facts.tier, {
        endpoint,
        listModels: () =>
          new OllamaNativeClient({ baseUrl: endpoint, requestTimeoutMs: 2500 }).listModels(),
      });
      const lines = [`Hardware tier: ${facts.tier} (${tierName}) — via ${facts.source}`];
      if (facts.device !== undefined) lines.push(`  device: ${facts.device}`);
      if (facts.memoryMiB !== undefined) lines.push(`  memory: ${facts.memoryMiB} MiB`);
      lines.push(`  ${facts.detail}`);
      lines.push(
        `  models for this tier (endpoint ${endpoint}${availability.reachable ? "" : " — NOT reachable"}):`,
      );
      for (const m of availability.models) {
        const state =
          m.state === "pulled" ? "pulled" : m.state === "not-pulled" ? "NOT pulled" : "unknown";
        lines.push(`    ${m.slot}: ${m.model} — ${state}`);
      }
      const warning = availabilityWarning(availability);
      if (warning !== null) lines.push("", warning);
      return instrumented(tel, "devices", startMs, {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: {
          tier: facts.tier,
          tier_name: tierName,
          source: facts.source,
          detail: facts.detail,
          models,
          endpoint,
          endpoint_reachable: availability.reachable,
          model_slots: availability.models.map((m) => ({
            slot: m.slot,
            model: m.model,
            state: m.state,
          })),
          missing: [...new Set(availability.missing.map((m) => m.model))],
          ...(facts.device !== undefined ? { device: facts.device } : {}),
          ...(facts.memoryMiB !== undefined ? { memory_mib: facts.memoryMiB } : {}),
        },
      });
    },
  );
}

/**
 * Golem snooze: park the live session until a usage-limit reset, then continue
 * in-place. Registered unconditionally.
 */
export function registerSnoozeTool(server: McpServer, deps: GolemMcpServerDeps): void {
  server.registerTool(
    "snooze",
    {
      title: "Wait out a usage-limit reset in place",
      description:
        "Park this session until a usage/session limit resets, then continue the " +
        "SAME conversation in-place. Holds this tool call open (emitting progress so " +
        "it is not idle-timed-out) until `until` (an ISO reset time) or for " +
        "`duration_ms`, capped at `max_ms`. No model tokens are consumed while it " +
        "waits. Use it when you are about to hit — or have just hit — a usage limit " +
        "and want to resume this conversation once quota returns rather than losing " +
        "the session. Declines if the reset is further out than the cap (e.g. a " +
        "multi-day weekly limit). Pass `note` with where you're up to and the next " +
        "steps: it is filed as a durable local task BEFORE the wait starts, so your " +
        "place survives even if the session ends before the reset — you do not need " +
        "(and under enforcement cannot make) a separate `golem task add` call.",
      inputSchema: {
        note: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Where you're up to + the next steps. Persisted as a durable local task " +
              "(the same thing `golem task add` writes) BEFORE the wait begins, so it " +
              "survives the session ending. Strongly recommended when parking at a limit.",
          ),
        until: z
          .string()
          .min(1)
          .optional()
          .describe("ISO-8601 reset time to wait until (e.g. from a rate-limit reset header)"),
        duration_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Explicit wait duration in ms (alternative to `until`)"),
        max_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Hard cap on the wait in ms (default ${DEFAULT_SNOOZE_MAX_MS}, ~6h)`),
      },
      outputSchema: {
        reset: z.boolean(),
        waited_ms: z.number().int().nonnegative(),
        target_ms: z.number().int().nonnegative(),
        heartbeats: z.number().int().nonnegative(),
        reason: z.string().optional(),
        task_id: z.string().optional(),
        note_error: z.string().optional(),
      },
    },
    async ({ note, until, duration_ms, max_ms }, extra) => {
      const progressToken = extra._meta?.progressToken;
      let progress = 0;
      let taskId: string | undefined;
      let noteError: string | undefined;
      if (note !== undefined) {
        if (deps.projectRootDir === undefined) {
          noteError = "no project root is configured for this MCP server — nothing to write into";
        } else {
          const saved = await persistSnoozeNote(deps.projectRootDir, note);
          if (saved.ok) taskId = saved.id;
          else noteError = saved.error;
        }
      }
      const noteLines = (): string => {
        if (note === undefined) return "";
        if (taskId !== undefined) {
          return ` Your note is filed as local task \`${taskId.slice(0, 8)}\` (\`golem task list\`).`;
        }
        return (
          ` WARNING: your note could NOT be filed as a task (${noteError ?? "unknown error"}), ` +
          `so it exists only here — re-file it once you resume: ${note}`
        );
      };
      try {
        const outcome = await runSnooze(
          {
            ...(until !== undefined ? { until } : {}),
            ...(duration_ms !== undefined ? { durationMs: duration_ms } : {}),
            ...(max_ms !== undefined ? { maxMs: max_ms } : {}),
          },
          {
            now: () => Date.now(),
            sleep: abortableSleep,
            signal: extra.signal,
            heartbeat: async () => {
              if (progressToken === undefined) return;
              progress += 1;
              await extra.sendNotification({
                method: "notifications/progress",
                params: { progressToken, progress },
              });
            },
          },
        );
        const mins = Math.round(outcome.waitedMs / 60_000);
        const text =
          (outcome.reset
            ? `**Golem** Snoozed ~${mins} min — the usage window should have reset; continuing here.`
            : `**Golem** Snooze ended without a full wait (${outcome.reason ?? "stopped"}).`) +
          noteLines();
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            reset: outcome.reset,
            waited_ms: outcome.waitedMs,
            target_ms: outcome.targetMs,
            heartbeats: outcome.heartbeats,
            ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
            ...(taskId !== undefined ? { task_id: taskId } : {}),
            ...(noteError !== undefined ? { note_error: noteError } : {}),
          },
        };
      } catch (err) {
        if (err instanceof SnoozeInputError) return errorResult(err.message + noteLines());
        throw err;
      }
    },
  );
}
