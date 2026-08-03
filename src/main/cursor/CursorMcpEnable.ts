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

export interface CursorMcpReadyProbeInput {
  readonly serverName: string
  readonly signal?: AbortSignal
  readonly killGraceMs?: number
  readonly launch: (
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => CursorMcpEnableChild
}

interface CursorMcpCommandInput {
  readonly signal?: AbortSignal
  readonly killGraceMs?: number
  readonly launch: (
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => CursorMcpEnableChild
  readonly failureMessage: (error: Error, stdout: string, stderr: string) => string
}

const ANSI_ESCAPE_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g')

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_SEQUENCE, '')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function cursorMcpListReportsReady(output: string, serverName: string): boolean {
  const clean = stripAnsi(output)
  return new RegExp(`(?:^|\\n)\\s*${escapeRegExp(serverName)}\\s*:\\s*ready(?:\\s|$)`, 'i').test(
    clean
  )
}

function runCursorMcpCommand(
  input: CursorMcpCommandInput
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  if (input.signal?.aborted) {
    return Promise.reject(new CursorWorkspaceConfigLeaseAbortedError())
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let aborted = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let child: CursorMcpEnableChild | undefined

    const finish = (
      error?: Error,
      output?: { readonly stdout: string; readonly stderr: string }
    ): void => {
      if (settled) return
      settled = true
      if (killTimer) clearTimeout(killTimer)
      input.signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(output ?? { stdout: '', stderr: '' })
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
      child = input.launch((error, stdout, stderr) => {
        if (aborted) {
          finish(new CursorWorkspaceConfigLeaseAbortedError())
          return
        }
        if (error) {
          finish(new Error(input.failureMessage(error, stdout, stderr)))
          return
        }
        finish(undefined, { stdout, stderr })
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

/**
 * Run Cursor's one-shot MCP approval helper without releasing its surrounding
 * configuration leases until the exact helper process has terminated.
 *
 * Cancellation requests SIGTERM, escalates to SIGKILL after a bounded grace
 * period, and settles only when either the child close event or exec callback
 * acknowledges process termination.
 */
export async function runCursorMcpEnable(input: CursorMcpEnableInput): Promise<void> {
  await runCursorMcpCommand({
    signal: input.signal,
    killGraceMs: input.killGraceMs,
    launch: (callback) =>
      input.launch((error, stderr) => {
        callback(error, '', stderr)
      }),
    failureMessage: (error, _stdout, stderr) => {
      const detail = (stderr.trim() || error.message || '').slice(0, 300)
      return `cursor-agent mcp enable ${input.serverName} failed${detail ? `: ${detail}` : ''}`
    }
  })
}

export async function runCursorMcpReadyProbe(input: CursorMcpReadyProbeInput): Promise<void> {
  const output = await runCursorMcpCommand({
    signal: input.signal,
    killGraceMs: input.killGraceMs,
    launch: input.launch,
    failureMessage: (error, stdout, stderr) => {
      const detail = (stderr.trim() || stdout.trim() || error.message || '').slice(0, 300)
      return `cursor-agent mcp list failed while checking ${input.serverName}${
        detail ? `: ${detail}` : ''
      }`
    }
  })
  const combined = `${output.stdout}\n${output.stderr}`
  if (!cursorMcpListReportsReady(combined, input.serverName)) {
    const detail = stripAnsi(combined).trim().slice(0, 300)
    throw new Error(
      `Cursor MCP server ${input.serverName} is not ready for this run${
        detail ? `: ${detail}` : ''
      }`
    )
  }
}
