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
      itemId: event.itemId,
      providerModelMetadata
    }
  }
}

export function legacyAssistantDeltaProjectionKey(
  runId: string,
  itemId: string | undefined,
  content: string
): string {
  return `${runId}\u0000${itemId || ''}\u0000${content}`
}

export function legacyToolEventProjectionKey(
  runId: string,
  toolId: string | undefined,
  isResult: boolean
): string {
  return `${runId}\u0000${toolId || ''}\u0000${isResult ? 'result' : 'use'}`
}

function visibleProgressCompatType(event: RunItemEvent): string {
  const dataType =
    event.kind === 'tool/progress' &&
    event.data &&
    typeof event.data.type === 'string' &&
    event.data.type
  return dataType ? dataType.toLowerCase() : ''
}

export function projectRunItemToolEvent(
  event: RunItemEvent,
  provider?: ProviderId
): RunItemToolProjection | null {
  if (event.kind === 'tool/progress') {
    if (LEGACY_VISIBLE_PROGRESS_TYPES.has(visibleProgressCompatType(event))) return null
    const toolId = event.toolCallId || event.itemId
    const toolName = event.toolName || event.title || 'tool'
    const parameters = {
      ...(event.title ? { title: event.title } : {}),
      ...(event.summary ? { summary: event.summary } : {}),
      ...(event.status ? { status: event.status } : {}),
      ...(event.data && typeof event.data === 'object' ? event.data : {})
    }
    return {
      chatId: event.chatId,
      runId: event.runId,
      itemId: event.itemId,
      sequence: event.sequence,
      legacySkipKey: legacyToolEventProjectionKey(event.runId, toolId, false),
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
  }

  if (event.kind === 'tool/outputDelta') {
    const toolId = event.toolCallId || event.itemId
    const toolName = event.toolName || 'unknown'
    const output = event.output || event.delta
    return {
      chatId: event.chatId,
      runId: event.runId,
      itemId: event.itemId,
      sequence: event.sequence,
      legacySkipKey: legacyToolEventProjectionKey(event.runId, toolId, true),
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
  }

  return null
}
