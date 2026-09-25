import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Every tool returns structured JSON text, pretty-printed so a human reading a transcript can too. */
export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/**
 * Turns a thrown error into an MCP tool error result instead of letting it crash the server. The
 * known error types this project throws (`ProjectError`, core's `EditError` and
 * `NotImplementedError`, schema's `SchemaError`) all carry a message written for whoever is
 * holding the file; anything else is reported by its message too, since a stack trace is not
 * useful to an agent reading a tool result.
 */
export function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Wraps a tool handler so anything it throws becomes a tool error result instead of crashing the server. */
export function guarded<Args extends unknown[]>(
  handler: (...args: Args) => Promise<CallToolResult> | CallToolResult,
): (...args: Args) => Promise<CallToolResult> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return errorResult(error);
    }
  };
}
