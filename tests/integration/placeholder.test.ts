/**
 * Integration suite placeholder — owned by WS-A (agent-proxy, task A1).
 *
 * Real content: proxy round-trip tests against recorded Anthropic API shapes,
 * including SSE streaming (message_start / content_block_delta subtypes incl.
 * input_json_delta, thinking_delta, signature_delta / message_stop / ping /
 * error), tool-use and tool_reference blocks, asserting byte-faithful
 * passthrough at slider level <= 1 (verification-notes.md §15).
 */

import { describe, it } from "vitest";

describe("proxy recorded shapes", () => {
  it.skip("pending — WS-A task A1 provides recorded-shape proxy tests", () => {});
});
