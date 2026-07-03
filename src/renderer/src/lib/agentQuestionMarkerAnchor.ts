import type { ChatMessage } from '../../../main/store/types'

/**
 * The synthetic `ask_user_question` marker is a RENDERER-ONLY `role:'system'`
 * message (App.tsx `onAgentQuestionRequested`). Main never learns about it, so
 * it is not part of any run's timeline and is exempt from `EnsembleOrchestrator.
 * flushRun`, which continuously strips-and-re-tails each participant's own
 * assistant/tool content to the array end. The transcript render pipeline is
 * pure array-order (no timestamp/liveness sort), so once the live participant
 * keeps streaming, its re-tailed content lands AFTER the marker's frozen array
 * position — visually stranding the pending question card in an earlier "System"
 * block ABOVE the current speaker instead of at the live bottom.
 *
 * This pins every PENDING question marker to the live tail on each merge: given
 * the freshly merged message list, the live list (which may still hold a marker
 * an authoritative main snapshot dropped), and the set of currently-pending
 * marker ids, return a list where each pending marker is preserved and moved to
 * the tail in stable order. ANSWERED / historical markers are left in place, so
 * only the in-flight question floats down to where the user is looking.
 */
function isAgentQuestionMarker(message: ChatMessage): boolean {
  return (
    message.role === 'system' &&
    (message.metadata as Record<string, unknown> | undefined)?.kind === 'agentQuestion'
  )
}

export function anchorPendingAgentQuestionMarkers(
  mergedMessages: ChatMessage[],
  liveMessages: readonly ChatMessage[],
  pendingMarkerIds: ReadonlySet<string>
): ChatMessage[] {
  if (pendingMarkerIds.size === 0) return mergedMessages
  const isPendingMarker = (m: ChatMessage): boolean =>
    pendingMarkerIds.has(m.id) && isAgentQuestionMarker(m)

  const pendingInMerged = mergedMessages.filter(isPendingMarker)
  const mergedIds = new Set(mergedMessages.map((m) => m.id))
  // A marker main dropped from an authoritative snapshot survives only in the
  // live ref — re-append it so the pending card never vanishes mid-run.
  const pendingFromLive = liveMessages.filter(
    (m) => isPendingMarker(m) && !mergedIds.has(m.id)
  )
  const pendingMarkers = [...pendingInMerged, ...pendingFromLive]
  if (pendingMarkers.length === 0) return mergedMessages

  // Already exactly the trailing run and nothing to re-append? Preserve the
  // reference so the caller's render-equality short-circuit still fires.
  if (pendingFromLive.length === 0) {
    const tailStart = mergedMessages.length - pendingInMerged.length
    let alreadyTail = tailStart >= 0
    for (let i = tailStart; alreadyTail && i < mergedMessages.length; i += 1) {
      if (!isPendingMarker(mergedMessages[i])) alreadyTail = false
    }
    if (alreadyTail) return mergedMessages
  }

  const rest = mergedMessages.filter((m) => !isPendingMarker(m))
  return [...rest, ...pendingMarkers]
}
