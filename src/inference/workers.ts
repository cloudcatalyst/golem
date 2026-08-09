/**
 * R9.4 — the tool-worker registry.
 *
 * A **worker** is an MCP tool that delegates a job to a model of its own:
 * `coder` today, and the shape is built for more (a `writer` for documents, a
 * reviewer, …). Each worker may default to its own target from the R9.1
 * registry, configured under one `inference.worker_targets` map rather than a
 * separate settings leaf per worker.
 *
 * The map is the whole point. A scalar-per-worker (`coder_target`,
 * `writer_target`, …) grows a schema leaf, a UI-model entry, a status field and
 * two status-surface branches for every worker added; a map keyed by worker name
 * grows by one line of config and nothing else, and lets every surface render N
 * workers generically.
 *
 * What the map gives up is per-key schema documentation and per-key env
 * overrides, and — more importantly — a typo'd key would otherwise be silently
 * ignored. {@link unknownWorkerWarnings} buys that back: keys are validated
 * against {@link KNOWN_WORKERS} and reported loudly, in the same spirit as every
 * other unresolvable reference in the target registry.
 *
 * **Adding a worker: add its name here, give it a glyph in the two `ROLE_MARKS`
 * copies, and nothing else in the config or status layers needs to change.**
 */

/** Workers that can be given their own default target. */
export const KNOWN_WORKERS = ["coder"] as const;

export type WorkerName = (typeof KNOWN_WORKERS)[number];

/** Whether `name` is a worker Golem actually has. */
export function isKnownWorker(name: string): name is WorkerName {
  return (KNOWN_WORKERS as readonly string[]).includes(name);
}

/**
 * The target id a worker defaults to, or undefined for "use the local tiered
 * model" — the pre-R9.4 behaviour, and still the default.
 *
 * An unknown *worker* key resolves to nothing here rather than throwing: it is a
 * config typo, not a routing decision, and it must not stop the tool that IS
 * configured correctly from working. It is surfaced by
 * {@link unknownWorkerWarnings} instead. (An unknown *target* is a different
 * matter entirely — that fails closed at dispatch, because it would otherwise
 * send work somewhere the user did not choose.)
 */
export function workerTarget(
  workerTargets: Readonly<Record<string, string>> | undefined,
  worker: string,
): string | undefined {
  if (workerTargets === undefined) return undefined;
  if (!isKnownWorker(worker)) return undefined;
  const id = workerTargets[worker];
  return id !== undefined && id !== "" ? id : undefined;
}

/**
 * Keys in `inference.worker_targets` that name no worker Golem has.
 *
 * Silently ignoring these is the failure mode the map shape would otherwise
 * introduce: the user writes `writer = "…"` before the writer exists (or
 * misspells `codr`), sees no error, and reasonably believes it took effect.
 */
export function unknownWorkerWarnings(
  workerTargets: Readonly<Record<string, string>> | undefined,
): readonly string[] {
  if (workerTargets === undefined) return [];
  const known = KNOWN_WORKERS.join(", ");
  return Object.keys(workerTargets)
    .filter((key) => !isKnownWorker(key))
    .map(
      (key) =>
        `inference.worker_targets."${key}" names no worker Golem has, so it does nothing. ` +
        `Known workers: ${known}.`,
    );
}
