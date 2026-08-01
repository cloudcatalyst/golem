/**
 * R8.15 — the OpenAI-compatible native surface. Pure parts only; the HTTP client
 * is exercised by the live gate, not by a mock of a server whose real shapes are
 * the thing in question.
 *
 * The URL builders matter more than they look: `base_url` may or may not already
 * carry `/v1` (Ollama wants the bare host, llama.cpp is conventionally given the
 * suffix), and `/props` is at the server ROOT, not under `/v1`. Getting either
 * wrong produces a 404 that reads exactly like an unreachable endpoint.
 */

import { describe, expect, it } from "vitest";
import {
  modelsUrl,
  parseModelsResponse,
  parsePropsResponse,
  propsUrl,
} from "../../../src/inference/openai-models.js";

describe("modelsUrl", () => {
  it("appends /v1/models to a bare host", () => {
    expect(modelsUrl("http://localhost:11434")).toBe("http://localhost:11434/v1/models");
  });

  it("does not double the /v1 when the base already carries it", () => {
    expect(modelsUrl("http://127.0.0.1:8888/v1")).toBe("http://127.0.0.1:8888/v1/models");
  });

  it("tolerates a trailing slash either way", () => {
    expect(modelsUrl("http://127.0.0.1:8888/v1/")).toBe("http://127.0.0.1:8888/v1/models");
    expect(modelsUrl("http://localhost:11434/")).toBe("http://localhost:11434/v1/models");
  });
});

describe("propsUrl", () => {
  it("strips a /v1 suffix, because /props is at the server root", () => {
    expect(propsUrl("http://127.0.0.1:8888/v1")).toBe("http://127.0.0.1:8888/props");
    expect(propsUrl("http://127.0.0.1:8888/v1/")).toBe("http://127.0.0.1:8888/props");
  });

  it("leaves a bare host alone", () => {
    expect(propsUrl("http://127.0.0.1:8888")).toBe("http://127.0.0.1:8888/props");
  });
});

describe("parseModelsResponse", () => {
  it("reads the ids out of an OpenAI list body", () => {
    expect(
      parseModelsResponse({
        object: "list",
        data: [
          { id: "qwen3.6-35b-a3b", object: "model" },
          { id: "bge-m3", object: "model" },
        ],
      }),
    ).toEqual(["qwen3.6-35b-a3b", "bge-m3"]);
  });

  it("returns nothing rather than throwing on a shape it does not recognise", () => {
    expect(parseModelsResponse(null)).toEqual([]);
    expect(parseModelsResponse({})).toEqual([]);
    expect(parseModelsResponse({ data: "nope" })).toEqual([]);
    expect(parseModelsResponse({ data: [{ nope: 1 }, { id: "" }] })).toEqual([]);
  });
});

describe("parsePropsResponse", () => {
  it("prefers the top-level n_ctx over the per-slot one", () => {
    // `default_generation_settings.n_ctx` is total/n_parallel on a multi-slot server,
    // which is not the window a caller budgeting one request cares about.
    expect(
      parsePropsResponse({ n_ctx: 131072, default_generation_settings: { n_ctx: 32768 } })
        .contextWindow,
    ).toBe(131072);
  });

  it("falls back to the per-slot n_ctx when there is no top-level one", () => {
    expect(
      parsePropsResponse({ default_generation_settings: { n_ctx: 16384 } }).contextWindow,
    ).toBe(16384);
  });

  it("reports an unknown window as undefined rather than guessing", () => {
    expect(parsePropsResponse({}).contextWindow).toBeUndefined();
    expect(parsePropsResponse(null).contextWindow).toBeUndefined();
    expect(parsePropsResponse({ n_ctx: "16384" }).contextWindow).toBeUndefined();
    expect(parsePropsResponse({ n_ctx: 0 }).contextWindow).toBeUndefined();
    expect(parsePropsResponse({ n_ctx: -1 }).contextWindow).toBeUndefined();
  });

  it("reads the model path when the server reports one", () => {
    expect(parsePropsResponse({ model_path: "/models/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf" })).toEqual({
      modelPath: "/models/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf",
    });
  });
});
