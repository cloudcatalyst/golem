/**
 * Golem credential management (ADR-0003 amendment; spec Decisions 46, 47).
 *
 * `backends.ts` — one storage mechanism each (OS keychain / plaintext file).
 *                 There is deliberately no environment-variable backend
 *                 (Decision 47) — a key is set with `golem gateway login`.
 * `store.ts`    — the resolution chain over those backends, and the only entry
 *                 point the CLI should use.
 * `prompt.ts`   — masked TTY entry, for when no credential is found.
 * `probe.ts`    — a cheap live check that the upstream actually accepts a key.
 *
 * ADR-0003 invariant 4 still holds: no MCP/tool surface imports any of this —
 * credentials are CLI and config only.
 */

export {
  type CredentialBackend,
  type CredentialBackendId,
  type CredentialLocation,
  type CredentialProtection,
  credentialsDir,
  DEFAULT_GATEWAY_ID,
  DEFAULT_KEY_ENV,
  envVarForGateway,
  fileBackend,
  keychainBackend,
} from "./backends.js";
export {
  modelsUrl,
  type ProbeInput,
  type ProbeResult,
  type ProbeVerdict,
  probeCredential,
} from "./probe.js";
export {
  canPrompt,
  PromptCancelled,
  type PromptIO,
  promptSecret,
} from "./prompt.js";
export {
  type CredentialFault,
  type CredentialStatus,
  type CredentialStore,
  type CredentialStoreOptions,
  createCredentialStore,
  type ResolvedCredential,
  type StoreTarget,
} from "./store.js";
