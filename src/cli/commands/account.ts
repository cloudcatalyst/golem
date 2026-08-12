/**
 * golem account — deprecated alias for `golem gateway` (R9.23).
 */

import registerGatewayCommands from "./gateway.js";

/**
 * Deprecated shim: registers the same commands as `golem gateway` but under
 * the `account` name, with a deprecation warning. Remove this file in the
 * release after R9.23.
 */
export function registerAccountCommands(program: import("commander").Command): void {
  process.stderr.write(
    "[DEPRECATED] Use 'golem gateway' instead of 'golem account' — " +
      "this alias will be removed in a future release.\n",
  );
  registerGatewayCommands(program);
}
