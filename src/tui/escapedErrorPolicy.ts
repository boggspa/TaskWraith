/**
 * Policy for an error that escaped every in-TUI handler and reached a
 * process-level listener.
 *
 * Those listeners are a real safety net rather than an oversight: `stop()`
 * restores raw mode and leaves the alternate screen, so a session that never
 * tears down is worse than one that ends — it hands back a terminal with echo
 * off. This module does not remove the net. It decides what deserves it.
 *
 * The detail that turns the net into a bug is that `stop()` latches
 * `stopped = true`, and `scheduleReconnect` returns early once that is set.
 * Tearing down for a dropped Host socket therefore destroys the exact recovery
 * path that already handles it — the reconnect loop backs off, retries, and
 * already shows the user a warning — so a transport blip ended the whole
 * session while the TUI was entirely capable of riding it out. That is the
 * "randomly fails when there is nothing evidently wrong" shape.
 *
 * Classification is fail-closed: anything not positively recognised as a
 * transport failure keeps the old behaviour, because a wrongly "recoverable"
 * error leaves a TUI running in an unknown state, which is harder to diagnose
 * than an honest exit.
 */

export type TuiEscapedErrorKind = 'exception' | 'rejection'

export type TuiEscapedErrorDisposition = 'fatal' | 'recoverable'

/**
 * Transport failures the reconnect loop already owns. Deliberately narrow:
 * codes like `ENOENT` are excluded because they are not specific to the Host
 * socket and would silently widen the recoverable set to ordinary bugs.
 */
const RECOVERABLE_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTCONN',
  'EPIPE',
  'ETIMEDOUT',
  'ERR_SOCKET_CLOSED',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END'
])

/** Transport code carried directly or wrapped one or two `cause` levels down. */
function recoverableTransportCode(reason: unknown, depth = 0): string | undefined {
  if (depth > 2 || typeof reason !== 'object' || reason === null) return undefined
  const code = (reason as { code?: unknown }).code
  if (typeof code === 'string' && RECOVERABLE_TRANSPORT_CODES.has(code)) return code
  return recoverableTransportCode((reason as { cause?: unknown }).cause, depth + 1)
}

export function classifyTuiEscapedError(
  kind: TuiEscapedErrorKind,
  reason: unknown
): TuiEscapedErrorDisposition {
  // An uncaught exception unwound the stack at an arbitrary point, so whatever
  // state it abandoned mid-update is unknown and resuming is unsafe however
  // recognisable the error looks. A rejection nobody awaited leaves the
  // synchronous world intact, so only that path is eligible to survive.
  if (kind === 'exception') return 'fatal'
  return recoverableTransportCode(reason) ? 'recoverable' : 'fatal'
}

export interface TuiEscapedErrorHandlerIo {
  readonly stopTui: () => void
  readonly writeStderr: (line: string) => void
  readonly setExitCode: (code: number) => void
}

/**
 * Build the process-listener body. Register it with `on` rather than `once`:
 * a recoverable event must not consume the net and leave the next escaped
 * error to Node's default hard crash. The teardown keeps its own latch so the
 * fatal path still runs exactly once.
 */
export function createTuiEscapedErrorHandler(
  io: TuiEscapedErrorHandlerIo
): (kind: TuiEscapedErrorKind, reason: unknown) => void {
  let tornDown = false
  return (kind, reason) => {
    if (classifyTuiEscapedError(kind, reason) === 'recoverable') {
      // Nothing is written here deliberately. The alternate screen is live, so
      // a stray stderr line punches a hole through the frame the TUI is
      // drawing; the reconnect loop owns the user-visible half of this.
      return
    }
    if (tornDown) return
    tornDown = true
    const label = kind === 'exception' ? 'unexpected error' : 'unexpected rejection'
    const detail = reason instanceof Error ? reason.message : String(reason)
    io.stopTui()
    io.writeStderr(`TaskWraith TUI: ${label} — ${detail}\n`)
    io.setExitCode(1)
  }
}
