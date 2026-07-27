/**
 * Golem credential management (ADR-0003 amendment; spec Decision 46).
 *
 * `backends.ts` — one storage mechanism each (env / OS keychain / plaintext file).
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
  DEFAULT_ACCOUNT_ID,
  DEFAULT_KEY_ENV,
  envBackend,
  envVarForAccount,
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
