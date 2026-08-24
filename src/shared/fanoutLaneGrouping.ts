import type { ChatMessage, ToolActivity, TranscriptMediaRef } from '../main/store/types'
import { coalesceMirroredTaskWraithActivities } from './toolActivityMirrorCoalesce'

/**
 * Fan-out lane grouping — the presentation-time fold that turns one lane's
 * persisted fragments (assistant content messages + `ensembleParticipantTools`
 * tool messages, interleaved in production order) into a single synthetic
 * assistant message carrying `ensembleFanoutTranscriptParts`.
 *
 * Lives in shared/ because BOTH transcript surfaces must fold identically:
 * the desktop renderer (TranscriptPanel → EnsembleFanoutResultCard) and the
 * remote projection (RemoteThreadProjection → iOS lane card). Before the
 * projection folded, the phone received the raw fragments — one card per
 * content flush with unbranded tool rows loose between them — which is the
 * divergence this module exists to prevent. Moved verbatim from
 * `renderer/lib/transcriptToolMessageGrouping.ts`; the renderer re-exports
 * from here, so this file is the single source of the fold's semantics.
 */

export type EnsembleFanoutTranscriptPart =
  | {
      kind: 'content'
      id: string
      messageIds: string[]
      content: string
    }
  | {
      kind: 'tools'
      id: string
      messageIds: string[]
      toolActivities: ToolActivity[]
    }

export function isEnsembleFanoutResultMessage(message: ChatMessage): boolean {
  return (
    message.role === 'assistant' &&
    message.metadata?.kind === 'ensembleParticipant' &&
    typeof message.metadata?.ensembleLaneId === 'string' &&
    message.metadata.ensembleLaneId.trim().length > 0
  )
}

export function readEnsembleFanoutTranscriptParts(
  message: ChatMessage
): EnsembleFanoutTranscriptPart[] {
  const raw = message.metadata?.ensembleFanoutTranscriptParts
  if (!Array.isArray(raw)) return []
  const parts: EnsembleFanoutTranscriptPart[] = []
  for (const part of raw) {
    if (!part || typeof part !== 'object') continue
    const candidate = part as Record<string, unknown>
    const id = typeof candidate.id === 'string' ? candidate.id : ''
    const messageIds = Array.isArray(candidate.messageIds)
      ? candidate.messageIds.filter((item): item is string => typeof item === 'string')
      : []
    if (!id || messageIds.length === 0) continue
    if (candidate.kind === 'content' && typeof candidate.content === 'string') {
      parts.push({ kind: 'content', id, messageIds, content: candidate.content })
      continue
    }
    if (candidate.kind === 'tools' && Array.isArray(candidate.toolActivities)) {
      parts.push({
        kind: 'tools',
        id,
        messageIds,
        toolActivities: candidate.toolActivities as ToolActivity[]
      })
    }
  }
  return parts
}

function stringMetadata(message: ChatMessage, key: string): string {
  const value = message.metadata?.[key]
  return typeof value === 'string' ? value : ''
}

// NUL separator (cannot occur inside an id), built via fromCharCode because a
// literal backslash-u-0000 escape in source is written out as a RAW NUL byte,
// which turns the file binary. Same value the renderer original used.
const LANE_KEY_SEPARATOR = String.fromCharCode(0)

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
  ].join(LANE_KEY_SEPARATOR)
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

  // Fan-out is a transcript presentation mode, not a separate provider
  // protocol. Apply the same proved native↔host mirror coalescing as ordinary
  // tool runs, then reflect the retained activity in every rendered part so a
  // Kimi/Mistral wrapper cannot hide the host's path or diff badge here.
  const coalescedActivities = coalesceMirroredTaskWraithActivities(activities)
  const coalescedById = new Map(coalescedActivities.map((activity) => [activity.id, activity]))
  const coalescedParts = parts.flatMap((part): EnsembleFanoutTranscriptPart[] => {
    if (part.kind === 'content') return [part]
    const toolActivities = part.toolActivities
      .map((activity) => coalescedById.get(activity.id))
      .filter((activity): activity is ToolActivity => Boolean(activity))
    return toolActivities.length > 0 ? [{ ...part, toolActivities }] : []
  })

  const mediaRefs = mergeMediaRefs(run)
  return {
    ...base,
    id: firstToolConstituentId || first.id,
    role: 'assistant',
    content: contentBlocks.join('\n\n'),
    timestamp: first.timestamp,
    runId: base.runId || first.runId,
    ...(coalescedActivities.length > 0 ? { toolActivities: coalescedActivities } : {}),
    metadata: {
      ...base.metadata,
      kind: 'ensembleParticipant',
      groupedFanoutMessageIds,
      ...(groupedToolMessageIds.length > 0 ? { groupedToolMessageIds } : {}),
      ensembleFanoutTranscriptParts: coalescedParts,
      ...(mediaRefs ? { mediaRefs } : {})
    }
  }
}

export interface FanoutLaneGroupingCacheEntry {
  sourceMessages: readonly ChatMessage[]
  message: ChatMessage
}

export interface FanoutLaneGroupingState {
  output: ChatMessage[]
  groups: ReadonlyMap<string, FanoutLaneGroupingCacheEntry>
}

function sameMessageReferences(
  previous: readonly ChatMessage[],
  next: readonly ChatMessage[]
): boolean {
  return (
    previous.length === next.length && previous.every((message, index) => message === next[index])
  )
}

/**
 * Fold every fragment from one fan-out lane into a single first-anchored card,
 * even when system rows or concurrent lanes were appended between fragments.
 * Unrelated rows retain their original relative order. The optional previous
 * state preserves synthetic message identity for unchanged historical lanes,
 * which keeps transcript row/measurement caches stable while a live tail grows.
 */
export function groupFanoutLaneMessagesStable(
  messages: readonly ChatMessage[],
  previous?: FanoutLaneGroupingState | null
): FanoutLaneGroupingState {
  const sourceGroups = new Map<string, ChatMessage[]>()
  for (const message of messages) {
    const key = fanoutLaneGroupingKey(message)
    if (!key) continue
    const group = sourceGroups.get(key)
    if (group) group.push(message)
    else sourceGroups.set(key, [message])
  }

  const groups = new Map<string, FanoutLaneGroupingCacheEntry>()
  for (const [key, sourceMessages] of sourceGroups) {
    const cached = previous?.groups.get(key)
    const message =
      cached && sameMessageReferences(cached.sourceMessages, sourceMessages)
        ? cached.message
        : mergeFanoutLaneRun(sourceMessages)
    groups.set(key, { sourceMessages, message })
  }

  const output: ChatMessage[] = []
  const emitted = new Set<string>()
  for (const message of messages) {
    const key = fanoutLaneGroupingKey(message)
    if (!key) {
      output.push(message)
      continue
    }
    if (emitted.has(key)) continue
    emitted.add(key)
    output.push(groups.get(key)?.message || message)
  }

  return { output, groups }
}

export function groupFanoutLaneMessages(messages: ChatMessage[]): ChatMessage[] {
  return groupFanoutLaneMessagesStable(messages).output
}
