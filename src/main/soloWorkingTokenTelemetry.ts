import type { ProviderId } from './store/types'
import type { ParticipantWorkingTelemetryEvent } from '../shared/participantWorkingTelemetry'
import { statsAreEstimated } from '../shared/tokenEstimate'

/** Match the EnsembleOrchestrator's working-telemetry cadence so solo and
 * ensemble seats tick the renderer at the same rate. */
export const SOLO_WORKING_TELEMETRY_MIN_INTERVAL_MS = 450

type SoloWorkingTokenRecord = {
  sentAt: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  estimated: boolean
}

function nonNegativeInteger(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0
}

function readCount(
  stats: Record<string, unknown> | null | undefined,
  keys: readonly string[]
): number {
  if (!stats) return 0
  for (const key of keys) {
    const value = nonNegativeInteger(stats[key])
    if (value > 0) return value
  }
  return 0
}

export interface SoloWorkingTokenReportParams {
  runId: string | undefined
  chatId?: string
  provider: ProviderId
  /** Wall-clock ms when the run started; converted to an ISO `startedAt`. */
  startedAtMs?: number
  /** Live, per-stream-event merged usage (`state.tokenUsage`). */
  stats: Record<string, unknown> | null | undefined
  /** Injected clock so the throttle stays deterministic under test. */
  nowMs: number
}

/**
 * Solo-run mirror of the EnsembleOrchestrator's participant working-telemetry
 * lane.
 *
 * Ensemble seats already stream authoritative live usage to the
 * `participant-working-telemetry` channel via `reportParticipantTokenUsage`.
 * Solo runs were never registered there, so their live `state.tokenUsage`
 * (already merged per stream-event in `handleCliProviderJsonEvent` /
 * `thread/tokenUsage/updated`) never reached the renderer until the run sealed
 * its `ChatRun.stats` at turn end — which is exactly why the composer footer's
 * output/cost only "settled" when a round ended.
 *
 * This registry emits the same ephemeral snapshots for solo runs: monotonic
 * per-field maxima, throttled to {@link SOLO_WORKING_TELEMETRY_MIN_INTERVAL_MS}.
 * It is purely a display lane — it never writes ChatRecord, run-event storage,
 * or provider transcripts. It is the single source of truth for "is this run
 * solo-tracked?", so {@link clear} self-gates: it only yields a `clear` event
 * for a run this registry actually reported, which keeps the exit hook from
 * ever touching an ensemble seat's snapshot.
 */
export class SoloWorkingTokenTelemetry {
  private readonly recordsByRunId = new Map<string, SoloWorkingTokenRecord>()

  /** Returns a `snapshot` event to broadcast, or `null` when nothing changed,
   * the value is still inside the throttle window, or there are no tokens yet. */
  report(params: SoloWorkingTokenReportParams): ParticipantWorkingTelemetryEvent | null {
    const { runId, provider, stats, nowMs } = params
    if (!runId || !stats || typeof stats !== 'object' || Array.isArray(stats)) return null

    const previous = this.recordsByRunId.get(runId)
    const inputTokens = Math.max(
      previous?.inputTokens || 0,
      readCount(stats, ['input_tokens', 'inputTokens'])
    )
    const outputTokens = Math.max(
      previous?.outputTokens || 0,
      readCount(stats, ['output_tokens', 'outputTokens'])
    )
    const totalTokens = Math.max(
      previous?.totalTokens || 0,
      readCount(stats, ['total_tokens', 'totalTokens']),
      inputTokens + outputTokens
    )
    if (inputTokens <= 0 && outputTokens <= 0 && totalTokens <= 0) return null

    // Estimated only while EVERY report so far was an estimate — the first
    // authoritative provider snapshot flips the run to authoritative for good
    // (a later estimate must never un-authorize it).
    const estimated = statsAreEstimated(stats) && (previous ? previous.estimated : true)

    const changed =
      !previous ||
      inputTokens !== previous.inputTokens ||
      outputTokens !== previous.outputTokens ||
      totalTokens !== previous.totalTokens ||
      estimated !== previous.estimated
    if (!changed) return null
    // Throttle WITHOUT recording, so the accumulated maxima survive to the next
    // post-window call (mirrors reportParticipantTokenUsage).
    if (previous && nowMs - previous.sentAt < SOLO_WORKING_TELEMETRY_MIN_INTERVAL_MS) return null

    this.recordsByRunId.set(runId, {
      sentAt: nowMs,
      inputTokens,
      outputTokens,
      totalTokens,
      estimated
    })
    return {
      type: 'snapshot',
      chatId: params.chatId || '',
      roundId: '',
      participantId: '',
      runId,
      startedAt:
        typeof params.startedAtMs === 'number' && Number.isFinite(params.startedAtMs)
          ? new Date(params.startedAtMs).toISOString()
          : '',
      provider,
      inputTokens,
      outputTokens,
      totalTokens,
      estimated
    }
  }

  /** Returns a `clear` event only when this registry actually tracked `runId`,
   * so callers can fire it on every run-exit and it no-ops for ensemble / never-
   * reported runs. */
  clear(runId: string | undefined): ParticipantWorkingTelemetryEvent | null {
    if (!runId) return null
    if (!this.recordsByRunId.delete(runId)) return null
    return { type: 'clear', chatId: '', roundId: '', participantId: '', runId }
  }

  /** Test-only: drop all tracked runs. */
  reset(): void {
    this.recordsByRunId.clear()
  }
}
