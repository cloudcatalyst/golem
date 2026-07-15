/**
 * MemorySearchProvider — the neutral seam for R3.6 MEMORY-scope federated
 * search (spec Decisions 13/18; `FederatedSearch`'s `Scope = "memory"` in
 * `src/interfaces/knowledge.ts`).
 *
 * `GolemKnowledgeBase` (src/knowledge/knowledge-base.ts) depends on THIS
 * abstraction, never on Headroom directly, so the CLAUDE.md rule "any Headroom
 * client imports live only in headroom-adapter.ts" holds: `headroom-adapter.ts`
 * provides the implementation (`HeadroomMemorySidecar`); the knowledge base and
 * its tests know only this interface. Mirrors `SemanticCompressor`'s seam.
 *
 * Fails open exactly like `SemanticCompressor.compress()`: `null` means
 * unavailable (no sidecar, not started, or an errored request) — MEMORY-scope
 * search then contributes nothing rather than failing the whole `search()` call.
 */

/** One fact retrieved from Headroom's conversational memory store. */
export interface MemoryFact {
  readonly id: string;
  readonly content: string;
  readonly score: number;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface MemorySearchProvider {
  /**
   * Search memory facts scoped to `projectId` (Golem has one project per
   * Headroom `user_id` namespace — see headroom-adapter.ts). Resolves `null`
   * when unavailable; resolves `[]` when available but nothing matches.
   */
  search(query: string, projectId: string, k: number): Promise<MemoryFact[] | null>;
}
