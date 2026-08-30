/**
 * R9.4 / R14.2 — the tool-worker registry, now sourced from config.
 *
 * A **worker** is a persona staffed in the `worker` lane: Golem dispatches the
 * job to a model of its own, as a bounded single-shot, rather than the harness
 * running an agent loop. `coder` was the only one for a long time.
 *
 * ## What R14.2 changed
 *
 * R9.4 chose a MAP (`inference.worker_targets`) over a scalar per worker so that
 * adding a worker cost one line of config rather than a schema leaf, a UI-model
 * entry, a status field and two status-surface branches. Its header then told
 * the next contributor to *"add its name here"* — to `KNOWN_WORKERS`, a
 * `const` of length one.
 *
 * That was the remaining half of the problem: the map was open, the **roster**
 * was not, so a project could not add a worker without a Golem release. The
 * roster now comes from `inference.personas` (R14.1), and adding a worker is a
 * config edit. `KNOWN_WORKERS` is gone; nothing should reintroduce a
 * compile-time list of who may exist.
 *
 * ## What did NOT change
 *
 * The property that made the map safe. R9.4's header put it plainly: what a map
 * gives up is that *"a typo'd key would otherwise be silently ignored"*, and
 * {@link unknownWorkerWarnings} buys it back. A `worker_targets` key naming no
 * declared persona still does nothing and is still reported loudly — the source
 * of "what exists" moved, the honesty did not.
 */

import { effectivePersonas, type PersonaConfig } from "./personas.js";

/**
 * A worker name is a persona id. No longer a closed union: the roster is config,
 * so the type cannot enumerate it.
 */
export type WorkerName = string;

/** Every declared persona id, in stable order — the live replacement for `KNOWN_WORKERS`. */
export function declaredWorkers(
  personas: Readonly<Record<string, PersonaConfig>> | undefined,
): readonly string[] {
  if (personas === undefined) return [];
  return effectivePersonas(personas).map((p) => p.id);
}

/**
 * Whether `name` names a persona this project actually declares.
 *
 * **An absent roster means "cannot judge", not "no".** A caller that has no
 * `personas` to hand gets `true`, so routing it already had keeps working.
 *
 * That asymmetry is deliberate and it is the safer direction. The guard exists
 * to stop a TYPO from routing; treating a missing roster as a rejection would
 * instead make every worker route silently disappear for any caller that forgot
 * to thread the roster through — turning a reporting nicety into a routing
 * regression, which is far worse than the failure it prevents. Callers that DO
 * supply a roster still get the full guard.
 */
export function isKnownWorker(
  name: string,
  personas: Readonly<Record<string, PersonaConfig>> | undefined,
): boolean {
  if (personas === undefined) return true;
  return Object.hasOwn(personas, name);
}

/**
 * The target id a worker defaults to, or undefined for "not routed here".
 *
 * An unknown *worker* key resolves to nothing rather than throwing: it is a
 * config typo, not a routing decision, and it must not stop the worker that IS
 * configured correctly from working. It is surfaced by
 * {@link unknownWorkerWarnings} instead. (An unknown *target* is a different
 * matter entirely — that fails closed at dispatch, because it would otherwise
 * send context somewhere the user did not choose.)
 */
export function workerTarget(
  workerTargets: Readonly<Record<string, string>> | undefined,
  worker: string,
  personas: Readonly<Record<string, PersonaConfig>> | undefined,
): string | undefined {
  if (workerTargets === undefined) return undefined;
  if (!isKnownWorker(worker, personas)) return undefined;
  const id = workerTargets[worker];
  return id !== undefined && id !== "" ? id : undefined;
}

/**
 * Keys in `inference.worker_targets` that name no persona this project declares.
 *
 * Silently ignoring these is the failure mode the map shape would otherwise
 * introduce: the user writes `writer = "…"` before the persona exists (or
 * misspells `codr`), sees no error, and reasonably believes it took effect.
 */
export function unknownWorkerWarnings(
  workerTargets: Readonly<Record<string, string>> | undefined,
  personas: Readonly<Record<string, PersonaConfig>> | undefined,
): readonly string[] {
  if (workerTargets === undefined) return [];
  // No roster supplied — nothing to judge against, so say nothing rather than
  // reporting every key as unknown. Same rule as `isKnownWorker`.
  if (personas === undefined) return [];
  const known = declaredWorkers(personas).join(", ");
  return Object.keys(workerTargets)
    .filter((key) => !isKnownWorker(key, personas))
    .map(
      (key) =>
        `inference.worker_targets."${key}" names no persona this project declares, so it does ` +
        `nothing. Declared personas: ${known || "(none)"}. ` +
        `Add it under inference.personas.${key} first.`,
    );
}
