import type { ChatMessage } from '../../../main/store/types'
import {
  isSubThreadReturnMessage,
  linkedChildReturnRelation
} from '../components/SubThreadReturnCardModel'
import type { TranscriptGroupedMessageRange } from './transcriptToolMessageGrouping'

export const PARALLEL_RESULT_VIEWPORT_HEADER_KIND = 'parallelResultViewportHeader'

/** Stage-less category: relation of the linked child that formed the wave. */
export type ParallelResultViewportCategory = 'subThread' | 'sideChat'

export interface ParallelResultViewportAttribution {
  subThreadId: string | null
  provider: string
  title: string | null
}

export interface ParallelResultViewportHeaderData {
  viewportId: string
  waveId: string
  chatId: string
  category: ParallelResultViewportCategory
  expanded: boolean
  memberCount: number
  memberMessageIds: string[]
  attributions: ParallelResultViewportAttribution[]
}

interface IndexedMember {
  message: ChatMessage
  index: number
}

export interface ParallelResultViewportGroup {
  viewportId: string
  waveId: string
  chatId: string
  category: ParallelResultViewportCategory
  anchorIndex: number
  /**
   * Expected wave membership. When `parallelResultExpectedCount` is absent on
   * the adjacent run, the present same-wave adjacent run length is treated as
   * complete membership (returns append at completion; unknown expected cannot
   * wait forever without a stamped count).
   */
  expectedMemberCount: number
  members: IndexedMember[]
}

function metadataString(message: ChatMessage, key: string): string | null {
  const value = message.metadata?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function metadataPositiveInt(message: ChatMessage, key: string): number | null {
  const value = message.metadata?.[key]
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
    return Math.floor(value)
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed >= 1) return Math.floor(parsed)
  }
  return null
}

function waveIdOf(message: ChatMessage): string | null {
  return metadataString(message, 'parallelResultWaveId')
}

function categoryOf(message: ChatMessage): ParallelResultViewportCategory {
  return linkedChildReturnRelation(message)
}

function viewportId(chatId: string, waveId: string, anchorId: string): string {
  return `parallel-result-viewport-${chatId}-${waveId}-${anchorId}`
}

function collectAttributions(
  members: readonly IndexedMember[]
): ParallelResultViewportAttribution[] {
  const attributions: ParallelResultViewportAttribution[] = []
  const seen = new Set<string>()
  for (const { message } of members) {
    const provider = metadataString(message, 'subThreadProvider')
    if (!provider) continue
    const subThreadId = metadataString(message, 'subThreadId')
    const title = metadataString(message, 'subThreadTitle')
    const key = subThreadId || `${provider}\u0000${title || ''}\u0000${message.id}`
    if (seen.has(key)) continue
    seen.add(key)
    attributions.push({ subThreadId, provider, title })
  }
  return attributions
}

/**
 * Recover adjacent parallel-result waves from parent-transcript return cards.
 *
 * Only `subThreadReturn` rows that carry `metadata.parallelResultWaveId` enter
 * a wave. Grouping requires the same wave id **and** the same
 * `linkedChildRelation` (missing relation ⇒ subThread). Side-chat returns
 * without a wave id stay ordinary singletons and never merge into a join wave.
 *
 * Adjacency is load-bearing: an intervening non-member breaks the run so late
 * siblings after serial parent turns form a separate group rather than being
 * reordered into the earlier cluster.
 */
export function collectParallelResultViewportGroups(
  chatId: string,
  messages: readonly ChatMessage[]
): ParallelResultViewportGroup[] {
  const groups: ParallelResultViewportGroup[] = []
  let open: {
    waveId: string
    category: ParallelResultViewportCategory
    stampedExpected: number | null
    members: IndexedMember[]
  } | null = null

  const flush = (): void => {
    if (!open || open.members.length === 0) {
      open = null
      return
    }
    const expectedMemberCount = open.stampedExpected ?? open.members.length
    const first = open.members[0]
    groups.push({
      viewportId: viewportId(chatId, open.waveId, first.message.id),
      waveId: open.waveId,
      chatId,
      category: open.category,
      anchorIndex: first.index,
      expectedMemberCount,
      members: open.members
    })
    open = null
  }

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (!isSubThreadReturnMessage(message)) {
      flush()
      continue
    }
    const waveId = waveIdOf(message)
    if (!waveId) {
      // No join stamp — singleton ordinary card; never false-merge.
      flush()
      continue
    }
    const category = categoryOf(message)
    const stamped = metadataPositiveInt(message, 'parallelResultExpectedCount')
    if (open && open.waveId === waveId && open.category === category) {
      open.members.push({ message, index })
      if (stamped !== null) {
        open.stampedExpected =
          open.stampedExpected === null ? stamped : Math.max(open.stampedExpected, stamped)
      }
      continue
    }
    flush()
    open = {
      waveId,
      category,
      stampedExpected: stamped,
      members: [{ message, index }]
    }
  }
  flush()
  return groups
}

function buildHeaderMessage(group: ParallelResultViewportGroup, expanded: boolean): ChatMessage {
  const memberMessageIds = group.members.map(({ message }) => message.id)
  const attributions = collectAttributions(group.members)
  const data: ParallelResultViewportHeaderData = {
    viewportId: group.viewportId,
    waveId: group.waveId,
    chatId: group.chatId,
    category: group.category,
    expanded,
    memberCount: group.members.length,
    memberMessageIds,
    attributions
  }
  return {
    id: group.viewportId,
    role: 'system',
    // Presentation-only signature material for row/measurement cache invalidation.
    content: [
      'ParallelResult',
      group.waveId,
      group.category,
      expanded ? 'expanded' : 'collapsed',
      String(group.members.length),
      ...memberMessageIds,
      ...attributions.map(
        (attribution) =>
          `${attribution.subThreadId || ''}:${attribution.provider}:${attribution.title || ''}`
      )
    ].join('|'),
    timestamp: group.members[0]?.message.timestamp || '',
    metadata: {
      kind: PARALLEL_RESULT_VIEWPORT_HEADER_KIND,
      groupedParallelResultMessageIds: memberMessageIds,
      parallelResultViewportHeader: data
    }
  }
}

export function isParallelResultViewportHeaderMessage(
  message: ChatMessage | null | undefined
): boolean {
  return Boolean(
    message?.role === 'system' && message.metadata?.kind === PARALLEL_RESULT_VIEWPORT_HEADER_KIND
  )
}

export function readParallelResultViewportHeader(
  message: ChatMessage | null | undefined
): ParallelResultViewportHeaderData | null {
  if (!isParallelResultViewportHeaderMessage(message)) return null
  const data = message?.metadata?.parallelResultViewportHeader
  if (!data || typeof data !== 'object') return null
  const candidate = data as Partial<ParallelResultViewportHeaderData>
  if (
    typeof candidate.viewportId !== 'string' ||
    typeof candidate.waveId !== 'string' ||
    typeof candidate.chatId !== 'string' ||
    (candidate.category !== 'subThread' && candidate.category !== 'sideChat') ||
    typeof candidate.expanded !== 'boolean' ||
    typeof candidate.memberCount !== 'number' ||
    !Array.isArray(candidate.memberMessageIds) ||
    !Array.isArray(candidate.attributions)
  ) {
    return null
  }
  return candidate as ParallelResultViewportHeaderData
}

export function parallelResultViewportCategoryLabel(
  category: ParallelResultViewportCategory
): string {
  return category === 'sideChat' ? 'Side-chat' : 'Sub-thread'
}

/**
 * Collapse only when expected membership is complete and transcript focus has
 * moved past the last member. Incomplete waves stay ordinary return cards.
 *
 * Adjacent runs are contiguous, so any transcript row after the last member
 * counts as later focus — including a different wave's returns, parent
 * user/assistant turns, and side-chat singletons. Same-wave returns would have
 * extended this adjacent run instead of appearing after it.
 */
function shouldCollapseParallelResultGroup(
  group: ParallelResultViewportGroup,
  messageCount: number
): boolean {
  if (group.members.length === 0) return false
  if (group.members.length < group.expectedMemberCount) return false
  let lastMemberIndex = -1
  for (const member of group.members) {
    if (member.index > lastMemberIndex) lastMemberIndex = member.index
  }
  return lastMemberIndex >= 0 && lastMemberIndex < messageCount - 1
}

/**
 * Fold complete parallel-result waves that have yielded transcript focus.
 * Expand re-homes members under the synthetic header (source order among
 * siblings) rather than leaving them at raw indexes for pairing.
 */
export function buildParallelResultViewportRanges(input: {
  chatId: string
  messages: readonly ChatMessage[]
  sourceOffset: number
  expandedViewportIds: ReadonlySet<string>
}): TranscriptGroupedMessageRange[] {
  const allGroups = collectParallelResultViewportGroups(input.chatId, input.messages)
  const groups = allGroups.filter((group) =>
    shouldCollapseParallelResultGroup(group, input.messages.length)
  )
  if (groups.length === 0) {
    return input.messages.map((message, index) => ({
      message,
      startIndex: input.sourceOffset + index,
      endIndex: input.sourceOffset + index + 1
    }))
  }

  const ranges: TranscriptGroupedMessageRange[] = []
  const groupByAnchorIndex = new Map(groups.map((group) => [group.anchorIndex, group] as const))
  const groupByMemberIndex = new Map<number, ParallelResultViewportGroup>()
  for (const group of groups) {
    for (const member of group.members) groupByMemberIndex.set(member.index, group)
  }

  for (let index = 0; index < input.messages.length; index += 1) {
    const group = groupByAnchorIndex.get(index)
    const memberGroup = groupByMemberIndex.get(index)
    if (!group && !memberGroup) {
      ranges.push({
        message: input.messages[index],
        startIndex: input.sourceOffset + index,
        endIndex: input.sourceOffset + index + 1
      })
      continue
    }

    if (group) {
      const expanded = input.expandedViewportIds.has(group.viewportId)
      const ownedIndexes = group.members.map((member) => member.index)
      ranges.push({
        message: buildHeaderMessage(group, expanded),
        startIndex: input.sourceOffset + Math.min(...ownedIndexes),
        endIndex: input.sourceOffset + Math.max(...ownedIndexes) + 1
      })
      if (expanded) {
        const ordered = [...group.members].sort((left, right) => left.index - right.index)
        for (const member of ordered) {
          ranges.push({
            message: member.message,
            startIndex: input.sourceOffset + member.index,
            endIndex: input.sourceOffset + member.index + 1
          })
        }
      }
      continue
    }

    // Owned by a viewport header emitted at its adjacent-run anchor — omit here
    // whether the disclosure is open or closed.
  }
  return ranges
}
