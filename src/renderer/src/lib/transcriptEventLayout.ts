import type { ChatMessage, ChatRun } from '../../../main/store/types'
import { isEnsembleParticipantAuthoredMessage } from '../../../shared/ensembleParticipantMessage'

interface LayoutRow {
  rowKey: string
  msg: ChatMessage
}

/** Layout uses the complete projected list, before virtualization. A row
 * entering the viewport must not acquire a second speaker heading. */
export function transcriptSpeakerContinuations(
  rows: readonly LayoutRow[],
  runs: readonly ChatRun[],
  hiddenRowKeys: ReadonlySet<string>,
  headerMessages: ReadonlyMap<string, ChatMessage> = new Map()
): Set<string> {
  const runsById = new Map(runs.map((run) => [run.runId, run]))
  const continuations = new Set<string>()
  let previousSpeaker: string | null = null
  for (const row of rows) {
    if (hiddenRowKeys.has(row.rowKey)) continue
    const message = headerMessages.get(row.rowKey) || row.msg
    const metadata = message.metadata
    const isActivity = message.role === 'tool' && (message.toolActivities?.length || 0) > 0
    const isSpeaker =
      message.role === 'assistant' ||
      isActivity ||
      isEnsembleParticipantAuthoredMessage(message) ||
      metadata?.kind === 'ensembleParticipantStatus'
    if (!isSpeaker) {
      // App-authored updates don't hand the foreground seat to someone else.
      // A user contribution, error, or distinct conversation card does.
      if (message.role !== 'system' || metadata?.kind === 'ensembleRoundHeader') {
        previousSpeaker = null
      }
      continue
    }
    const run = message.runId ? runsById.get(message.runId) : undefined
    const rawSnapshot = metadata?.ensembleSeatSnapshot || run?.ensembleSeatSnapshot
    const snapshot =
      rawSnapshot && typeof rawSnapshot === 'object'
        ? (rawSnapshot as Record<string, unknown>)
        : undefined
    const activityMetadata = message.toolActivities?.find((activity) => activity.metadata)?.metadata
    const participantId =
      metadata?.ensembleParticipantId ||
      run?.ensembleParticipantId ||
      activityMetadata?.ensembleParticipantId ||
      ''
    const speaker = JSON.stringify([
      // A run owns both prose and activity even when the provider stamps
      // richer attribution onto one of them. Older unkeyed history falls
      // back to a seat id, then the frozen provider/model identity.
      message.runId || participantId || '',
      metadata?.ensembleLaneId || run?.ensembleLaneId || '',
      metadata?.pooledAgentId || '',
      metadata?.guestChatId || '',
      message.runId || participantId
        ? ''
        : metadata?.ensembleProvider ||
          snapshot?.provider ||
          run?.provider ||
          activityMetadata?.ensembleProvider ||
          activityMetadata?.provider ||
          metadata?.assistantProvider ||
          '',
      message.runId || participantId
        ? ''
        : metadata?.ensembleRole || snapshot?.role || run?.ensembleRole || '',
      message.runId || participantId
        ? ''
        : metadata?.ensembleModel ||
          snapshot?.model ||
          metadata?.providerModel ||
          run?.actualModel ||
          run?.requestedModel ||
          ''
    ])
    if (speaker === previousSpeaker) continuations.add(row.rowKey)
    previousSpeaker = speaker
  }
  return continuations
}

export type SeatChangeStackPosition = 'start' | 'middle' | 'end'

/** Join adjacent configuration events visually, retaining every original row
 * key, disclosure, footer action and jump target. Brief/toggle changes use the
 * same seatChange payload. Any intervening event ends the stack. */
export function adjacentSeatChangeStacks(
  messages: readonly ChatMessage[]
): Map<string, SeatChangeStackPosition> {
  const positions = new Map<string, SeatChangeStackPosition>()
  let start = 0
  while (start < messages.length) {
    if (!messages[start].metadata?.seatChange) {
      start += 1
      continue
    }
    let end = start + 1
    while (end < messages.length && messages[end].metadata?.seatChange) end += 1
    if (end - start > 1) {
      for (let index = start; index < end; index += 1) {
        positions.set(
          messages[index].id,
          index === start ? 'start' : index === end - 1 ? 'end' : 'middle'
        )
      }
    }
    start = end
  }
  return positions
}
