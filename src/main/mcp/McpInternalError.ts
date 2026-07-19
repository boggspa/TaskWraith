/**
 * Provider-visible classification for an unexpected MCP bridge failure.
 * Never append a caught exception message here: it may contain host paths,
 * tokens, command lines, or other main-process diagnostics.
 */
export const MCP_UNEXPECTED_INTERNAL_ERROR_CODE = -32603
export const MCP_UNEXPECTED_INTERNAL_ERROR_MESSAGE =
  'TaskWraith MCP bridge encountered an unexpected internal error.'

export function mcpUnexpectedInternalError(id: unknown): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code: MCP_UNEXPECTED_INTERNAL_ERROR_CODE,
      message: MCP_UNEXPECTED_INTERNAL_ERROR_MESSAGE
    }
  }
}
