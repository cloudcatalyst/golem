/**
 * `InitError` in a module of its own.
 *
 * It lives here rather than in `init.ts` so that `json-file.ts` — which throws
 * it when a settings file cannot be parsed — does not have to import `init.ts`
 * and create a runtime import cycle. `init.ts` re-exports it, so every existing
 * `import { InitError } from "../init.js"` keeps working.
 */

/**
 * A user-fixable wiring problem: a malformed file, a bad flag, a path Golem
 * refuses to clobber. The CLI exits 2 on these (rather than 1) so a script can
 * tell "you gave me something wrong" from "Golem broke".
 */
export class InitError extends Error {}
