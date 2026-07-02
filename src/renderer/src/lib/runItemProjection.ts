import type { ItemDeltaRunItemEvent, RunItemEvent } from '../../../shared/runItemEvents'
import type { AssistantDeltaInput } from './applyAssistantDelta'
import type { ProviderId } from '../../../main/store/types'

export interface RunItemAssistantProjection {
  chatId: string
  runId: string
  itemId: string
  sequence: number
  input: AssistantDeltaInput
}

export interface RunItemProjectedToolEvent {
  type: 'tool_event'
  name: string
  data: Record<string, unknown>
  timestamp: string
  isUse: boolean
  isResult: boolean
  provider?: ProviderId
}

export interface RunItemToolProjection {
  chatId: string
  runId: string
  itemId: string
  sequence: number
  legacySkipKey: string
  legacySkipKeys: string[]
  event: RunItemProjectedToolEvent
}

const LEGACY_VISIBLE_PROGRESS_TYPES = new Set([
  'update_topic',
  'invoke_agent',
  'summary',
  'intent',
  'progress',
  'tool_progress',
  'provider_warning'
])

export function isAssistantRunItemDelta(
  event: RunItemEvent
): event is ItemDeltaRunItemEvent & { channel: 'assistant' } {
  return event.kind === 'item/delta' && event.channel === 'assistant'
}

export function projectRunItemAssistantDelta(
  event: RunItemEvent,
  providerModelMetadata?: AssistantDeltaInput['providerModelMetadata']
): RunItemAssistantProjection | null {
  if (!isAssistantRunItemDelta(event)) return null
  if (!event.delta) return null
  return {
    chatId: event.chatId,
    runId: event.runId,
    itemId: event.itemId,
    sequence: event.sequence,
    input: {
      incoming: event.delta,
      runId: event.runId,
      cumulative: event.cumulative === true,
      // The sidecar lane's compat mapper tags every restatement
      // (cumulative || runItemCumulative || snapshot), so an untagged
      // item/delta is a verbatim increment — append it even when it
      // byte-matches the bubble (see resolveAssistantDeltaMerge).
      trustedIncremental: true,
      itemId: event.itemId,
      providerModelMetadata
    }
  }
}

export function legacyToolEventProjectionKey(
  runId: string,
  toolId: string | undefined,
  isResult: boolean
): string {
  return `${runId}\u0000${toolId || ''}\u0000${isResult ? 'result' : 'use'}`
}

export function legacyToolEventProjectionNameKey(
  runId: string,
  toolName: string | undefined,
  isResult: boolean
): string {
  return `${runId}\u0000name:${toolName || ''}\u0000${isResult ? 'result' : 'use'}`
}

function visibleProgressCompatType(event: RunItemEvent): string {
  const dataType =
    event.kind === 'tool/progress' &&
    event.data &&
    typeof event.data.type === 'string' &&
    event.data.type
  if (dataType) return dataType.toLowerCase()
  return event.kind === 'tool/progress' && typeof event.toolName === 'string'
    ? event.toolName.toLowerCase()
    : ''
}

function legacySkipKeys(
  runId: string,
  toolId: string | undefined,
  toolName: string | undefined,
  isResult: boolean
): { legacySkipKey: string; legacySkipKeys: string[] } {
  const keys = new Set([
    legacyToolEventProjectionKey(runId, toolId, isResult),
    legacyToolEventProjectionNameKey(runId, toolName, isResult)
  ])
  const legacySkipKey = legacyToolEventProjectionKey(runId, toolId, isResult)
  return { legacySkipKey, legacySkipKeys: Array.from(keys) }
}

function visibleString(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function stripHiddenProgressFields(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {}
  for (const [key, fieldValue] of Object.entries(value)) {
    if (/thought|thinking|chain|reasoning/i.test(key)) continue
    if (
      typeof fieldValue === 'string' ||
      typeof fieldValue === 'number' ||
      typeof fieldValue === 'boolean'
    ) {
      sanitized[key] = fieldValue
    }
  }
  return sanitized
}

function visibleProgressTitle(
  event: Extract<RunItemEvent, { kind: 'tool/progress' }>,
  toolName: string
): string {
  const payload = event.data && typeof event.data === 'object' ? event.data : {}
  return (
    visibleString(payload.title) ||
    visibleString(payload.topic) ||
    visibleString(event.title) ||
    (toolName === 'invoke_agent'
      ? 'Delegated task'
      : toolName === 'intent'
        ? 'Intent'
        : toolName === 'summary'
          ? 'Summary'
          : toolName === 'provider_warning'
            ? 'Provider warning'
            : 'Task update')
  )
}

function visibleProgressOutput(event: Extract<RunItemEvent, { kind: 'tool/progress' }>): string {
  const payload = event.data && typeof event.data === 'object' ? event.data : {}
  return (
    visibleString(event.summary) ||
    visibleString(payload.summary) ||
    visibleString(payload.message) ||
    visibleString(payload.text) ||
    visibleString(payload.content) ||
    visibleString(payload.intent)
  )
}

function visibleProgressStatus(
  event: Extract<RunItemEvent, { kind: 'tool/progress' }>
): 'success' | 'error' {
  const data = event.data && typeof event.data === 'object' ? event.data : {}
  return event.status === 'failed' ||
    event.status === 'error' ||
    data.status === 'failed' ||
    data.status === 'error' ||
    Boolean(data.error)
    ? 'error'
    : 'success'
}

export function projectRunItemToolEvents(
  event: RunItemEvent,
  provider?: ProviderId
): RunItemToolProjection[] {
  if (event.kind === 'tool/progress') {
    const toolId = event.toolCallId || event.itemId
    const compatType = visibleProgressCompatType(event)
    const isVisibleProgress = LEGACY_VISIBLE_PROGRESS_TYPES.has(compatType)
    const toolName = isVisibleProgress ? compatType : event.toolName || event.title || 'tool'
    const data = event.data && typeof event.data === 'object' ? event.data : {}
    const title = isVisibleProgress ? visibleProgressTitle(event, toolName) : event.title
    const output = isVisibleProgress ? visibleProgressOutput(event) : ''
    const parameters = isVisibleProgress
      ? {
          title,
          kind: toolName,
          ...(output ? { summary: output } : {}),
          ...stripHiddenProgressFields(data)
        }
      : {
          ...(event.title ? { title: event.title } : {}),
          ...(event.summary ? { summary: event.summary } : {}),
          ...(event.status ? { status: event.status } : {}),
          ...data
        }

    const useSkipKeys = legacySkipKeys(event.runId, toolId, toolName, false)
    const projections: RunItemToolProjection[] = [
      {
        chatId: event.chatId,
        runId: event.runId,
        itemId: event.itemId,
        sequence: event.sequence,
        ...useSkipKeys,
        event: {
          type: 'tool_event',
          name: toolName,
          data: {
            type: 'tool_use',
            tool_id: toolId,
            tool_name: toolName,
            parameters,
            ...(provider ? { provider } : {})
          },
          timestamp: event.createdAt,
          isUse: true,
          isResult: false,
          ...(provider ? { provider } : {})
        }
      }
    ]

    if (isVisibleProgress && output) {
      const resultSkipKeys = legacySkipKeys(event.runId, toolId, toolName, true)
      projections.push({
        chatId: event.chatId,
        runId: event.runId,
        itemId: event.itemId,
        sequence: event.sequence,
        ...resultSkipKeys,
        event: {
          type: 'tool_event',
          name: toolName,
          data: {
            type: 'tool_result',
            tool_id: toolId,
            tool_name: toolName,
            output,
            status: visibleProgressStatus(event),
            ...(provider ? { provider } : {})
          },
          timestamp: event.createdAt,
          isUse: false,
          isResult: true,
          ...(provider ? { provider } : {})
        }
      })
    }

    return projections
  }

  if (event.kind === 'tool/outputDelta') {
    const toolId = event.toolCallId || event.itemId
    const toolName = event.toolName || 'unknown'
    const output = event.output || event.delta
    const resultSkipKeys = legacySkipKeys(event.runId, toolId, toolName, true)
    return [
      {
        chatId: event.chatId,
        runId: event.runId,
        itemId: event.itemId,
        sequence: event.sequence,
        ...resultSkipKeys,
        event: {
          type: 'tool_event',
          name: toolName,
          data: {
            type: 'tool_result',
            tool_id: toolId,
            tool_name: toolName,
            output,
            content: output,
            status: event.status || 'success',
            ...(provider ? { provider } : {})
          },
          timestamp: event.createdAt,
          isUse: false,
          isResult: true,
          ...(provider ? { provider } : {})
        }
      }
    ]
  }

  return []
}

export function projectRunItemToolEvent(
  event: RunItemEvent,
  provider?: ProviderId
): RunItemToolProjection | null {
  return projectRunItemToolEvents(event, provider)[0] || null
}
