/**
 * Config-specific error type (E1).
 *
 * Every validation failure names its source (which file / which env var /
 * per-request overrides) and, when applicable, the dotted `section.key` it
 * refers to — required by the "path-specific error messages" rule.
 */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
  /** Where the bad value came from: absolute file path, env var name, or a layer label. */
  readonly source?: string;
  /** Dotted `section.key` path of the offending setting, when known. */
  readonly key?: string;

  constructor(message: string, opts: { source?: string; key?: string } = {}) {
    super(message);
    if (opts.source !== undefined) {
      this.source = opts.source;
    }
    if (opts.key !== undefined) {
      this.key = opts.key;
    }
  }
}
