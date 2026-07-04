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
  'ensembleRoundId',
  'ensembleLaneId',
  'guestProvider',
  'subThreadProvider'
]

function metadataValue(message: ChatMessage, key: string): string {
  const value = message.metadata?.[key]
  return typeof value === 'string' ? value : ''
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

export function groupAdjacentToolMessages(messages: ChatMessage[]): ChatMessage[] {
  const grouped: ChatMessage[] = []
  let pending: ChatMessage[] = []

  const flush = (): void => {
    if (pending.length > 0) {
      grouped.push(mergeToolRun(pending))
      pending = []
    }
  }

  for (const message of messages) {
    if (!isPlainToolMessage(message)) {
      flush()
      grouped.push(message)
      continue
    }

    const previous = pending[pending.length - 1]
    if (previous && !sameToolRunBoundary(previous, message)) {
      flush()
    }
    pending.push(message)
  }

  flush()
  return grouped
}

function stringMetadata(message: ChatMessage, key: string): string {
  const value = message.metadata?.[key]
  return typeof value === 'string' ? value : ''
}

function fanoutLaneGroupingKey(message: ChatMessage): string | null {
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
  for (const id of ids) {
    if (!id || out.includes(id)) continue
    out.push(id)
  }
  return out
}

function constituentMessageIds(message: ChatMessage): string[] {
  const out = [message.id]
  for (const id of groupedTranscriptMessageIds(message)) {
    if (!out.includes(id)) out.push(id)
  }
  return out
}

function metadataMediaRefs(message: ChatMessage): TranscriptMediaRef[] {
  const refs = message.metadata?.mediaRefs
  return Array.isArray(refs) ? (refs as TranscriptMediaRef[]) : []
}

function mergeMediaRefs(messages: ChatMessage[]): TranscriptMediaRef[] | undefined {
  const refs: TranscriptMediaRef[] = []
  for (const message of messages) {
    for (const ref of metadataMediaRefs(message)) {
      if (!refs.some((existing) => existing.id === ref.id)) refs.push(ref)
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

  for (const message of run) {
    const messageIds = constituentMessageIds(message)
    for (const id of messageIds) {
      if (!groupedFanoutMessageIds.includes(id)) groupedFanoutMessageIds.push(id)
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
        if (!groupedToolMessageIds.includes(id)) groupedToolMessageIds.push(id)
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

export function groupFanoutLaneMessages(messages: ChatMessage[]): ChatMessage[] {
  const grouped: ChatMessage[] = []
  let pending: ChatMessage[] = []
  let pendingKey: string | null = null

  const flush = (): void => {
    if (pending.length > 0) {
      grouped.push(mergeFanoutLaneRun(pending))
      pending = []
      pendingKey = null
    }
  }

  for (const message of messages) {
    const key = fanoutLaneGroupingKey(message)
    if (!key) {
      flush()
      grouped.push(message)
      continue
    }
    if (pendingKey && pendingKey !== key) flush()
    pending.push(message)
    pendingKey = key
  }

  flush()
  return grouped
}
