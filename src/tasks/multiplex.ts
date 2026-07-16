/**
 * R5.3 (WS-F2 + F8 / spec 20b, 21a) — local conversation multiplexing.
 *
 * A single serialized Claude session is the bottleneck. This services queued
 * tasks (from R5.1's TaskStore) LOCALLY on the Ollama tier — triage, drafts,
 * retrieval — concurrently but bounded (respect the machine), attaching each
 * result to the task for later review. Cloud quality is reserved for explicit
 * escalation (21a): a local result is folded into the prompt as grounding and
 * the task is handed to the Claude tier. **Never auto-escalates silently**
 * (Decision 31) — escalation is an explicit act, like `coder`.
 *
 * Graceful degradation is the rule: if the local model is unavailable, tasks
 * stay `queued` with a recorded `lastError` — nothing crashes, nothing is lost.
 */

import type { InferenceService, Role } from "../interfaces/inference.js";
import { CapabilityUnavailableError } from "../interfaces/inference.js";
import type { TaskStore } from "./store.js";
import type { Task } from "./types.js";

/** Wiring for local servicing (all injectable for tests). */
export interface MultiplexDeps {
  readonly inference: InferenceService;
  /** Local role to service with (default "drafter"). */
  readonly role?: Role;
  /**
   * Optional grounding lookup (R4.2 reuse) — returns a context block for a
   * prompt, or null. Used both when servicing and when preparing an escalation.
   */
  readonly ground?: (prompt: string) => Promise<string | null>;
}

const SERVICE_SYSTEM =
  "You are Golem's local co-worker. Give a concise, useful first pass at the task " +
  "(triage, a draft, or a retrieval answer). If the task genuinely needs a stronger " +
  "model, say so briefly at the end with the marker NEEDS_CLAUDE and why.";

/**
 * Service one task locally. Returns the updated task: `done` with `result` set
 * on success, or unchanged `state` + `lastError` if the local model is
 * unavailable (fail-open — the task stays queued for a later attempt).
 */
export async function serviceTaskLocally(
  task: Task,
  deps: MultiplexDeps,
  nowIso: string = new Date().toISOString(),
): Promise<Task> {
  const role = deps.role ?? "drafter";
  let grounding: string | null = null;
  if (deps.ground !== undefined) {
    try {
      grounding = await deps.ground(task.prompt);
    } catch {
      grounding = null; // grounding is best-effort, never fatal
    }
  }
  const userContent =
    grounding !== null && grounding.length > 0
      ? `${task.prompt}\n\n[Project context]\n${grounding}`
      : task.prompt;

  try {
    const result = await deps.inference.chat(role, [
      { role: "system", content: SERVICE_SYSTEM },
      { role: "user", content: userContent },
    ]);
    const suggestsEscalation = /NEEDS_CLAUDE/.test(result.text);
    return {
      ...task,
      state: "done",
      result: result.text,
      updatedAt: nowIso,
      checkpoints: [
        ...task.checkpoints,
        {
          label: `serviced locally (${result.model})`,
          status: "done",
          ...(suggestsEscalation ? { note: "local model suggests escalation (NEEDS_CLAUDE)" } : {}),
          ts: nowIso,
        },
      ],
    };
  } catch (err) {
    // CapabilityUnavailableError or any transport error → leave it queued.
    const message =
      err instanceof CapabilityUnavailableError
        ? `local model unavailable: ${err.message}`
        : `local servicing failed: ${err instanceof Error ? err.message : String(err)}`;
    return { ...task, lastError: message, updatedAt: nowIso };
  }
}

/** Run `fn` over `items` with at most `limit` in flight at once. Order preserved. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const cap = Math.max(1, Math.floor(limit));
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  }
  const workers = Array.from({ length: Math.min(cap, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export interface QueueRunResult {
  readonly serviced: number;
  readonly failed: number;
  readonly total: number;
  /** True if the first attempt hit an unavailable local model (we stopped early). */
  readonly localModelUnavailable: boolean;
}

/**
 * Service queued tasks locally, bounded by `concurrency` (default 2 — mirror the
 * drafter's single-flight discipline; keep it small to respect the machine).
 * Each result is persisted. If the local model is unavailable, we detect it on
 * the first task and stop early rather than hammering a dead endpoint.
 */
export async function runQueueLocally(
  store: TaskStore,
  deps: MultiplexDeps,
  opts: { concurrency?: number; limit?: number; nowIso?: string } = {},
): Promise<QueueRunResult> {
  const all = await store.list();
  const queued = all
    .filter((t) => t.state === "queued")
    .slice(0, opts.limit ?? Number.POSITIVE_INFINITY);
  if (queued.length === 0) {
    return { serviced: 0, failed: 0, total: 0, localModelUnavailable: false };
  }

  // Probe with the first task; if the model is down, don't fan out onto a dead
  // endpoint — report and leave the rest queued.
  const first = await serviceOne(store, queued[0] as Task, deps, opts.nowIso);
  if (first === "unavailable") {
    return { serviced: 0, failed: 1, total: queued.length, localModelUnavailable: true };
  }

  const rest = queued.slice(1);
  const outcomes = await mapWithConcurrency(rest, opts.concurrency ?? 2, (t) =>
    serviceOne(store, t, deps, opts.nowIso),
  );
  const all2 = [first, ...outcomes];
  return {
    serviced: all2.filter((o) => o === "serviced").length,
    failed: all2.filter((o) => o !== "serviced").length,
    total: queued.length,
    localModelUnavailable: false,
  };
}

async function serviceOne(
  store: TaskStore,
  task: Task,
  deps: MultiplexDeps,
  nowIso?: string,
): Promise<"serviced" | "failed" | "unavailable"> {
  const running = await store.put({ ...task, state: "running" }, nowIso);
  const done = await serviceTaskLocally(running, deps, nowIso);
  await store.put(done, nowIso);
  if (done.state === "done") return "serviced";
  return done.lastError?.startsWith("local model unavailable") === true ? "unavailable" : "failed";
}

/**
 * Prepare an EXPLICIT escalation to the Claude tier (21a). Folds the local
 * result + any grounding into the prompt as context and marks the task so
 * `golem task resume` relaunches it to Claude. Not called automatically.
 */
export function escalateTask(
  task: Task,
  grounding: string | null,
  nowIso: string = new Date().toISOString(),
): Task {
  const contextParts: string[] = [];
  if (task.result !== undefined && task.result.length > 0) {
    contextParts.push(`[Local model's first pass]\n${task.result}`);
  }
  if (grounding !== null && grounding.length > 0) {
    contextParts.push(`[Project context]\n${grounding}`);
  }
  const prompt =
    contextParts.length > 0 ? `${task.prompt}\n\n${contextParts.join("\n\n")}` : task.prompt;
  return {
    ...task,
    prompt,
    state: "queued",
    escalated: true,
    updatedAt: nowIso,
    checkpoints: [
      ...task.checkpoints,
      { label: "escalated to Claude tier", status: "done", ts: nowIso },
    ],
  };
}
