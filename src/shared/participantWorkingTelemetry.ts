import type { ProviderId } from '../main/store/types'

/**
 * Ephemeral, display-only usage telemetry for one active run — an Ensemble seat
 * (via `reportParticipantTokenUsage`) or a solo run (via
 * `SoloWorkingTokenTelemetry`). Solo events carry empty `roundId` /
 * `participantId`; consumers key everything on `runId`.
 *
 * These events intentionally never enter ChatRecord, run-event storage, or
 * provider transcripts. The working indicator and composer footer consume them
 * through a tiny renderer-side store, so frequent token snapshots do not replace
 * the chat or invalidate the transcript tree.
 */
export type ParticipantWorkingTelemetryEvent =
  | {
      type: 'snapshot'
      chatId: string
      roundId: string
      participantId: string
      runId: string
      startedAt: string
      provider: ProviderId
      inputTokens: number
      outputTokens: number
      totalTokens: number
      /** `false` means the provider supplied a normalized usage snapshot;
       * `true` means a chars÷4 stream estimate is riding this lane (Grok /
       * Cursor mid-stream, Kimi-ACP) — display surfaces keep the "≈". */
      estimated: boolean
    }
  | {
      type: 'clear'
      chatId: string
      roundId: string
      participantId: string
      runId: string
    }
