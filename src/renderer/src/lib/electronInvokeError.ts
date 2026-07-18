/**
 * Electron wraps a rejected invoke as
 * "Error invoking remote method '<channel>': Error: <real message>".
 * Strip only that transport framing so callers can present the underlying
 * validation failure.
 */
export function stripElectronInvokeErrorFraming(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const match = message.match(/^Error invoking remote method '[^']*': (?:Error: )?([\s\S]*)$/)
  return match?.[1]?.trim() ? match[1].trim() : message
}
