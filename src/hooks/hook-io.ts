/**
 * The process-I/O seam every Claude Code hook handler shares.
 *
 * Each handler is a `stdin JSON → stdout JSON → exit code` program, so they all
 * need the same two things: an injectable view of the process streams (so tests
 * never touch real stdio) and a reader that drains stdin to a string. Both used
 * to be copied into each handler — `readAll` stood four times byte-identically,
 * and {@link HookIo} lived in `post-tool-use.ts`, which made every other hook
 * import a shared contract *from a sibling handler*. They live here instead.
 */

/** Injectable process I/O so tests never touch real stdio. */
export interface HookIo {
  readonly stdin: AsyncIterable<string | Uint8Array>;
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}

export async function readAll(stream: AsyncIterable<string | Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of stream) {
    out += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
  }
  return out + decoder.decode();
}
