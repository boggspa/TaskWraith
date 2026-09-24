import type { ChatMessage } from '../../../main/store/types'
import { isRedundantEnsembleTranscriptNotice } from '../../../shared/ensembleTranscriptNoise'

/**
 * Drop routine Ensemble receipts from the DISPLAY list — after the round and
 * fan-out folds have run, never before.
 *
 * A fan-out dispatch receipt ("Locked writer fan-out · 2 participant(s)
 * dispatched concurrently …") is both a redundant notice and the anchor the
 * wave fold keys on: `collectEnsembleFanoutViewportGroups` recovers each wave
 * from its receipt and `buildEnsembleFanoutViewportRanges` emits the settled
 * one-liner in the receipt's place. Stripping receipts out of `visibleMessages`
 * (2026-09-01) starved the fold of every anchor, so all of a round's lanes fell
 * into one legacy group: nothing folded while any lane was still live (older
 * waves re-expanded into full cards), and once every lane settled the whole
 * round collapsed into the FIRST wave's one-liner while every later lane card
 * vanished. Filtering here keeps the receipt out of presentation while the fold
 * still sees it — a folded receipt has already become a viewport header (a
 * different kind) by the time this runs, so it survives untouched.
 *
 * Returns the input array itself when nothing is dropped so downstream memos
 * keep their referential stability.
 */
export function hideRedundantEnsembleTranscriptNotices(messages: ChatMessage[]): ChatMessage[] {
  let output: ChatMessage[] | null = null
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (isRedundantEnsembleTranscriptNotice(message)) {
      if (!output) output = messages.slice(0, index)
      continue
    }
    if (output) output.push(message)
  }
  return output ?? messages
}
