/**
 * WS-B: registers the MCP server's in-memory CompressionService stub against
 * the frozen contract harness (encouraged by the WS-B brief) so the stub is
 * guaranteed to behave like the real WS-A implementation will.
 */

import { InMemoryCompressionService } from "../../src/mcp/stub-compression.js";
import { describeCompressionServiceContract } from "./compression-contract.js";

describeCompressionServiceContract(
  "InMemoryCompressionService (src/mcp stub)",
  () => new InMemoryCompressionService(),
);
