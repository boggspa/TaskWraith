/** A JSON-RPC request whose response boundary was not observed. The server may
 * have accepted the operation, so callers must not treat this as pre-start
 * rejection or terminal evidence. */
export class CodexAppServerRequestTimeoutError extends Error {
  readonly method: string

  constructor(method: string) {
    super(`Codex app-server request timed out: ${method}`)
    this.name = 'CodexAppServerRequestTimeoutError'
    this.method = method
  }
}

export function isCodexAppServerRequestTimeout(
  error: unknown,
  method?: string
): error is CodexAppServerRequestTimeoutError {
  return error instanceof CodexAppServerRequestTimeoutError && (!method || error.method === method)
}
