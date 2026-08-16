import type { TranscriptMediaRef } from '../../../main/store/types'
import { transcriptMediaRefDedupKey } from '../../../shared/transcriptMediaGrouping'

/**
 * Merge two media-ref lists. Ordinary refs de-duplicate by content identity;
 * temporal frames use occurrence identity so unchanged checkpoints survive.
 * This mirrors main-process behavior before persistence catches up.
 */
export function mergeTranscriptMediaRefs(
  existing: readonly TranscriptMediaRef[] | undefined,
  incoming: readonly TranscriptMediaRef[]
): TranscriptMediaRef[] {
  const refs: TranscriptMediaRef[] = []
  const seen = new Set<string>()
  for (const ref of [...(existing || []), ...incoming]) {
    const key = transcriptMediaRefDedupKey(ref)
    if (!key || seen.has(key)) continue
    seen.add(key)
    refs.push(ref)
  }
  return refs
}
