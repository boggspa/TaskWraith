/**
 * Stdio that can never take a Host down (Host-lifetime programme, S1a review F1).
 *
 * A Desktop-spawned Host is detached with stderr on a pipe that Electron main
 * drains only while main lives (`HostExternalSupervisor`); a TUI-spawned one
 * writes a log file; a hand-started one inherits a terminal that can close.
 * Once the reader is gone, the next write fails — EPIPE on the pipe, then
 * ERR_STREAM_DESTROYED — and Node raises the failure as an `'error'` event on
 * `process.stderr`. With no listener that is an uncaught exception: the Host
 * exits 1 mid-grace or mid-drain, skips its cleanup, orphans its provider
 * runs and leaves discovery, token and profile authority behind. The Host's
 * own lease lines fire exactly then (the app's socket closed, a relaunched
 * app connected, the grace ran out), so it would die on the very path its
 * lifetime depends on.
 *
 * Nothing a Host writes to stdout or stderr is worth its life. The CLI entry
 * installs this guard first, for the whole process lifetime, so every write in
 * the process is covered, not only the lease lines; `writeHostStderr` also
 * absorbs a synchronous throw from a sink that writes synchronously.
 */

/** The slice of a stdio stream the guard needs. */
export interface HostStdioStream {
  on(event: 'error', listener: (error: Error) => void): unknown
}

const guarded = new WeakSet<object>()

/**
 * Swallow every error either stdio stream raises from now on. Idempotent per
 * stream; the default guards this process's `stdout` and `stderr`.
 */
export function installHostStdioGuard(
  streams: readonly HostStdioStream[] = [process.stdout, process.stderr]
): void {
  for (const stream of streams) {
    if (guarded.has(stream)) continue
    guarded.add(stream)
    stream.on('error', () => {
      // The reader is gone; the Host is not. There is nowhere left to report
      // this, and a write that failed has nothing to retry.
    })
  }
}

/** Best-effort stderr line: a failed or throwing write is dropped, never raised. */
export function writeHostStderr(
  text: string,
  stream: { write(text: string): unknown } = process.stderr
): void {
  try {
    stream.write(text)
  } catch {
    // Same contract as the guard: stderr is diagnostics, not a lifeline.
  }
}
