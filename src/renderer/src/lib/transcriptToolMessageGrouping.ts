import type { ChatMessage, ToolActivity, TranscriptMediaRef } from '../../../main/store/types'
import {
  isEnsembleFanoutResultMessage,
  type EnsembleFanoutTranscriptPart
} from '../components/EnsembleFanoutResultCardModel'
import { isGuestParticipantReplyMessage } from '../components/GuestParticipantReplyCardModel'
import { isSubThreadDelegationMessage } from '../components/SubThreadDelegationCardModel'
import { isSubThreadReturnMessage } from '../components/SubThreadReturnCardModel'

function isPlainToolMessage(message: ChatMessage): boolean {
  return (
    message.role === 'tool' &&
    !isSubThreadDelegationMessage(message) &&
    !isSubThreadReturnMessage(message) &&
    !isGuestParticipantReplyMessage(message) &&
    (message.toolActivities?.length || 0) > 0
  )
}

const TOOL_ATTRIBUTION_BOUNDARY_KEYS = [
  'kind',
  'ensembleProvider',
  'ensembleParticipantId',
  'ensembleRole',
  'ensembleModel',
  'ensembleReasoningEffort',
  'ensembleThinkingEnabled',
  'ensembleOrder',
  'ensembleRoundId',
  'ensembleLaneId',
  'pooledAgentId',
  'guestProvider',
  'subThreadProvider'
]

function metadataValue(message: ChatMessage, key: string): string {
  const value = message.metadata?.[key]
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function activityProviderSignature(message: ChatMessage): string {
  return (message.toolActivities || [])
    .map((activity) => `${activity.metadata?.ensembleProvider || ''}/${activity.metadata?.provider || ''}`)
    .join('|')
}

function toolAttributionSignature(message: ChatMessage): string {
  return [
    ...TOOL_ATTRIBUTION_BOUNDARY_KEYS.map((key) => metadataValue(message, key)),
    activityProviderSignature(message)
  ].join('\u0000')
}

function sameToolRunBoundary(a: ChatMessage, b: ChatMessage): boolean {
  if ((a.runId || b.runId) && a.runId !== b.runId) return false
  return toolAttributionSignature(a) === toolAttributionSignature(b)
}

export function shouldGroupAdjacentToolMessages(a: ChatMessage, b: ChatMessage): boolean {
  return isPlainToolMessage(a) && isPlainToolMessage(b) && sameToolRunBoundary(a, b)
}

function mergeToolRun(run: ChatMessage[]): ChatMessage {
  if (run.length === 1) return run[0]
  const first = run[0]
  return {
    ...first,
    // Identity is derived from the FIRST message only, so it stays STABLE as
    // the run grows (more tool messages stream into the same group). Baking
    // `last.id`/`run.length` into the id (as before) changed the id on every
    // new tool, which churned the React key → remounted the grouped row → the
    // CSS `fadeIn` entrance replayed = visible flashing near the tail during
    // streaming. The growth is still tracked for measurement/diffing via
    // `contentVersion` (tool activity count + statuses + output length) and the
    // full constituent list is preserved in `groupedToolMessageIds` below, so
    // nothing depends on the churning id.
    id: `tool-group-${first.id}`,
    toolActivities: run.flatMap((message) => message.toolActivities || []),
    metadata: {
      ...first.metadata,
      kind: first.metadata?.kind,
      groupedToolMessageIds: run.map((message) => message.id)
    }
  }
}

export interface TranscriptGroupedMessageRange {
  message: ChatMessage
  startIndex: number
  endIndex: number
}

export function groupAdjacentToolMessagesWithRanges(
  messages: readonly ChatMessage[]
): TranscriptGroupedMessageRange[] {
  const grouped: TranscriptGroupedMessageRange[] = []
  let pending: ChatMessage[] = []
  let pendingStart = 0

  const flush = (endIndex: number): void => {
    if (pending.length > 0) {
      grouped.push({
        message: mergeToolRun(pending),
        startIndex: pendingStart,
        endIndex
      })
      pending = []
    }
  }

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (!isPlainToolMessage(message)) {
      flush(index)
      grouped.push({ message, startIndex: index, endIndex: index + 1 })
      continue
    }

    const previous = pending[pending.length - 1]
    if (previous && !sameToolRunBoundary(previous, message)) {
      flush(index)
    }
    if (pending.length === 0) {
      pendingStart = index
    }
    pending.push(message)
  }

  flush(messages.length)
  return grouped
}

export function groupAdjacentToolMessages(messages: ChatMessage[]): ChatMessage[] {
  return groupAdjacentToolMessagesWithRanges(messages).map((entry) => entry.message)
}

function stringMetadata(message: ChatMessage, key: string): string {
  const value = message.metadata?.[key]
  return typeof value === 'string' ? value : ''
}

export function fanoutLaneGroupingKey(message: ChatMessage): string | null {
  const laneId = stringMetadata(message, 'ensembleLaneId')
  if (!laneId) return null
  const isContent = isEnsembleFanoutResultMessage(message)
  const isTools = message.role === 'tool' && message.metadata?.kind === 'ensembleParticipantTools'
  if (!isContent && !isTools) return null
  return [
    message.runId || '',
    stringMetadata(message, 'ensembleRoundId'),
    stringMetadata(message, 'ensembleParticipantId'),
    laneId
  ].join('\u0000')
}

function arrayStringMetadata(message: ChatMessage, key: string): string[] {
  const value = message.metadata?.[key]
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

export function groupedTranscriptMessageIds(message: ChatMessage): string[] {
  const ids = [
    ...arrayStringMetadata(message, 'groupedFanoutMessageIds'),
    ...arrayStringMetadata(message, 'groupedToolMessageIds')
  ]
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

function constituentMessageIds(message: ChatMessage): string[] {
  const out = [message.id]
  const seen = new Set(out)
  for (const id of groupedTranscriptMessageIds(message)) {
    if (!seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

function metadataMediaRefs(message: ChatMessage): TranscriptMediaRef[] {
  const refs = message.metadata?.mediaRefs
  return Array.isArray(refs) ? (refs as TranscriptMediaRef[]) : []
}

function mergeMediaRefs(messages: ChatMessage[]): TranscriptMediaRef[] | undefined {
  const refs: TranscriptMediaRef[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    for (const ref of metadataMediaRefs(message)) {
      if (ref.id) {
        if (seen.has(ref.id)) continue
        seen.add(ref.id)
      }
      refs.push(ref)
    }
  }
  return refs.length > 0 ? refs : undefined
}

function mergeFanoutLaneRun(run: ChatMessage[]): ChatMessage {
  const hasTools = run.some((message) => (message.toolActivities?.length || 0) > 0)
  if (run.length === 1 && !hasTools && isEnsembleFanoutResultMessage(run[0])) return run[0]

  const first = run[0]
  const firstContent = run.find(isEnsembleFanoutResultMessage)
  const firstToolConstituentId = arrayStringMetadata(first, 'groupedToolMessageIds')[0]
  const base = firstContent || first
  const parts: EnsembleFanoutTranscriptPart[] = []
  const activities: ToolActivity[] = []
  const contentBlocks: string[] = []
  const groupedFanoutMessageIds: string[] = []
  const groupedToolMessageIds: string[] = []
  const seenFanoutMessageIds = new Set<string>()
  const seenToolMessageIds = new Set<string>()

  for (const message of run) {
    const messageIds = constituentMessageIds(message)
    for (const id of messageIds) {
      if (seenFanoutMessageIds.has(id)) continue
      seenFanoutMessageIds.add(id)
      groupedFanoutMessageIds.push(id)
    }
    if (isEnsembleFanoutResultMessage(message)) {
      const content = message.content || ''
      if (content.trim()) {
        contentBlocks.push(content)
        parts.push({ kind: 'content', id: message.id, messageIds, content })
      }
      continue
    }
    const toolActivities = message.toolActivities || []
    if (toolActivities.length > 0) {
      for (const id of messageIds) {
        if (seenToolMessageIds.has(id)) continue
        seenToolMessageIds.add(id)
        groupedToolMessageIds.push(id)
      }
      activities.push(...toolActivities)
      parts.push({ kind: 'tools', id: message.id, messageIds, toolActivities })
    }
  }

  const mediaRefs = mergeMediaRefs(run)
  return {
    ...base,
    id: firstToolConstituentId || first.id,
    role: 'assistant',
    content: contentBlocks.join('\n\n'),
    timestamp: first.timestamp,
    runId: base.runId || first.runId,
    ...(activities.length > 0 ? { toolActivities: activities } : {}),
    metadata: {
      ...base.metadata,
      kind: 'ensembleParticipant',
      groupedFanoutMessageIds,
      ...(groupedToolMessageIds.length > 0 ? { groupedToolMessageIds } : {}),
      ensembleFanoutTranscriptParts: parts,
      ...(mediaRefs ? { mediaRefs } : {})
    }
  }
}

export function groupFanoutLaneMessagesWithRanges(
  messages: readonly ChatMessage[]
): TranscriptGroupedMessageRange[] {
  const grouped: TranscriptGroupedMessageRange[] = []
  let pending: ChatMessage[] = []
  let pendingStart = 0
  let pendingKey: string | null = null

  const flush = (endIndex: number): void => {
    if (pending.length > 0) {
      grouped.push({
        message: mergeFanoutLaneRun(pending),
        startIndex: pendingStart,
        endIndex
      })
      pending = []
      pendingKey = null
    }
  }

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    const key = fanoutLaneGroupingKey(message)
    if (!key) {
      flush(index)
      grouped.push({ message, startIndex: index, endIndex: index + 1 })
      continue
    }
    if (pendingKey && pendingKey !== key) flush(index)
    if (pending.length === 0) pendingStart = index
    pending.push(message)
    pendingKey = key
  }

  flush(messages.length)
  return grouped
}

export function groupFanoutLaneMessages(messages: ChatMessage[]): ChatMessage[] {
  return groupFanoutLaneMessagesWithRanges(messages).map((entry) => entry.message)
}
