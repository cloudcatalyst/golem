/**
 * Masked terminal prompt for a credential (spec Decision 46).
 *
 * Deliberately dependency-free: raw mode on the TTY, echo `*` per character, and
 * always restore the terminal — including on Ctrl-C, which must leave the shell
 * usable rather than stuck in raw mode. The typed value is returned to the
 * caller and never written to the terminal, a log, or a file.
 *
 * Non-interactive callers (CI, a piped stdin, the daemon) must check
 * {@link canPrompt} first and fail closed with an actionable message rather than
 * hanging on a prompt nobody can answer.
 */

import type { ReadStream } from "node:tty";

export interface PromptIO {
  readonly input: NodeJS.ReadStream;
  readonly output: NodeJS.WriteStream;
}

/** Raised when the user aborts the prompt (Ctrl-C / Ctrl-D). */
export class PromptCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "PromptCancelled";
  }
}

/**
 * Can we prompt at all? False for piped/redirected stdin and for any
 * non-interactive context, where prompting would hang instead of failing.
 */
export function canPrompt(io: Partial<PromptIO> = {}): boolean {
  const input = io.input ?? process.stdin;
  return input.isTTY === true;
}

const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
/** DEL — what most terminals send for the Backspace key. */
const BACKSPACE = "\u007f";

/**
 * Prompt for a secret with masked echo. Resolves the typed value (never
 * trimmed of interior characters, only of the trailing newline), or rejects with
 * {@link PromptCancelled} if the user aborts.
 */
export async function promptSecret(question: string, io: Partial<PromptIO> = {}): Promise<string> {
  const input = (io.input ?? process.stdin) as ReadStream;
  const output = io.output ?? process.stdout;

  if (input.isTTY !== true) {
    throw new Error("cannot prompt for a credential: stdin is not a terminal");
  }

  output.write(question);

  const wasRaw = input.isRaw === true;
  return new Promise<string>((resolve, reject) => {
    const chars: string[] = [];

    const cleanup = (): void => {
      input.removeListener("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
    };

    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          output.write("\n");
          resolve(chars.join(""));
          return;
        }
        if (ch === CTRL_C || (ch === CTRL_D && chars.length === 0)) {
          cleanup();
          output.write("\n");
          reject(new PromptCancelled());
          return;
        }
        if (ch === BACKSPACE || ch === "\b") {
          if (chars.length > 0) {
            chars.pop();
            output.write("\b \b");
          }
          continue;
        }
        // Drop remaining control characters (arrow-key escape sequences etc.)
        // rather than letting them corrupt the secret.
        if (ch < " ") continue;
        chars.push(ch);
        output.write("*");
      }
    };

    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    input.on("data", onData);
  });
}
