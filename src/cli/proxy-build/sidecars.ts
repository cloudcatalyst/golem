/**
 * The optional per-run services `buildProxyFromSettings` hangs off the pipeline:
 * the opt-in Headroom semantic sidecar, the shared CCR blob store, the webcache
 * that feeds R2.2 context substitution, and the R2.3 local-answer service.
 *
 * Extracted verbatim from `proxy-runtime.ts` (R10.1). Everything here is STATIC
 * per run — each one is an opt-in gate resolved once at construction, never
 * something the live slider toggles (Decision 31: the slider stays a pure
 * compression dial).
 */

import { join } from "node:path";
import { HeadroomSidecar } from "../../compression/headroom-adapter.js";
import { CcrStore, LocalDirBlobStore } from "../../compression/index.js";
import type { GolemSettings } from "../../config/index.js";
import { hashingEmbedFn, openKnowledgeBase } from "../../knowledge/index.js";
import { KnowledgeLocalAnswerService } from "../../knowledge/local-answer.js";
import { WebCache, webCacheDir } from "../../knowledge/web-cache.js";
import type { BuildProxyOptions } from "../proxy-runtime.js";

export interface ProxySidecars {
  /** Present only when `settings.compression.headroom_sidecar` is set (opt-in, slider ≥2). */
  readonly semantic: HeadroomSidecar | undefined;
  readonly ccrStore: CcrStore;
  /** The same store as `ccrStore`, but only when the Headroom sidecar is configured. */
  readonly headroomCcrStore: CcrStore | undefined;
  readonly webCache: WebCache;
  readonly localAnswer: { readonly service: KnowledgeLocalAnswerService } | undefined;
}

/** Construct the opt-in sidecar services for one proxy build. */
export function buildProxySidecars(
  dir: string,
  settings: GolemSettings,
  build: BuildProxyOptions,
): ProxySidecars {
  // OPT-IN semantic sidecar (Headroom) for slider ≥3 — off unless configured.
  // Started lazily on first ≥3 request; fails open so the proxy never depends on it.
  // Decision 53: the opaque `headroom_config` bag rides through to the worker, so
  // Headroom options Golem has never heard of are reachable from settings alone.
  // `projectDir` is lifecycle bookkeeping, not behaviour: it stamps the worker's
  // command line with the project it belongs to, so a later start-up sweep can
  // reap THIS project's stray workers and no other project's (R10.3).
  const semantic = settings.compression.headroom_sidecar
    ? new HeadroomSidecar({ config: settings.compression.headroom_config, projectDir: dir })
    : undefined;
  // Same `.golem/ccr` directory `NativeLosslessCompression.forProjectDir(dir)`
  // writes to, shared by both the R2.4 Headroom backfill and R2.2 context
  // substitution below, so `expand` recovers either kind of marker uniformly.
  const ccrStore = new CcrStore(new LocalDirBlobStore(join(dir, ".golem", "ccr")));
  // R2.4 (verification-notes §38): only wired into the pipeline when the
  // Headroom sidecar is actually configured — see
  // GolemPipelineOptions.headroomCcrStore's doc comment.
  const headroomCcrStore = semantic !== undefined ? ccrStore : undefined;
  // R2.2 (verification-notes §62): webcache-only v1 scope — see
  // context-substitution.ts's module doc for the caching-upstream gate this
  // feeds, and the pipeline wiring below. Rebuilt fresh on every request
  // (the thunk, not a cached value) so newly-fetched pages are recognized
  // without a restart; acceptable cost at realistic project webcache sizes.
  const webCache = new WebCache(webCacheDir(dir));
  // R2.3 (spec Decision 24 sub-mode 2 / Decision 33): OFF by default. When
  // enabled, opens the SAME embedded KnowledgeBase `golem index`/`mcp serve`
  // build (FileVectorDriver under `.golem/knowledge`), choosing ONE embedder
  // the way build-knowledge.ts does — semantic when an inference service was
  // provided, else the zero-setup hashing fallback. Static per-run, like
  // `headroom_sidecar` above — this is an opt-in gate, not something the live
  // slider ever toggles (Decision 31: the slider stays a pure compression dial).
  const localAnswer =
    settings.knowledge.local_answer_enabled && build.suppressLocalAnswer !== true
      ? {
          service: new KnowledgeLocalAnswerService(
            openKnowledgeBase({
              projectDir: dir,
              ...(build.inference !== undefined
                ? { inference: build.inference }
                : { embed: hashingEmbedFn() }),
            }),
            { minConfidence: settings.knowledge.local_answer_min_confidence },
          ),
        }
      : undefined;
  return { semantic, ccrStore, headroomCcrStore, webCache, localAnswer };
}
