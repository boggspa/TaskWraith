import type { TranscriptMediaRef } from '../../../main/store/types'

/**
 * Merge two media-ref lists, de-duplicating by content/identity key
 * (sha256 -> assetId -> id). This mirrors the main-process merge behavior so
 * renderer-side streamed refs do not double up before persistence catches up.
 */
export function mergeTranscriptMediaRefs(
  existing: readonly TranscriptMediaRef[] | undefined,
  incoming: readonly TranscriptMediaRef[]
): TranscriptMediaRef[] {
  const refs: TranscriptMediaRef[] = []
  const seen = new Set<string>()
  for (const ref of [...(existing || []), ...incoming]) {
    const key = ref.sha256 || ref.assetId || ref.id
    if (!key || seen.has(key)) continue
    seen.add(key)
    refs.push(ref)
  }
  return refs
}
