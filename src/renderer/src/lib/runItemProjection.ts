import type { ItemDeltaRunItemEvent, RunItemEvent } from '../../../shared/runItemEvents'
import type { AssistantDeltaInput } from './applyAssistantDelta'

export interface RunItemAssistantProjection {
  chatId: string
  runId: string
  itemId: string
  sequence: number
  input: AssistantDeltaInput
}

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
