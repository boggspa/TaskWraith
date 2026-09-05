import type { ChatMessage, ConcurrentLane, EnsembleParticipant } from '../store/types'

/**
 * Timeline identity, ordering, and append helpers extracted from
 * EnsembleOrchestrator. Canonical ActiveParticipantRun and
 * ParticipantTimelineEntry types remain in the monolith. This module accepts a
 * structural run shape so it does not import the 23k-line orchestrator (avoids
 * a runtime/type cycle). No ordering, merge, or id-generation change.
 */

/** Mirrors ParticipantTimelineEntry in EnsembleOrchestrator (canonical type stays there). */
type TimelineEntry = { kind: 'content'; text: string } | { kind: 'tool'; toolId: string }

/** Structural run subset of ActiveParticipantRun used by timeline ordering/append helpers. */
export type TimelineOrderingRun = {
  runId: string
  roundId: string
  assistantMessageId: string
  laneId?: string
  laneIntent?: ConcurrentLane['intent']
  fanoutWaveId?: string
  fanoutLabel?: string
  fanoutCategory?: 'user' | 'orchestrated'
  participant: Pick<EnsembleParticipant, 'id'> & { order?: number }
  timeline?: TimelineEntry[]
  forceNextTimelineContentEntry?: boolean
}

/** Stable per-timeline-entry message id. Includes the runId + the
 * entry's ordinal so the same entry always resolves to the same id
 * across flush passes, letting `flushRun` replace-in-place rather
 * than emit duplicates. */
export function timelineMessageId(runId: string, index: number, kind: 'content' | 'tool'): string {
  return `ensemble-${kind}-${runId}-${index}`
}

export function laneTranscriptMetadata(run: TimelineOrderingRun): {
  ensembleLaneId?: string
  ensembleLaneIntent?: ConcurrentLane['intent']
  ensembleFanoutWaveId?: string
  ensembleFanoutLabel?: string
  ensembleFanoutCategory?: 'user' | 'orchestrated'
} {
  return run.laneId
    ? {
        ensembleLaneId: run.laneId,
        ensembleLaneIntent: run.laneIntent || 'read',
        ...(run.fanoutWaveId ? { ensembleFanoutWaveId: run.fanoutWaveId } : {}),
        ...(run.fanoutLabel ? { ensembleFanoutLabel: run.fanoutLabel } : {}),
        ...(run.fanoutCategory ? { ensembleFanoutCategory: run.fanoutCategory } : {})
      }
    : {}
}

function messageLaneOrder(message: ChatMessage): number {
  const order = message.metadata?.ensembleOrder
  return typeof order === 'number' && Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER
}

function messageLaneParticipantId(message: ChatMessage): string {
  const participantId = message.metadata?.ensembleParticipantId
  return typeof participantId === 'string' ? participantId : ''
}

function messageLaneId(message: ChatMessage): string {
  const laneId = message.metadata?.ensembleLaneId
  return typeof laneId === 'string' ? laneId : ''
}

function compareRunLaneToMessage(run: TimelineOrderingRun, message: ChatMessage): number {
  const orderDelta = (run.participant.order ?? Number.MAX_SAFE_INTEGER) - messageLaneOrder(message)
  if (orderDelta !== 0) return orderDelta
  const participantDelta = run.participant.id.localeCompare(messageLaneParticipantId(message))
  if (participantDelta !== 0) return participantDelta
  return (run.laneId || '').localeCompare(messageLaneId(message))
}

function isComparableFanoutTimelineMessage(
  message: ChatMessage,
  run: TimelineOrderingRun
): boolean {
  if (message.metadata?.ensembleRoundId !== run.roundId) return false
  // Participant order is meaningful only inside one dispatch wave. Sorting a
  // later low-order seat against an older wave can hoist its first fragment
  // above the durable receipt that explains why the lane exists.
  if (message.metadata?.ensembleFanoutWaveId !== run.fanoutWaveId) return false
  const laneId = messageLaneId(message)
  if (!laneId || laneId === run.laneId) return false
  if (message.role !== 'assistant' && message.role !== 'tool') return false
  return (
    message.metadata?.kind === 'ensembleParticipant' ||
    message.metadata?.kind === 'ensembleParticipantTools'
  )
}

function isRoundLaneTimelineMessage(message: ChatMessage, roundId: string): boolean {
  if (message.metadata?.ensembleRoundId !== roundId) return false
  if (!messageLaneId(message)) return false
  if (message.role !== 'assistant' && message.role !== 'tool') return false
  return (
    message.metadata?.kind === 'ensembleParticipant' ||
    message.metadata?.kind === 'ensembleParticipantTools'
  )
}

function isOpaqueRunTimelineMessage(message: ChatMessage): boolean {
  return (message.role === 'assistant' || message.role === 'tool') && Boolean(message.runId)
}

/** Start index of the transcript's TAIL lane cluster for this round: the
 * earliest index such that no non-lane run-timeline row (a serial
 * participant's rows, or any prior round's rows) appears at or after it.
 * System/status/prompt rows are transparent — lanes may slot around them.
 *
 * A lane's first-flush roster-order slot-in is confined to this cluster.
 * Matching a STALE lane row further up (e.g. a settled round-start recon
 * wave sitting above a still-streaming serial speaker) would hoist the
 * lane's whole report above the live speaker's message — the "fan-out
 * completion shoves the viewports above the current turn" jump. */
function tailLaneClusterStart(messages: ChatMessage[], roundId: string): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (isRoundLaneTimelineMessage(message, roundId)) continue
    if (isOpaqueRunTimelineMessage(message)) return i + 1
  }
  return 0
}

export function isRunTimelineMessage(message: ChatMessage, run: TimelineOrderingRun): boolean {
  if (message.runId !== run.runId) return false
  if (message.role !== 'assistant' && message.role !== 'tool') return false
  const stableId = typeof message.id === 'string' ? message.id : ''
  return (
    stableId.startsWith(`ensemble-content-${run.runId}-`) ||
    stableId.startsWith(`ensemble-tool-${run.runId}`) ||
    message.id === run.assistantMessageId
  )
}

export function runTimelineInsertionIndex(
  messages: ChatMessage[],
  desiredMessages: ChatMessage[],
  run: TimelineOrderingRun,
  preferredInsertionIndex: number | null = null,
  runDispatchOrder?: Map<string, number>
): number {
  if (desiredMessages.length === 0) return messages.length
  if (preferredInsertionIndex !== null) {
    return Math.max(0, Math.min(preferredInsertionIndex, messages.length))
  }
  if (!run.laneId) {
    // First flush of a serial participant: append at the tail, EXCEPT above
    // rows of same-round lanes dispatched AFTER this run started — i.e. the
    // fan-out it sourced. A Boss that calls ensemble_fanout before producing
    // visible output must not have its whole turn pinned below its own
    // lanes; every lane flush (most visibly the completion batch) would keep
    // piling in above the Boss's live message. Lanes dispatched BEFORE this
    // run (a settled recon wave) stay above it — that IS the chronology.
    if (!runDispatchOrder) return messages.length
    const ownDispatchIndex = runDispatchOrder.get(run.runId)
    if (ownDispatchIndex === undefined) return messages.length
    const insertionIndex = messages.findIndex((message) => {
      if (!isRoundLaneTimelineMessage(message, run.roundId)) return false
      const laneDispatchIndex = message.runId ? runDispatchOrder.get(message.runId) : undefined
      return laneDispatchIndex !== undefined && laneDispatchIndex > ownDispatchIndex
    })
    return insertionIndex < 0 ? messages.length : insertionIndex
  }
  // First flush of a fan-out lane: keep sibling lanes in participant order,
  // but only within the round's tail lane cluster so the slot-in can never
  // leapfrog a serial participant's already-rendered rows. The matching
  // dispatch receipt is also a hard lower bound: even a malformed sibling row
  // must not pull this lane above its own wave anchor.
  const dispatchAnchorIndex = run.fanoutWaveId
    ? messages.findIndex(
        (message) =>
          message.role === 'system' &&
          message.metadata?.kind === 'ensembleRoundStatus' &&
          message.metadata?.ensembleFanoutWaveId === run.fanoutWaveId
      )
    : -1
  const clusterStart = Math.max(
    tailLaneClusterStart(messages, run.roundId),
    dispatchAnchorIndex + 1
  )
  let insertionIndex = -1
  for (let i = clusterStart; i < messages.length; i += 1) {
    const message = messages[i]
    if (
      isComparableFanoutTimelineMessage(message, run) &&
      compareRunLaneToMessage(run, message) < 0
    ) {
      insertionIndex = i
      break
    }
  }
  return insertionIndex < 0 ? messages.length : insertionIndex
}

/** Push a content fragment into the run's timeline, merging into
 * the last entry if it's also content. This is how the "speak,
 * tool, speak, tool" interleaving emerges — tools break the chunk;
 * consecutive content stays in one entry. */
export function appendTimelineContent(run: TimelineOrderingRun, text: string): void {
  if (!run.timeline) run.timeline = []
  const last = run.timeline[run.timeline.length - 1]
  if (!run.forceNextTimelineContentEntry && last && last.kind === 'content') {
    last.text += text
    return
  }
  run.forceNextTimelineContentEntry = false
  run.timeline.push({ kind: 'content', text })
}

/** Push a tool entry into the timeline. The toolActivities array
 * has been updated by the caller; this just records the position
 * where the activity falls in the chronology so the flush can
 * materialise the matching `role: 'tool'` message inline. */
export function appendTimelineTool(run: TimelineOrderingRun, toolId: string): void {
  if (!run.timeline) run.timeline = []
  run.timeline.push({ kind: 'tool', toolId })
}
