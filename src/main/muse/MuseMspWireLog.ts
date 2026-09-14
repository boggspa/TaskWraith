/**
 * Durable MSP wire diagnostics.
 *
 * The 2026-09-14 push blackout (responses ACKed, every notification lost, turn
 * gating invisibly behind an approval card that could never exist) was
 * undiagnosable after the fact because production wired nothing to the
 * client's `onRawFrame`/`onWireObservation` hooks and the two drop classes —
 * unparsable lines, unknown notification methods — left no trace. This sink
 * closes that gap: one JSONL file per run, ALWAYS carrying the cheap
 * metadata events (open/close, unparsable bytes, unknown methods, tripwire
 * firings, per-kind close-time counters) and carrying every raw frame only
 * when TASKWRAITH_MUSE_MSP_DEBUG is set, since a busy turn can mean thousands
 * of item deltas.
 *
 * Hard rules, in order:
 *
 * - Diagnostics never kill the lane. Every filesystem failure is swallowed;
 *   a missing wire log must never cancel a turn the user is paying for.
 * - The log is payload-adjacent, not secret-safe: serialized lines pass
 *   through the caller's `redact` (MuseMspRun wires
 *   `redactMuseMspSecrets`) because Muse error text can quote its MCP server
 *   block back at us, token included.
 * - Counters and observations are payload-free by construction; only the
 *   verbose frame stream can carry transcript content, and it is opt-in.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { MuseMspWireObservation } from './MuseMspClient'

export const MUSE_MSP_WIRE_LOG_DEBUG_ENV = 'TASKWRAITH_MUSE_MSP_DEBUG'

/** Default cap on the verbose frame stream; metadata events ignore it. */
export const MUSE_MSP_WIRE_LOG_MAX_BYTES = 8 * 1024 * 1024

export interface MuseMspWireLogSink {
  /** Mirrors `MuseMspTurnOptions.onRawFrame`; frames recorded only in verbose. */
  readonly onRawFrame: (direction: 'in' | 'out', frame: unknown) => void
  /** Mirrors `MuseMspTurnOptions.onWireObservation`; always recorded. */
  readonly observe: (observation: MuseMspWireObservation) => void
  /** Writes the close event. Idempotent. */
  readonly close: () => void
}

export interface MuseMspWireLogOptions {
  /** Existing or creatable directory; the file `<runId>.jsonl` lives inside. */
  readonly dir: string
  readonly runId: string
  readonly sessionId?: string | null
  /** Applied to every serialized line BEFORE it hits disk. Never throws. */
  readonly redact?: (text: string) => string
  /** Record every raw frame. Defaults to the debug env flag. */
  readonly verbose?: boolean
  /** Cap for the verbose frame stream. Metadata events are exempt. */
  readonly maxBytes?: number
  readonly now?: () => number
}

export function museMspWireLogDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = String(env[MUSE_MSP_WIRE_LOG_DEBUG_ENV] || '').toLowerCase()
  return flag === '1' || flag === 'true' || flag === 'yes'
}

export function createMuseMspWireLog(options: MuseMspWireLogOptions): MuseMspWireLogSink {
  const now = options.now ?? (() => Date.now())
  const redact = options.redact ?? ((text: string): string => text)
  const verbose = options.verbose ?? museMspWireLogDebugEnabled()
  const maxBytes =
    options.maxBytes !== undefined && Number.isFinite(options.maxBytes) && options.maxBytes >= 0
      ? options.maxBytes
      : MUSE_MSP_WIRE_LOG_MAX_BYTES
  const path = join(options.dir, `${options.runId}.jsonl`)
  let ensured = false
  let closed = false
  let frameBytes = 0

  const write = (record: Record<string, unknown>, essential: boolean): void => {
    if (closed) return
    if (!essential && verbose && frameBytes >= maxBytes) return
    let line: string
    try {
      line = redact(
        JSON.stringify({
          ts: new Date(now()).toISOString(),
          runId: options.runId,
          ...record
        })
      )
    } catch {
      // A frame that cannot serialize (circular, exotic) must not take the
      // lane down; the observation stream has already counted its kind.
      return
    }
    try {
      if (!ensured) {
        mkdirSync(options.dir, { recursive: true })
        ensured = true
      }
      appendFileSync(path, `${line}\n`)
      if (!essential) frameBytes += line.length + 1
    } catch {
      /* diagnostics never kill the lane */
    }
  }

  write(
    {
      event: 'open',
      verbose,
      ...(options.sessionId ? { sessionId: options.sessionId } : {})
    },
    true
  )

  return {
    onRawFrame: (direction, frame) => {
      if (!verbose) return
      write({ event: 'frame', direction, frame }, false)
    },
    observe: (observation) => {
      write({ event: 'observation', observation }, true)
    },
    close: () => {
      if (closed) return
      write({ event: 'close' }, true)
      closed = true
    }
  }
}
