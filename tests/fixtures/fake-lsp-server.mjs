#!/usr/bin/env node
/**
 * A minimal fake language server for the R8.6 bridge tests.
 *
 * Golem must never ship or depend on a real language server (Decision 53
 * criterion 4), and CI has none installed — but the thing R8.6 actually risks
 * is **lifecycle**: handshake, framing, timeout, crash, orphaning. All of that
 * is protocol, not TypeScript, so this script speaks just enough LSP to
 * exercise it identically on Windows, macOS and Linux.
 *
 * Behaviour is chosen by argv[2]:
 *   ok          answer everything
 *   slow        complete the handshake, then never answer a request
 *   no-init     never answer `initialize`
 *   crash       exit(1) on the first message after the handshake
 *   garbage     write an unframed byte stream (protocol desync)
 *   split       answer normally, but write every frame one byte at a time
 */

const mode = process.argv[2] ?? "ok";

let pending = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const frame = Buffer.concat([
    Buffer.from(
      `Content-Length: ${body.byteLength}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n`,
      "ascii",
    ),
    body,
  ]);
  if (mode === "split") {
    for (const byte of frame) process.stdout.write(Buffer.from([byte]));
  } else {
    process.stdout.write(frame);
  }
}

function handle(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    if (mode === "no-init") return;
    send({
      jsonrpc: "2.0",
      id,
      result: {
        capabilities: { definitionProvider: true, referencesProvider: true, hoverProvider: true },
        serverInfo: { name: "fake-lsp", version: "0.0.0" },
      },
    });
    return;
  }

  // Die mid-session, after a completed handshake — the case where a pooled
  // client is alive on paper and dead in fact.
  if (mode === "crash") process.exit(1);
  // Answer nothing at all after the handshake: the hang the bridge must bound,
  // for notifications (no diagnostics will ever be published) as well as requests.
  if (mode === "slow") return;

  if (method === "textDocument/didOpen") {
    const uri = params?.textDocument?.uri;
    // Two publishes, the second a revision — the tsserver pattern the bridge's
    // settle window exists for.
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri, diagnostics: [] },
    });
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri,
          diagnostics: [
            {
              range: { start: { line: 1, character: 2 }, end: { line: 1, character: 9 } },
              severity: 1,
              code: "TS2304",
              source: "typescript",
              message: "Cannot find name 'missing'.",
            },
          ],
        },
      });
    }, 20);
    return;
  }

  if (method === "textDocument/definition") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        uri: params.textDocument.uri,
        range: { start: { line: 0, character: 16 }, end: { line: 0, character: 25 } },
      },
    });
    return;
  }

  if (method === "textDocument/references") {
    send({
      jsonrpc: "2.0",
      id,
      result: [
        {
          uri: params.textDocument.uri,
          range: { start: { line: 4, character: 6 }, end: { line: 4, character: 15 } },
        },
        {
          uri: params.textDocument.uri,
          range: { start: { line: 7, character: 0 }, end: { line: 7, character: 9 } },
        },
      ],
    });
    return;
  }

  if (method === "textDocument/hover") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        contents: {
          kind: "markdown",
          value: "```ts\nfunction coreThing(input: string): string\n```",
        },
      },
    });
    return;
  }

  if (method === "shutdown") {
    send({ jsonrpc: "2.0", id, result: null });
    return;
  }

  if (method === "exit") {
    process.exit(0);
  }

  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `no ${method}` } });
  }
}

process.stdin.on("data", (chunk) => {
  if (mode === "garbage") {
    process.stdout.write("this is not a framed message at all\n");
    return;
  }
  pending = Buffer.concat([pending, chunk]);
  for (;;) {
    const separator = pending.indexOf("\r\n\r\n");
    if (separator === -1) return;
    const header = pending.subarray(0, separator).toString("ascii");
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (match === null) return;
    const length = Number(match[1]);
    const start = separator + 4;
    if (pending.byteLength - start < length) return;
    const body = pending.subarray(start, start + length).toString("utf8");
    pending = pending.subarray(start + length);
    handle(JSON.parse(body));
  }
});

// Never let a stray stdout error take the fake server down mid-test.
process.stdout.on("error", () => {});
