/**
 * Desktop Ensemble round_start span (Independent Threads Programme M1 A1.2).
 *
 * Composer send → first actual participant dispatch. Begin at round
 * reservation (`beginRound`); end at the first `onAdapterInvoked` callback,
 * not host-admission queue insertion and not persist-barrier completion.
 * One span per round: later participant/lane dispatches are no-ops.
 *
 * The sink is optional. Production reads the process recorder already
 * attached to Ensemble host admission; tests inject a recorder. A throwing
 * sink loses the measurement, never the dispatch.
 */

import type { WorkSpanRecordInput } from './WorkSpanRecorder'

export type EnsembleRoundStartSink = {
  record(span: WorkSpanRecordInput): void
}

export interface EnsembleRoundStartBegin {
  readonly chatId: string
  readonly roundId: string
  readonly startedAt: number
}

export interface EnsembleRoundStartDispatch {
  readonly runId: string
  readonly participantId?: string
  readonly laneId?: string
}

interface PendingRoundStart extends EnsembleRoundStartBegin {
  recorded: boolean
}

const pending = new WeakMap<object, PendingRoundStart>()

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function beginEnsembleRoundStart(runtime: object, begin: EnsembleRoundStartBegin): void {
  if (!runtime || typeof runtime !== 'object') return
  if (!isNonEmptyString(begin.chatId) || !isNonEmptyString(begin.roundId)) return
  if (
    typeof begin.startedAt !== 'number' ||
    !Number.isFinite(begin.startedAt) ||
    begin.startedAt < 0
  )
    return
  pending.set(runtime, { ...begin, recorded: false })
}

export function recordEnsembleRoundStartDispatch(
  runtime: object,
  dispatch: EnsembleRoundStartDispatch,
  sink: EnsembleRoundStartSink | undefined,
  now: () => number
): void {
  const state = pending.get(runtime)
  if (!state || state.recorded) return
  state.recorded = true
  if (!sink || !isNonEmptyString(dispatch.runId)) return
  let endedAt: number
  try {
    endedAt = now()
  } catch {
    return
  }
  if (typeof endedAt !== 'number' || !Number.isFinite(endedAt) || endedAt < 0) return
  try {
    sink.record({
      chatId: state.chatId,
      runId: dispatch.runId,
      ...(isNonEmptyString(dispatch.participantId)
        ? { participantId: dispatch.participantId }
        : {}),
      ...(isNonEmptyString(dispatch.laneId) ? { laneId: dispatch.laneId } : {}),
      kind: 'round_start',
      startedAt: state.startedAt,
      durationMs: Math.max(0, endedAt - state.startedAt)
    })
  } catch {
    // Instrumentation must never alter dispatch.
  }
}
