export const STUDIO_TRANSCRIPT_STATUS_CHANNEL = 'studio:transcript-status'

export type StudioTranscriptStatusState = 'pending' | 'available' | 'unavailable'

export interface StudioTranscriptStatus {
  schemaVersion: 1
  assetId: string
  state: StudioTranscriptStatusState
  code: string | null
  message: string
  updatedAt: number
}

export function isStudioTranscriptStatus(value: unknown): value is StudioTranscriptStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const status = value as Partial<StudioTranscriptStatus>
  return (
    status.schemaVersion === 1 &&
    typeof status.assetId === 'string' &&
    status.assetId.length >= 1 &&
    status.assetId.length <= 128 &&
    (status.state === 'pending' ||
      status.state === 'available' ||
      status.state === 'unavailable') &&
    (status.code === null ||
      (typeof status.code === 'string' && status.code.length >= 1 && status.code.length <= 64)) &&
    typeof status.message === 'string' &&
    status.message.length >= 1 &&
    status.message.length <= 512 &&
    typeof status.updatedAt === 'number' &&
    Number.isSafeInteger(status.updatedAt) &&
    status.updatedAt >= 0
  )
}
