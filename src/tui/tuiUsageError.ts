/**
 * A command-line usage error: the invocation itself was malformed (an unknown
 * flag, a missing value, an incompatible combination), as opposed to a runtime
 * failure (an unreachable Host, an unreadable file). The TUI entry point maps
 * this to exit code 2, matching the Host CLI's 2-vs-1 contract; every other
 * failure exits 1.
 */
export class TuiUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TuiUsageError'
  }
}
