export const TRANSCRIPT_MEDIA_GROUP_KINDS = [
  'video_frames',
  'audio_segment',
  'appshots',
  'appwatch_frames'
] as const

export type TranscriptMediaGroupKind = (typeof TRANSCRIPT_MEDIA_GROUP_KINDS)[number]

export const TEMPORAL_FRAME_GROUP_KINDS = ['video_frames', 'appshots', 'appwatch_frames'] as const

export type TemporalFrameGroupKind = (typeof TEMPORAL_FRAME_GROUP_KINDS)[number]

export const TRANSCRIPT_FRAME_SET_GROUP_KINDS = ['appshots', 'appwatch_frames'] as const

export type TranscriptFrameSetGroupKind = (typeof TRANSCRIPT_FRAME_SET_GROUP_KINDS)[number]

const transcriptMediaGroupKinds = new Set<string>(TRANSCRIPT_MEDIA_GROUP_KINDS)
const temporalFrameGroupKinds = new Set<string>(TEMPORAL_FRAME_GROUP_KINDS)
const transcriptFrameSetGroupKinds = new Set<string>(TRANSCRIPT_FRAME_SET_GROUP_KINDS)

export function isTranscriptMediaGroupKind(value: unknown): value is TranscriptMediaGroupKind {
  return typeof value === 'string' && transcriptMediaGroupKinds.has(value)
}

export function isTemporalFrameGroupKind(value: unknown): value is TemporalFrameGroupKind {
  return typeof value === 'string' && temporalFrameGroupKinds.has(value)
}

export function isTranscriptFrameSetGroupKind(
  value: unknown
): value is TranscriptFrameSetGroupKind {
  return typeof value === 'string' && transcriptFrameSetGroupKinds.has(value)
}

export function transcriptMediaRefDedupKey(ref: {
  id?: string
  sha256?: string
  assetId?: string
  groupKind?: string
}): string {
  if (isTemporalFrameGroupKind(ref.groupKind) && ref.id) return ref.id
  return ref.sha256 || ref.assetId || ref.id || ''
}
