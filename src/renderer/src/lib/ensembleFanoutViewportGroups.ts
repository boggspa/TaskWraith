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

function fanoutLaneOrder(message: ChatMessage): number {
  const value = message.metadata?.ensembleOrder
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER
}

function compareFanoutLanesForPresentation(
  left: IndexedLaneMessage,
  right: IndexedLaneMessage
): number {
  const orderDelta = fanoutLaneOrder(left.message) - fanoutLaneOrder(right.message)
  if (orderDelta !== 0) return orderDelta
  const participantDelta = (
    metadataString(left.message, 'ensembleParticipantId') || ''
  ).localeCompare(metadataString(right.message, 'ensembleParticipantId') || '')
  if (participantDelta !== 0) return participantDelta
  const laneDelta = (metadataString(left.message, 'ensembleLaneId') || '').localeCompare(
    metadataString(right.message, 'ensembleLaneId') || ''
  )
  return laneDelta || left.index - right.index
}

/**
 * Keep the visible cards from one additive user-directed wave together even
 * when the serial speaker flushed rows between those cards. This receives the
 * renderer's already lane-folded list, so there is one result card per lane.
 * Persisted transcript chronology remains untouched.
 */
export function coLocateUserFanoutLaneMessages(messages: ChatMessage[]): ChatMessage[] {
  const cardsByWave = new Map<string, IndexedLaneMessage[]>()
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (
      !isEnsembleFanoutResultMessage(message) ||
      metadataString(message, 'ensembleFanoutCategory') !== 'user'
    ) {
      continue
    }
    const waveId = metadataString(message, 'ensembleFanoutWaveId')
    if (!waveId) continue
    const waveKey = JSON.stringify([metadataString(message, 'ensembleRoundId') || '', waveId])
    const cards = cardsByWave.get(waveKey)
    if (cards) cards.push({ message, index })
    else cardsByWave.set(waveKey, [{ message, index }])
  }

  const cardsByAnchorIndex = new Map<number, IndexedLaneMessage[]>()
  const relocatedIndexes = new Set<number>()
  for (const cards of cardsByWave.values()) {
    if (cards.length < 2) continue
    const anchorIndex = Math.min(...cards.map((lane) => lane.index))
    cardsByAnchorIndex.set(anchorIndex, cards.sort(compareFanoutLanesForPresentation))
    for (const lane of cards) relocatedIndexes.add(lane.index)
  }
  if (cardsByAnchorIndex.size === 0) return messages

  const output: ChatMessage[] = []
  for (let index = 0; index < messages.length; index += 1) {
    const cards = cardsByAnchorIndex.get(index)
    if (cards) output.push(...cards.map((lane) => lane.message))
    else if (!relocatedIndexes.has(index)) output.push(messages[index])
  }
  return output
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
  const dispatchGroupByIndex = new Map<number, MutableViewportGroup>()
  const openGroups: MutableViewportGroup[] = []
  let legacyGroup: MutableViewportGroup | null = null

  // Index every durable receipt before assigning lane rows. A historical
  // main-side ordering bug could persist the first fragment of a later wave
  // ahead of that wave's receipt; the explicit wave id remains authoritative
  // even when transcript order is not.
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
      dispatchGroupByIndex.set(index, group)
      groupByWaveId.set(durableWaveId, group)
    }
  }

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    const dispatchGroup = dispatchGroupByIndex.get(index)
    if (dispatchGroup) {
      if (
        dispatchGroup.expectedLaneCount === null ||
        dispatchGroup.lanes.length < dispatchGroup.expectedLaneCount
      ) {
        openGroups.push(dispatchGroup)
      }
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

/**
 * Run-derived lookups that are identical for every round and every wave in one
 * transcript pass.
 *
 * MEASURED 2026-08-05 (perf-artifacts/fanout-viewport-soak-2026-08-05): these
 * were rebuilt per ROUND (`terminalRunIds`) and per WAVE (`Map(runs)` inside
 * `hasLaterRoundRun`). Runs grow with rounds, so both were O(rounds x runs) —
 * the accumulator behind a constant-work transcript mutation growing
 * 134ms -> 9,220ms across a 500-round soak. Build once, share everywhere.
 */
export interface EnsembleFanoutRunIndex {
  terminalRunIds: ReadonlySet<string>
  runIndexById: ReadonlyMap<string, number>
  /** Runs that carry a startedAt, bucketed by round, in run order. */
  startedRunsByRoundId: ReadonlyMap<string, ReadonlyArray<{ index: number; laneId: string }>>
}

export function buildEnsembleFanoutRunIndex(
  runs: readonly ChatRun[] | null | undefined
): EnsembleFanoutRunIndex {
  const list = runs || []
  const terminalRunIds = new Set<string>()
  const runIndexById = new Map<string, number>()
  const startedRunsByRoundId = new Map<string, Array<{ index: number; laneId: string }>>()
  for (let index = 0; index < list.length; index += 1) {
    const run = list[index]
    if (runIsTerminal(run)) terminalRunIds.add(run.runId)
    runIndexById.set(run.runId, index)
    const roundId = run.ensembleRoundId
    if (
      typeof roundId === 'string' &&
      roundId &&
      typeof run.startedAt === 'string' &&
      run.startedAt
    ) {
      const bucket = startedRunsByRoundId.get(roundId)
      const entry = { index, laneId: run.ensembleLaneId || '' }
      if (bucket) bucket.push(entry)
      else startedRunsByRoundId.set(roundId, [entry])
    }
  }
  return { terminalRunIds, runIndexById, startedRunsByRoundId }
}

function hasLaterRoundRun(
  group: EnsembleFanoutViewportGroup,
  runIndex: EnsembleFanoutRunIndex
): boolean {
  const ownedLaneIds = new Set(
    group.lanes
      .map(({ message }) => metadataString(message, 'ensembleLaneId'))
      .filter((laneId): laneId is string => Boolean(laneId))
  )
  let lastLaneRunIndex = -1
  for (const { message } of group.lanes) {
    const index = message.runId ? runIndex.runIndexById.get(message.runId) : undefined
    if (typeof index === 'number' && index > lastLaneRunIndex) lastLaneRunIndex = index
  }
  if (lastLaneRunIndex < 0) return false
  // Only this round's started runs can qualify, so scan that bucket rather than
  // the whole run list (which grows with every round in the chat).
  const candidates = runIndex.startedRunsByRoundId.get(group.roundId)
  if (!candidates) return false
  return candidates.some(
    (candidate) =>
      candidate.index > lastLaneRunIndex &&
      (!candidate.laneId || !ownedLaneIds.has(candidate.laneId))
  )
}

function shouldCollapseFanoutGroup(
  group: EnsembleFanoutViewportGroup,
  lastTurnStartIndex: number,
  runIndex: EnsembleFanoutRunIndex
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
      return Boolean(latest && laneIsTerminal(latest.message, runIndex.terminalRunIds))
    })
  ) {
    return false
  }
  let lastLaneIndex = -1
  for (const lane of group.laneRows) if (lane.index > lastLaneIndex) lastLaneIndex = lane.index
  // `lastTurnStartIndex` is the highest index in this round whose message
  // starts a later transcript turn, precomputed once per round. It is exactly
  // equivalent to the previous `messages.slice(lastLaneIndex + 1).some(...)`,
  // without allocating a fresh tail array for every wave.
  return lastTurnStartIndex > lastLaneIndex || hasLaterRoundRun(group, runIndex)
}

/**
 * Fold only fan-out waves that are fully terminal and have yielded transcript
 * focus to a later turn. Live/current waves remain ordinary lane cards. The
 * dispatch receipt is replaced by the compact disclosure; opening it restores
 * the lane rows immediately under that disclosure.
 *
 * Lane rows are re-homed next to the header on expand rather than left at
 * their raw transcript indexes. User Fan-Out (and other background
 * dispositions) can flush long after intervening serial turns, so restoring
 * at source order made expand look like a no-op while the lane card sat far
 * below the one-liner.
 */
export function buildEnsembleFanoutViewportRanges(input: {
  chatId: string
  roundId: string
  messages: readonly ChatMessage[]
  runs?: readonly ChatRun[]
  /**
   * Shared run lookups. The transcript calls this once per visible ROUND with
   * the chat's whole run list, so deriving them here made the work
   * O(rounds x runs). Callers in a multi-round pass should build it once with
   * `buildEnsembleFanoutRunIndex` and pass it in; it is derived on demand when
   * absent so single-round callers and tests stay unchanged.
   */
  runIndex?: EnsembleFanoutRunIndex
  sourceOffset: number
  expandedViewportIds: ReadonlySet<string>
}): TranscriptGroupedMessageRange[] {
  const runIndex = input.runIndex || buildEnsembleFanoutRunIndex(input.runs)
  let lastTurnStartIndex = -1
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    if (startsLaterTranscriptTurn(input.messages[index])) {
      lastTurnStartIndex = index
      break
    }
  }
  const groups = collectEnsembleFanoutViewportGroups(
    input.chatId,
    input.roundId,
    input.messages
  ).filter((group) => shouldCollapseFanoutGroup(group, lastTurnStartIndex, runIndex))
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
      if (expanded) {
        // Keep source order among siblings, but always park them under the
        // disclosure — never leave a late-flushed background lane stranded
        // below later serial turns.
        const orderedLanes = [...group.laneRows].sort((left, right) => left.index - right.index)
        for (const lane of orderedLanes) {
          ranges.push({
            message: lane.message,
            startIndex: input.sourceOffset + lane.index,
            endIndex: input.sourceOffset + lane.index + 1
          })
        }
      }
      continue
    }

    // Owned by a viewport header emitted at its dispatch anchor — omit here
    // whether the disclosure is open or closed so late lanes are not restored
    // at their raw chronological index far below the one-liner.
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
