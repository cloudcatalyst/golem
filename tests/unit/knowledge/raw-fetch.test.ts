/**
 * fetchRawPage (Decision 42): fetch the raw page ourselves, dispatch by
 * content-type, and surface HTTP validators. Uses a stubbed global `fetch` —
 * no network.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRawPage } from "../../../src/knowledge/index.js";

/** Minimal Response stand-in for the fields fetchRawPage reads. */
function fakeResponse(opts: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  arrayBuffer?: ArrayBuffer;
}): Response {
  const headers = new Map(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.statusText ?? "OK",
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    text: async () => opts.body ?? "",
    arrayBuffer: async () => opts.arrayBuffer ?? new ArrayBuffer(0),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchRawPage", () => {
  it("strips HTML to visible text when content-type is html", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse({
          headers: { "content-type": "text/html; charset=utf-8" },
          body: "<html><head><style>.x{}</style></head><body><h1>Title</h1><p>Hello world.</p></body></html>",
        }),
      ),
    );
    const page = await fetchRawPage("https://example.com/doc");
    expect(page.content).toContain("Title");
    expect(page.content).toContain("Hello world.");
    expect(page.content).not.toContain("<h1>"); // markup stripped
    expect(page.content).not.toContain(".x{}"); // style dropped
  });

  it("returns non-HTML text verbatim", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse({
          headers: { "content-type": "text/plain" },
          body: "raw text body\nline two",
        }),
      ),
    );
    const page = await fetchRawPage("https://example.com/plain.txt");
    expect(page.content).toBe("raw text body\nline two");
  });

  it("captures etag / last-modified / cache-control / expires headers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse({
          headers: {
            "content-type": "text/plain",
            etag: 'W/"abc"',
            "last-modified": "Wed, 01 Jul 2026 00:00:00 GMT",
            "cache-control": "max-age=3600",
            expires: "Thu, 02 Jul 2026 00:00:00 GMT",
          },
          body: "x",
        }),
      ),
    );
    const page = await fetchRawPage("https://example.com/x");
    expect(page.headers).toStrictEqual({
      etag: 'W/"abc"',
      lastModified: "Wed, 01 Jul 2026 00:00:00 GMT",
      cacheControl: "max-age=3600",
      expires: "Thu, 02 Jul 2026 00:00:00 GMT",
    });
  });

  it("omits headers that are absent (no undefined values)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse({ headers: { "content-type": "text/plain" }, body: "x" })),
    );
    const page = await fetchRawPage("https://example.com/x");
    expect(page.headers).toStrictEqual({});
  });

  it("throws on a non-2xx response (caller caches nothing)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse({ ok: false, status: 404, statusText: "Not Found" })),
    );
    await expect(fetchRawPage("https://example.com/missing")).rejects.toThrow(/404/);
  });
});
