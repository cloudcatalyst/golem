/**
 * R5.5 (WS-F7 / spec 20g) — prompt translation spike (local-LLM, inspectable).
 */

export {
  appendExample,
  readExamples,
  readLastSuggestion,
  type StyleExample,
  styleDir,
  writeLastSuggestion,
} from "./style-store.js";
export { type TranslateDeps, type TranslateResult, translatePrompt } from "./translate.js";
