import { CursorWorkspaceConfigLeaseAbortedError } from './CursorWorkspaceConfigLease'

export const CURSOR_MCP_ENABLE_KILL_GRACE_MS = 4_000

export interface CursorMcpEnableChild {
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: 'close', listener: () => void): CursorMcpEnableChild
}

export interface CursorMcpEnableInput {
  readonly serverName: string
  readonly signal?: AbortSignal
  readonly killGraceMs?: number
  readonly launch: (callback: (error: Error | null, stderr: string) => void) => CursorMcpEnableChild
}

/**
 * Run Cursor's one-shot MCP approval helper without releasing its surrounding
 * configuration leases until the exact helper process has terminated.
 *
 * Cancellation requests SIGTERM, escalates to SIGKILL after a bounded grace
 * period, and settles only when either the child close event or exec callback
 * acknowledges process termination.
 */
export function runCursorMcpEnable(input: CursorMcpEnableInput): Promise<void> {
  if (input.signal?.aborted) {
    return Promise.reject(new CursorWorkspaceConfigLeaseAbortedError())
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false
    let aborted = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let child: CursorMcpEnableChild | undefined

    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (killTimer) clearTimeout(killTimer)
      input.signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve()
    }

    const abort = (): void => {
      if (settled || aborted) return
      aborted = true
      try {
        child?.kill('SIGTERM')
      } catch {
        // The exact close/callback acknowledgement below remains authoritative.
      }
      killTimer = setTimeout(() => {
        try {
          child?.kill('SIGKILL')
        } catch {
          // Continue waiting for the exact close/callback acknowledgement.
        }
      }, input.killGraceMs ?? CURSOR_MCP_ENABLE_KILL_GRACE_MS)
      killTimer.unref?.()
    }

    try {
      child = input.launch((error, stderr) => {
        if (aborted) {
          finish(new CursorWorkspaceConfigLeaseAbortedError())
          return
        }
        if (error) {
          const detail = (stderr.trim() || error.message || '').slice(0, 300)
          finish(
            new Error(
              `cursor-agent mcp enable ${input.serverName} failed${detail ? `: ${detail}` : ''}`
            )
          )
          return
        }
        finish()
      })
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
      return
    }

    if (settled) return
    child.once('close', () => {
      if (aborted) finish(new CursorWorkspaceConfigLeaseAbortedError())
    })
    input.signal?.addEventListener('abort', abort, { once: true })
    if (input.signal?.aborted) abort()
  })
}
