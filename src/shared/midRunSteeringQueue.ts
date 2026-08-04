export const SOLO_STEER_TRANSCRIPT_PREPARATION = 'solo_steer_transcript_barrier' as const

export type SoloSteerTranscriptPreparation = typeof SOLO_STEER_TRANSCRIPT_PREPARATION

const MID_RUN_QUEUED_MESSAGE_PREFIX = 'midrun-queued-user-'

export function midRunQueuedMessageId(runId: string): string {
  return `${MID_RUN_QUEUED_MESSAGE_PREFIX}${runId}`
}
