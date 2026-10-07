/**
 * A bounded, rolling record of what happened to main's Host connection.
 *
 * WHY. A sub-200 ms drop of the main<->Host projection socket blanked a
 * thread and failed a run, and the shipped app kept nothing that could show
 * it afterwards: Host stderr is drained and discarded after launch, broker
 * transport errors reach only the poison detector, and the client's
 * `disconnected` event had no listener. This log keeps those facts.
 *
 * WHAT. One JSON object per line: broker transport errors (code, operation,
 * clientId, connected), client connect / reconnect / unexpected disconnect /
 * Host-closing, lifecycle transitions (phase, reason, time spent in the
 * previous phase), and the redacted Host stderr tail when a launch fails.
 * Never prompt text, tokens, env or argv: every free-text field is redacted
 * and bounded before it is queued.
 *
 * BOUND. Two files, each capped at half of `maxEntries` and of `maxBytes`;
 * when the current file would overflow it is renamed over the previous one.
 * Together they never hold more than the bound, and the newest entries
 * always survive. No read-modify-write, so no compaction cost.
 *
 * OFF THE HOT PATH. Recording only queues a line; a single unref'd timer
 * batches writes through async fs, serialized on one chain. Nothing here can
 * throw into a caller or hold the process open, and a failed write drops its
 * batch rather than retrying. A synchronous flush runs once at process exit.
 */

import { appendFileSync, mkdirSync, promises as fsp, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { HostLifecycleSnapshot } from '../../shared/hostLifecycle'
import { redactProductOperationsText } from '../ProductOperations'
import type { HostLifecycleFailure } from './HostLifecycleController'
import type {
  HostProjectionClientEvent,
  HostProjectionTransportErrorReport
} from './HostProjectionBroker'

export const HOST_TRANSPORT_EVENT_LOG_DIRECTORY = 'diagnostics'
export const HOST_TRANSPORT_EVENT_LOG_FILE = 'host-transport-events.jsonl'
export const HOST_TRANSPORT_EVENT_LOG_PREVIOUS_FILE = 'host-transport-events.1.jsonl'
export const HOST_TRANSPORT_EVENT_LOG_MAX_ENTRIES = 2_000
export const HOST_TRANSPORT_EVENT_LOG_MAX_BYTES = 1024 * 1024
const ERROR_TEXT_MAX = 512
const STDERR_TAIL_MAX = 2_000
const IDENTIFIER_MAX = 128
const DEFAULT_FLUSH_DELAY_MS = 1_000

/** How HostExternalSupervisor appends the child's stderr tail to its error. */
const STDERR_MARKER = ' stderr: '

/** Runs before the crash-record patterns, which would eat `Authorization:` and leave the token. */
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi

const EXTRA_SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Environment assignments (`TASKWRAITH_HOST_TOKEN=...`): the value never survives.
  [/\b([A-Z][A-Z0-9_]{2,})=("[^"]*"|'[^']*'|\S+)/g, '$1=[redacted]'],
  // Long opaque tokens (hex, base64url, carrying a digit so long class names
  // such as HostProjectionHandshakeClosedBeforeWelcomeError survive).
  [/\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}\b/g, '[redacted]']
]

/** Redact, collapse control characters, and bound one free-text field. */
export function redactHostTransportText(
  value: unknown,
  maxChars: number,
  keep: 'head' | 'tail' = 'head'
): string {
  const raw = typeof value === 'string' ? value : value == null ? '' : String(value)
  let text = redactProductOperationsText(raw.replace(BEARER_PATTERN, 'Bearer [redacted]'))
  for (const [pattern, replacement] of EXTRA_SECRET_PATTERNS) {
    text = text.replace(pattern, replacement)
  }
  text = text.replace(/[^\S\n]+/g, ' ').trim()
  if (text.length <= maxChars) return text
  return keep === 'tail' ? text.slice(-maxChars) : text.slice(0, maxChars)
}

function identifier(value: unknown): string {
  return redactHostTransportText(value, IDENTIFIER_MAX)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : String(error ?? '')
}

export type HostTransportEvent =
  | {
      readonly kind: 'transport-error'
      readonly code: string
      readonly operation: string
      readonly clientId: string
      readonly connected: boolean
    }
  | { readonly kind: 'client-connected'; readonly clientId: string; readonly reconnect: boolean }
  | { readonly kind: 'client-disconnected'; readonly clientId: string; readonly error?: string }
  | { readonly kind: 'host-closing'; readonly clientId: string }
  | {
      readonly kind: 'lifecycle'
      readonly phase: string
      readonly desired: string
      readonly reason: string
      readonly from: string
      /** Time spent in `from` before this transition. */
      readonly durationMs: number
      readonly hostPid?: number
    }
  | {
      readonly kind: 'lifecycle-failure'
      readonly reason: string
      readonly error: string
      readonly stderrTail?: string
    }
  | { readonly kind: 'log-opened'; readonly appPid: number }

export interface HostLifecycleSource {
  getSnapshot(): HostLifecycleSnapshot
  subscribe(listener: (snapshot: HostLifecycleSnapshot) => void): () => void
}

export interface HostTransportEventLogOptions {
  readonly profilePath: string
  readonly now?: () => number
  readonly maxEntries?: number
  readonly maxBytes?: number
  readonly flushDelayMs?: number
}

export interface HostTransportEventLog {
  readonly path: string
  readonly previousPath: string
  transportError(report: HostProjectionTransportErrorReport): void
  clientEvent(event: HostProjectionClientEvent): void
  lifecycleFailure(failure: HostLifecycleFailure): void
  observeLifecycle(source: HostLifecycleSource): () => void
  record(event: HostTransportEvent): void
  /** Write everything queued so far; resolves even when the write failed. */
  flush(): Promise<void>
  /** Exit path: write what is still queued, synchronously. Never throws. */
  flushSync(): void
  dispose(): void
}

interface FileExtent {
  lines: number
  bytes: number
}

function extentOf(text: string): FileExtent {
  let lines = 0
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    lines += 1
  }
  return { lines, bytes: Buffer.byteLength(text) }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

export function createHostTransportEventLog(
  options: HostTransportEventLogOptions
): HostTransportEventLog {
  const now = options.now ?? (() => Date.now())
  const directory = join(options.profilePath, HOST_TRANSPORT_EVENT_LOG_DIRECTORY)
  const currentPath = join(directory, HOST_TRANSPORT_EVENT_LOG_FILE)
  const previousPath = join(directory, HOST_TRANSPORT_EVENT_LOG_PREVIOUS_FILE)
  const maxEntries = Math.max(
    2,
    Math.floor(options.maxEntries ?? HOST_TRANSPORT_EVENT_LOG_MAX_ENTRIES)
  )
  const maxBytes = Math.max(
    8 * 1024,
    Math.floor(options.maxBytes ?? HOST_TRANSPORT_EVENT_LOG_MAX_BYTES)
  )
  const fileEntries = Math.floor(maxEntries / 2)
  const fileBytes = Math.floor(maxBytes / 2)
  const flushDelayMs = Math.max(0, options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS)

  let pending: string[] = []
  let current: FileExtent | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let chain: Promise<void> = Promise.resolve()
  let disposed = false

  /** The newest queued lines that fit one file, oldest first. */
  const takeBatch = (): { lines: string[]; bytes: number } => {
    const queued = pending
    pending = []
    const kept: string[] = []
    let bytes = 0
    for (let index = queued.length - 1; index >= 0 && kept.length < fileEntries; index -= 1) {
      const size = Buffer.byteLength(queued[index])
      if (bytes + size > fileBytes) break
      bytes += size
      kept.push(queued[index])
    }
    return { lines: kept.reverse(), bytes }
  }

  const overflows = (extent: FileExtent, batch: { lines: string[]; bytes: number }): boolean =>
    extent.lines + batch.lines.length > fileEntries || extent.bytes + batch.bytes > fileBytes

  const writePending = async (): Promise<void> => {
    if (!pending.length) return
    const batch = takeBatch()
    if (!batch.lines.length) return
    try {
      await fsp.mkdir(directory, { recursive: true, mode: 0o700 })
      if (!current) {
        try {
          current = extentOf(await fsp.readFile(currentPath, 'utf8'))
        } catch (error) {
          if (!isMissing(error)) throw error
          current = { lines: 0, bytes: 0 }
        }
      }
      if (overflows(current, batch)) {
        try {
          await fsp.rename(currentPath, previousPath)
        } catch (error) {
          if (!isMissing(error)) throw error
        }
        current = { lines: 0, bytes: 0 }
      }
      await fsp.appendFile(currentPath, batch.lines.join(''), { mode: 0o600 })
      current = { lines: current.lines + batch.lines.length, bytes: current.bytes + batch.bytes }
    } catch {
      // Diagnosis only: drop this batch and re-measure the file next time.
      current = null
    }
  }

  const flush = (): Promise<void> => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    chain = chain.then(writePending, writePending)
    return chain
  }

  const schedule = (): void => {
    if (timer || disposed) return
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, flushDelayMs)
    ;(timer as { unref?: () => void }).unref?.()
  }

  const record = (event: HostTransportEvent): void => {
    try {
      if (disposed) return
      pending.push(`${JSON.stringify({ at: new Date(now()).toISOString(), ...event })}\n`)
      // Never queue more than one file can hold; the oldest go first.
      if (pending.length > fileEntries) pending.splice(0, pending.length - fileEntries)
      schedule()
    } catch {
      // Recording must never fail the caller.
    }
  }

  const flushSync = (): void => {
    try {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (!pending.length) return
      const batch = takeBatch()
      if (!batch.lines.length) return
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      let extent: FileExtent
      try {
        extent = extentOf(readFileSync(currentPath, 'utf8'))
      } catch (error) {
        if (!isMissing(error)) throw error
        extent = { lines: 0, bytes: 0 }
      }
      if (overflows(extent, batch)) {
        try {
          renameSync(currentPath, previousPath)
        } catch (error) {
          if (!isMissing(error)) throw error
        }
        extent = { lines: 0, bytes: 0 }
      }
      appendFileSync(currentPath, batch.lines.join(''), { mode: 0o600 })
      current = { lines: extent.lines + batch.lines.length, bytes: extent.bytes + batch.bytes }
    } catch {
      current = null
    }
  }

  return {
    path: currentPath,
    previousPath,
    record,
    flush,
    flushSync,
    transportError(report) {
      try {
        record({
          kind: 'transport-error',
          code: identifier(report?.code),
          operation: identifier(report?.operation),
          clientId: identifier(report?.clientId),
          connected: report?.connected === true
        })
      } catch {
        // Recording must never fail the caller.
      }
    },
    clientEvent(event) {
      try {
        const clientId = identifier(event?.clientId)
        if (event?.kind === 'connected') {
          record({ kind: 'client-connected', clientId, reconnect: event.reconnect === true })
        } else if (event?.kind === 'disconnected') {
          const error = event.error ? redactHostTransportText(event.error, ERROR_TEXT_MAX) : ''
          record({ kind: 'client-disconnected', clientId, ...(error ? { error } : {}) })
        } else if (event?.kind === 'host-closing') {
          record({ kind: 'host-closing', clientId })
        }
      } catch {
        // Recording must never fail the caller.
      }
    },
    lifecycleFailure(failure) {
      try {
        const message = errorMessage(failure?.error)
        const marker = message.indexOf(STDERR_MARKER)
        const head = marker === -1 ? message : message.slice(0, marker)
        const tail = marker === -1 ? '' : message.slice(marker + STDERR_MARKER.length)
        const stderrTail = tail ? redactHostTransportText(tail, STDERR_TAIL_MAX, 'tail') : ''
        record({
          kind: 'lifecycle-failure',
          reason: identifier(failure?.reason),
          error: redactHostTransportText(head, ERROR_TEXT_MAX),
          ...(stderrTail ? { stderrTail } : {})
        })
      } catch {
        // Recording must never fail the caller.
      }
    },
    observeLifecycle(source) {
      try {
        let previous = source.getSnapshot()
        return source.subscribe((snapshot) => {
          try {
            const elapsed = Date.parse(snapshot.changedAt) - Date.parse(previous.changedAt)
            record({
              kind: 'lifecycle',
              phase: identifier(snapshot.phase),
              desired: identifier(snapshot.desired),
              reason: identifier(snapshot.reason),
              from: identifier(previous.phase),
              durationMs: Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0,
              ...(typeof snapshot.host?.pid === 'number' ? { hostPid: snapshot.host.pid } : {})
            })
            previous = snapshot
          } catch {
            // Recording must never fail the lifecycle's listener loop.
          }
        })
      } catch {
        return () => undefined
      }
    },
    dispose() {
      disposed = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}

/**
 * Production wiring: one log per app process under the profile, flushed
 * synchronously at exit so the final transitions (app-quit) are kept.
 */
export function installHostTransportEventLog(profilePath: string): HostTransportEventLog {
  const log = createHostTransportEventLog({ profilePath })
  log.record({ kind: 'log-opened', appPid: process.pid })
  process.once('exit', () => log.flushSync())
  return log
}
