import type { ChatMessage, ChatRun } from '../../../main/store/types'
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

export type EnsembleFanoutViewportCategory = 'user' | 'orchestrated'

export interface EnsembleFanoutViewportAttribution {
  participantId: string | null
  provider: string
  role: string | null
  model: string | null
}

export interface EnsembleFanoutViewportHeaderData {
  viewportId: string
  waveId: string
  chatId: string
  roundId: string
  stage: EnsembleFanoutViewportStage
  category: EnsembleFanoutViewportCategory
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
  category: EnsembleFanoutViewportCategory
  waveId: string
  expectedLaneCount: number | null
  stage: EnsembleFanoutViewportStage
  /** One stable representative row per lane, used for count and attribution. */
  lanes: IndexedLaneMessage[]
  /** Every transcript row owned by those lanes, including terminal status codas. */
  laneRows: IndexedLaneMessage[]
}

export interface EnsembleFanoutViewportGroup {
  viewportId: string
  waveId: string
  chatId: string
  roundId: string
  anchorIndex: number
  expectedLaneCount: number | null
  stage: EnsembleFanoutViewportStage
  category: EnsembleFanoutViewportCategory
  dispatchLabel: string | null
  lanes: IndexedLaneMessage[]
  laneRows: IndexedLaneMessage[]
}

const FANOUT_DISPATCH_STATUS =
  /^(.*?) · (\d+) (?:participant\(s\)|read-only participants) dispatched concurrently\b/

function metadataString(message: ChatMessage, key: string): string | null {
  const value = message.metadata?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isEnsembleFanoutLaneMessage(message: ChatMessage): boolean {
  if (isEnsembleFanoutResultMessage(message)) return true
  return Boolean(
    message.role === 'system' &&
    message.metadata?.kind === 'ensembleParticipantStatus' &&
    metadataString(message, 'ensembleLaneId')
  )
}

function fanoutLaneKey(message: ChatMessage): string {
  return `${message.runId || ''}\u0000${metadataString(message, 'ensembleLaneId') || message.id}`
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
  const groupByLaneKey = new Map<string, MutableViewportGroup>()
  const groupByWaveId = new Map<string, MutableViewportGroup>()
  const openGroups: MutableViewportGroup[] = []
  let legacyGroup: MutableViewportGroup | null = null

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    const statusMatch =
      message.role === 'system' && message.metadata?.kind === 'ensembleRoundStatus'
        ? FANOUT_DISPATCH_STATUS.exec(message.content || '')
        : null
    if (statusMatch) {
      const dispatchLabel = statusMatch[1].trim()
      const durableWaveId = metadataString(message, 'ensembleFanoutWaveId') || message.id
      const durableCategory = metadataString(message, 'ensembleFanoutCategory')
      const group: MutableViewportGroup = {
        anchorId: message.id,
        anchorIndex: index,
        dispatchLabel,
        category:
          durableCategory === 'user' || dispatchLabel.toLowerCase() === 'user fan-out'
            ? 'user'
            : 'orchestrated',
        waveId: durableWaveId,
        expectedLaneCount: Number(statusMatch[2]),
        stage: stageFromDispatchLabel(dispatchLabel),
        lanes: [],
        laneRows: []
      }
      groups.push(group)
      openGroups.push(group)
      groupByWaveId.set(durableWaveId, group)
      continue
    }

    if (!isEnsembleFanoutLaneMessage(message)) continue
    const laneKey = fanoutLaneKey(message)
    const indexed = { message, index }
    const existingGroup = groupByLaneKey.get(laneKey)
    if (existingGroup) {
      existingGroup.laneRows.push(indexed)
      continue
    }
    const laneStage = stageFromLaneMessages([indexed])
    const explicitWaveId = metadataString(message, 'ensembleFanoutWaveId')
    const explicitWaveGroup = explicitWaveId ? groupByWaveId.get(explicitWaveId) : undefined
    const matchingOpenGroups =
      laneStage === 'specified'
        ? openGroups
        : openGroups.filter(
            (group) =>
              group.stage === laneStage || group.stage === 'all' || group.stage === 'specified'
          )
    // Parallel passes are normally serialized, but transcript flushes can land
    // after a later dispatch receipt. Keep every incomplete wave available and
    // prefer the oldest compatible stage match. All/Specified passes are stage
    // wildcards, so a late lane cannot be stolen by a newer narrow receipt.
    let targetGroup =
      explicitWaveGroup || matchingOpenGroups[0] || openGroups[openGroups.length - 1] || null
    if (!targetGroup) {
      if (!legacyGroup) {
        legacyGroup = {
          anchorId: message.id,
          anchorIndex: index,
          dispatchLabel: null,
          category: 'orchestrated',
          waveId: explicitWaveId || message.id,
          expectedLaneCount: null,
          stage: 'specified',
          lanes: [],
          laneRows: []
        }
        groups.push(legacyGroup)
      }
      targetGroup = legacyGroup
    }
    targetGroup.lanes.push(indexed)
    targetGroup.laneRows.push(indexed)
    groupByLaneKey.set(laneKey, targetGroup)
    if (targetGroup !== legacyGroup) {
      if (
        targetGroup.expectedLaneCount !== null &&
        targetGroup.lanes.length >= targetGroup.expectedLaneCount
      ) {
        const openIndex = openGroups.indexOf(targetGroup)
        if (openIndex >= 0) openGroups.splice(openIndex, 1)
      }
    }
  }

  const populated = groups.filter((group) => group.lanes.length > 0)
  if (legacyGroup) {
    legacyGroup.stage = stageFromLaneMessages(legacyGroup.lanes)
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
        `${group.waveId}-${group.lanes[0]?.message.id || 'empty'}`
      ),
      waveId: group.waveId,
      chatId,
      roundId,
      anchorIndex: group.anchorIndex,
      expectedLaneCount: group.expectedLaneCount,
      stage: group.stage,
      category: group.category,
      dispatchLabel: group.dispatchLabel,
      lanes: group.lanes,
      laneRows: group.laneRows
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
    waveId: group.waveId,
    chatId: group.chatId,
    roundId: group.roundId,
    stage: group.stage,
    category: group.category,
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
      'Fan-Out',
      group.waveId,
      group.stage,
      expanded ? 'expanded' : 'collapsed',
      String(group.lanes.length),
      ...group.laneRows.map(({ message }) => message.id),
      ...attributions.map(
        (attribution) =>
          `${attribution.participantId || ''}:${attribution.provider}:${attribution.model || ''}`
      )
    ].join('|'),
    timestamp: group.lanes[0]?.message.timestamp || '',
    metadata: {
      kind: ENSEMBLE_FANOUT_VIEWPORT_HEADER_KIND,
      ensembleRoundId: group.roundId,
      groupedFanoutMessageIds: constituentIds(group.laneRows),
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

const TERMINAL_PARTICIPANT_STATUSES = new Set([
  'answered',
  'yielded',
  'failed',
  'skipped',
  'cancelled',
  'unreachable'
])

const TERMINAL_RUN_STATUSES = new Set(['success', 'success_with_warnings', 'failed', 'cancelled'])

function runIsTerminal(run: ChatRun): boolean {
  const status = String(run.status || '')
  if (run.cancelled === true) return true
  // Mirror AgentStatsStore.isTerminalRun: active/sleeping status wins over a
  // stale endedAt, while warning-completed runs are terminal without one.
  if (status === 'running' || status === 'sleeping') return false
  return Boolean(run.endedAt) || TERMINAL_RUN_STATUSES.has(status)
}

function laneIsTerminal(message: ChatMessage, terminalRunIds: ReadonlySet<string>): boolean {
  if (message.runId && terminalRunIds.has(message.runId)) return true
  return TERMINAL_PARTICIPANT_STATUSES.has(metadataString(message, 'ensembleStatus') || '')
}

function isFanoutDispatchStatus(message: ChatMessage): boolean {
  return Boolean(
    message.role === 'system' &&
    message.metadata?.kind === 'ensembleRoundStatus' &&
    FANOUT_DISPATCH_STATUS.test(message.content || '')
  )
}

function startsLaterTranscriptTurn(message: ChatMessage): boolean {
  if (isFanoutDispatchStatus(message)) return true
  if (metadataString(message, 'ensembleLaneId')) return false
  if (!metadataString(message, 'ensembleParticipantId')) return false
  return (
    message.metadata?.kind === 'ensembleParticipant' ||
    message.metadata?.kind === 'ensembleParticipantTools' ||
    message.metadata?.kind === 'ensembleParticipantStatus'
  )
}

function hasLaterRoundRun(group: EnsembleFanoutViewportGroup, runs: readonly ChatRun[]): boolean {
  const runIndexById = new Map(runs.map((run, index) => [run.runId, index] as const))
  const ownedLaneIds = new Set(
    group.lanes
      .map(({ message }) => metadataString(message, 'ensembleLaneId'))
      .filter((laneId): laneId is string => Boolean(laneId))
  )
  const laneRunIndexes = group.lanes
    .map(({ message }) => (message.runId ? runIndexById.get(message.runId) : undefined))
    .filter((index): index is number => typeof index === 'number')
  if (laneRunIndexes.length === 0) return false
  const lastLaneRunIndex = Math.max(...laneRunIndexes)
  return runs.some(
    (run, index) =>
      index > lastLaneRunIndex &&
      run.ensembleRoundId === group.roundId &&
      (!run.ensembleLaneId || !ownedLaneIds.has(run.ensembleLaneId)) &&
      typeof run.startedAt === 'string' &&
      run.startedAt.length > 0
  )
}

function shouldCollapseFanoutGroup(
  group: EnsembleFanoutViewportGroup,
  messages: readonly ChatMessage[],
  runs: readonly ChatRun[],
  terminalRunIds: ReadonlySet<string>
): boolean {
  const latestRowByLaneId = new Map<string, IndexedLaneMessage>()
  for (const laneRow of group.laneRows) {
    latestRowByLaneId.set(fanoutLaneKey(laneRow.message), laneRow)
  }
  if (
    group.lanes.length === 0 ||
    (group.expectedLaneCount !== null && group.lanes.length < group.expectedLaneCount) ||
    !group.lanes.every(({ message }) => {
      const latest = latestRowByLaneId.get(fanoutLaneKey(message))
      return Boolean(latest && laneIsTerminal(latest.message, terminalRunIds))
    })
  ) {
    return false
  }
  const lastLaneIndex = Math.max(...group.laneRows.map((lane) => lane.index))
  return (
    messages.slice(lastLaneIndex + 1).some(startsLaterTranscriptTurn) ||
    hasLaterRoundRun(group, runs)
  )
}

/**
 * Fold only fan-out waves that are fully terminal and have yielded transcript
 * focus to a later turn. Live/current waves remain ordinary lane cards. The
 * dispatch receipt is replaced by the compact disclosure; opening it restores
 * the lane rows without reopening unrelated parts of the round.
 */
export function buildEnsembleFanoutViewportRanges(input: {
  chatId: string
  roundId: string
  messages: readonly ChatMessage[]
  runs?: readonly ChatRun[]
  sourceOffset: number
  expandedViewportIds: ReadonlySet<string>
}): TranscriptGroupedMessageRange[] {
  const runs = input.runs || []
  const terminalRunIds = new Set(runs.filter(runIsTerminal).map((run) => run.runId))
  const groups = collectEnsembleFanoutViewportGroups(
    input.chatId,
    input.roundId,
    input.messages
  ).filter((group) => shouldCollapseFanoutGroup(group, input.messages, runs, terminalRunIds))
  if (groups.length === 0) {
    return input.messages.map((message, index) => ({
      message,
      startIndex: input.sourceOffset + index,
      endIndex: input.sourceOffset + index + 1
    }))
  }

  const ranges: TranscriptGroupedMessageRange[] = []
  const groupByAnchorIndex = new Map(groups.map((group) => [group.anchorIndex, group] as const))
  const groupByLaneIndex = new Map<number, EnsembleFanoutViewportGroup>()
  for (const group of groups) {
    for (const lane of group.laneRows) groupByLaneIndex.set(lane.index, group)
  }

  for (let index = 0; index < input.messages.length; index += 1) {
    const group = groupByAnchorIndex.get(index)
    const laneGroup = groupByLaneIndex.get(index)
    if (!group && !laneGroup) {
      ranges.push({
        message: input.messages[index],
        startIndex: input.sourceOffset + index,
        endIndex: input.sourceOffset + index + 1
      })
      continue
    }

    if (group) {
      const expanded = input.expandedViewportIds.has(group.viewportId)
      const ownedIndexes = [group.anchorIndex, ...group.laneRows.map((lane) => lane.index)]
      ranges.push({
        message: buildHeaderMessage(group, expanded),
        startIndex: input.sourceOffset + Math.min(...ownedIndexes),
        endIndex: input.sourceOffset + Math.max(...ownedIndexes) + 1
      })
      if (laneGroup && expanded) {
        ranges.push({
          message: input.messages[index],
          startIndex: input.sourceOffset + index,
          endIndex: input.sourceOffset + index + 1
        })
      }
      continue
    }

    if (laneGroup && input.expandedViewportIds.has(laneGroup.viewportId)) {
      ranges.push({
        message: input.messages[index],
        startIndex: input.sourceOffset + index,
        endIndex: input.sourceOffset + index + 1
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
