import type { ChatMessage } from '../../../main/store/types'
import {
  groupedTranscriptMessageIds,
  isEnsembleFanoutResultMessage
} from '../../../shared/fanoutLaneGrouping'
import type { TranscriptGroupedMessageRange } from './transcriptToolMessageGrouping'

export const ENSEMBLE_FANOUT_VIEWPORT_HEADER_KIND = 'ensembleFanoutViewportHeader'

export type EnsembleFanoutViewportStage =
  | 'scout'
  | 'work'
  | 'review'
  | 'background'
  | 'all'
  | 'specified'

export interface EnsembleFanoutViewportAttribution {
  participantId: string | null
  provider: string
  role: string | null
  model: string | null
}

export interface EnsembleFanoutViewportHeaderData {
  viewportId: string
  chatId: string
  roundId: string
  stage: EnsembleFanoutViewportStage
  /** Original durable status label that opened this dispatch wave, when known. */
  dispatchLabel: string | null
  expanded: boolean
  laneCount: number
  laneMessageIds: string[]
  attributions: EnsembleFanoutViewportAttribution[]
}

interface IndexedLaneMessage {
  message: ChatMessage
  index: number
}

interface MutableViewportGroup {
  anchorId: string
  anchorIndex: number
  dispatchLabel: string | null
  expectedLaneCount: number | null
  stage: EnsembleFanoutViewportStage
  lanes: IndexedLaneMessage[]
  laneIds: Set<string>
}

export interface EnsembleFanoutViewportGroup {
  viewportId: string
  chatId: string
  roundId: string
  stage: EnsembleFanoutViewportStage
  dispatchLabel: string | null
  lanes: IndexedLaneMessage[]
}

const FANOUT_DISPATCH_STATUS =
  /^(.*?) · (\d+) (?:participant\(s\)|read-only participants) dispatched concurrently\b/

function metadataString(message: ChatMessage, key: string): string | null {
  const value = message.metadata?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function stageFromDispatchLabel(label: string): EnsembleFanoutViewportStage {
  const normalized = label.trim().toLowerCase()
  if (normalized.includes('scout') || normalized === 'automatic read stage') return 'scout'
  if (normalized.includes('review')) return 'review'
  if (normalized.includes('background')) return 'background'
  if (normalized === 'full fan-out' || normalized === 'ensemble fan-out') return 'all'
  if (
    normalized.includes('worker') ||
    normalized.includes('writer') ||
    normalized.includes('write-scope')
  ) {
    return 'work'
  }
  return 'specified'
}

function stageFromLaneMessages(lanes: readonly IndexedLaneMessage[]): EnsembleFanoutViewportStage {
  const stages = new Set<EnsembleFanoutViewportStage>()
  let untyped = false
  for (const { message } of lanes) {
    const stageRole = metadataString(message, 'ensembleStageRole')
    if (stageRole === 'scout') stages.add('scout')
    else if (stageRole === 'worker') stages.add('work')
    else if (stageRole === 'reviewer') stages.add('review')
    else if (stageRole === 'background') stages.add('background')
    else untyped = true
  }
  if (!untyped && stages.size === 1) return Array.from(stages)[0]
  if (!untyped && stages.size === 4) return 'all'
  return 'specified'
}

function collectAttributions(
  lanes: readonly IndexedLaneMessage[]
): EnsembleFanoutViewportAttribution[] {
  const attributions: EnsembleFanoutViewportAttribution[] = []
  const seen = new Set<string>()
  for (const { message } of lanes) {
    const provider = metadataString(message, 'ensembleProvider')
    if (!provider) continue
    const participantId = metadataString(message, 'ensembleParticipantId')
    const role = metadataString(message, 'ensembleRole')
    const model = metadataString(message, 'ensembleModel')
    const key = participantId || `${provider}\u0000${role || ''}\u0000${model || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    attributions.push({ participantId, provider, role, model })
  }
  return attributions
}

function viewportId(chatId: string, roundId: string, anchorId: string): string {
  return `ensemble-fanout-viewport-${chatId}-${roundId}-${anchorId}`
}

/**
 * Recover each durable fan-out dispatch wave from the round transcript.
 *
 * The orchestrator persists a labelled `ensembleRoundStatus` row immediately
 * before it seeds a parallel pass. The renderer can therefore associate the
 * next N lane cards with that wave without consulting `activeRound`, which is
 * exactly the state that disappears after completion/reload. Older transcripts
 * without the status receipt fall into one conservative, stage-inferred group.
 */
export function collectEnsembleFanoutViewportGroups(
  chatId: string,
  roundId: string,
  messages: readonly ChatMessage[]
): EnsembleFanoutViewportGroup[] {
  const groups: MutableViewportGroup[] = []
  const unassigned: IndexedLaneMessage[] = []
  let openGroup: MutableViewportGroup | null = null

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    const statusMatch =
      message.role === 'system' && message.metadata?.kind === 'ensembleRoundStatus'
        ? FANOUT_DISPATCH_STATUS.exec(message.content || '')
        : null
    if (statusMatch) {
      const dispatchLabel = statusMatch[1].trim()
      openGroup = {
        anchorId: message.id,
        anchorIndex: index,
        dispatchLabel,
        expectedLaneCount: Number(statusMatch[2]),
        stage: stageFromDispatchLabel(dispatchLabel),
        lanes: [],
        laneIds: new Set()
      }
      groups.push(openGroup)
      continue
    }

    if (!isEnsembleFanoutResultMessage(message)) continue
    const laneId = metadataString(message, 'ensembleLaneId') || message.id
    const indexed = { message, index }
    if (openGroup) {
      if (openGroup.laneIds.has(laneId)) continue
      openGroup.laneIds.add(laneId)
      openGroup.lanes.push(indexed)
      if (
        openGroup.expectedLaneCount !== null &&
        openGroup.lanes.length >= openGroup.expectedLaneCount
      ) {
        openGroup = null
      }
      continue
    }
    unassigned.push(indexed)
  }

  const populated = groups.filter((group) => group.lanes.length > 0)
  if (unassigned.length > 0) {
    populated.push({
      anchorId: unassigned[0].message.id,
      anchorIndex: unassigned[0].index,
      dispatchLabel: null,
      expectedLaneCount: null,
      stage: stageFromLaneMessages(unassigned),
      lanes: unassigned,
      laneIds: new Set(
        unassigned.map(({ message }) => metadataString(message, 'ensembleLaneId') || message.id)
      )
    })
  }

  return populated
    .sort((a, b) => a.anchorIndex - b.anchorIndex)
    .map((group) => ({
      // Pre-1.0.7 status rows could share ids within one round. Pair the
      // receipt anchor with the first canonical lane-card id so two historical
      // dispatch waves can never collide in disclosure state.
      viewportId: viewportId(
        chatId,
        roundId,
        `${group.anchorId}-${group.lanes[0]?.message.id || 'empty'}`
      ),
      chatId,
      roundId,
      stage: group.stage,
      dispatchLabel: group.dispatchLabel,
      lanes: group.lanes
    }))
}

function constituentIds(lanes: readonly IndexedLaneMessage[]): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const { message } of lanes) {
    for (const id of [message.id, ...groupedTranscriptMessageIds(message)]) {
      if (!id || seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
  }
  return ids
}

function buildHeaderMessage(group: EnsembleFanoutViewportGroup, expanded: boolean): ChatMessage {
  const laneMessageIds = group.lanes.map(({ message }) => message.id)
  const attributions = collectAttributions(group.lanes)
  const data: EnsembleFanoutViewportHeaderData = {
    viewportId: group.viewportId,
    chatId: group.chatId,
    roundId: group.roundId,
    stage: group.stage,
    dispatchLabel: group.dispatchLabel,
    expanded,
    laneCount: group.lanes.length,
    laneMessageIds,
    attributions
  }
  return {
    id: group.viewportId,
    role: 'system',
    // Presentation-only signature material. The component renders structured
    // metadata, but row/measurement caches still need expansion/roster changes
    // to invalidate this synthetic message deterministically.
    content: [
      'Fan-out viewport',
      group.stage,
      expanded ? 'expanded' : 'collapsed',
      String(group.lanes.length),
      ...group.lanes.map(({ message }) => message.id),
      ...attributions.map(
        (attribution) =>
          `${attribution.participantId || ''}:${attribution.provider}:${attribution.model || ''}`
      )
    ].join('|'),
    timestamp: group.lanes[0]?.message.timestamp || '',
    metadata: {
      kind: ENSEMBLE_FANOUT_VIEWPORT_HEADER_KIND,
      ensembleRoundId: group.roundId,
      groupedFanoutMessageIds: constituentIds(group.lanes),
      ensembleFanoutViewportHeader: data
    }
  }
}

export function isEnsembleFanoutViewportHeaderMessage(
  message: ChatMessage | null | undefined
): boolean {
  return Boolean(
    message?.role === 'system' && message.metadata?.kind === ENSEMBLE_FANOUT_VIEWPORT_HEADER_KIND
  )
}

export function readEnsembleFanoutViewportHeader(
  message: ChatMessage | null | undefined
): EnsembleFanoutViewportHeaderData | null {
  if (!isEnsembleFanoutViewportHeaderMessage(message)) return null
  const data = message?.metadata?.ensembleFanoutViewportHeader
  if (!data || typeof data !== 'object') return null
  const candidate = data as Partial<EnsembleFanoutViewportHeaderData>
  if (
    typeof candidate.viewportId !== 'string' ||
    typeof candidate.chatId !== 'string' ||
    typeof candidate.roundId !== 'string' ||
    typeof candidate.stage !== 'string' ||
    typeof candidate.expanded !== 'boolean' ||
    typeof candidate.laneCount !== 'number' ||
    !Array.isArray(candidate.laneMessageIds) ||
    !Array.isArray(candidate.attributions)
  ) {
    return null
  }
  return candidate as EnsembleFanoutViewportHeaderData
}

export function buildCollapsedEnsembleFanoutViewportRanges(input: {
  chatId: string
  roundId: string
  messages: readonly ChatMessage[]
  sourceOffset: number
  expandedViewportIds: ReadonlySet<string>
}): TranscriptGroupedMessageRange[] {
  const ranges: TranscriptGroupedMessageRange[] = []
  for (const group of collectEnsembleFanoutViewportGroups(
    input.chatId,
    input.roundId,
    input.messages
  )) {
    const expanded = input.expandedViewportIds.has(group.viewportId)
    const laneIndexes = group.lanes.map((lane) => lane.index)
    ranges.push({
      message: buildHeaderMessage(group, expanded),
      startIndex: input.sourceOffset + Math.min(...laneIndexes),
      endIndex: input.sourceOffset + Math.max(...laneIndexes) + 1
    })
    if (!expanded) continue
    for (const lane of group.lanes) {
      ranges.push({
        message: lane.message,
        startIndex: input.sourceOffset + lane.index,
        endIndex: input.sourceOffset + lane.index + 1
      })
    }
  }
  return ranges
}

export function ensembleFanoutViewportStageLabel(stage: EnsembleFanoutViewportStage): string {
  if (stage === 'scout') return 'Scout'
  if (stage === 'work') return 'Work'
  if (stage === 'review') return 'Review'
  if (stage === 'background') return 'BG'
  if (stage === 'all') return 'All'
  return 'Specified'
}
