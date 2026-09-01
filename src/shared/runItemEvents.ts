/**
 * Internal structured stream protocol for provider runs.
 *
 * The legacy live transport is still compat JSONL (`content`, `tool_use`,
 * `tool_result`, `result`, ...). `RunItemEvent` is the item-native sidecar
 * carried beside that compat lane while the renderer and remote clients migrate
 * toward treating chat messages as a projection of run items.
 */

export type RunItemEventProvider =
  | 'gemini'
  | 'codex'
  | 'claude'
  | 'kimi'
  | 'grok'
  | 'cursor'
  | 'ollama'
  | 'antigravity'
  | 'pi'
  | 'mistral'
  | 'muse'
  | 'devin'

export type RunItemEventKind =
  | 'run/started'
  | 'turn/started'
  | 'item/started'
  | 'item/delta'
  | 'item/completed'
  | 'tool/progress'
  | 'tool/outputDelta'
  | 'run/completed'

export type RunItemKind =
  | 'assistant_message'
  | 'reasoning'
  | 'tool'
  | 'plan'
  | 'command'
  | 'file_change'
  | 'media'
  | 'run'
  | 'unknown'

export type RunItemDeltaChannel =
  | 'assistant'
  | 'reasoning'
  | 'stdout'
  | 'stderr'
  | 'diff'
  | 'media'
  | 'tool'

export interface RunItemEventBase {
  protocolVersion: 1
  kind: RunItemEventKind
  chatId: string
  runId: string
  provider: RunItemEventProvider
  participantId?: string
  providerSessionId?: string
  providerRunId?: string
  turnId?: string
  itemId?: string
  parentItemId?: string
  sequence: number
  createdAt: string
  source?: 'provider' | 'adapter' | 'taskwraith'
}

export interface RunStartedItemEvent extends RunItemEventBase {
  kind: 'run/started'
  itemKind?: 'run'
  model?: string
  modelLabel?: string
  fallback?: boolean
}

export interface TurnStartedItemEvent extends RunItemEventBase {
  kind: 'turn/started'
  turnId: string
}

export interface ItemStartedRunItemEvent extends RunItemEventBase {
  kind: 'item/started'
  itemId: string
  itemKind: RunItemKind
  title?: string
  toolName?: string
  data?: Record<string, unknown>
}

export interface ItemDeltaRunItemEvent extends RunItemEventBase {
  kind: 'item/delta'
  itemId: string
  itemKind?: RunItemKind
  channel: RunItemDeltaChannel
  delta: string
  cumulative?: boolean
  model?: string
  modelLabel?: string
}

export interface ItemCompletedRunItemEvent extends RunItemEventBase {
  kind: 'item/completed'
  itemId: string
  itemKind?: RunItemKind
  status?: string
  finalText?: string
}

export interface ToolProgressRunItemEvent extends RunItemEventBase {
  kind: 'tool/progress'
  itemId: string
  toolCallId?: string
  toolName?: string
  status?: string
  title?: string
  summary?: string
  data?: Record<string, unknown>
}

export interface ToolOutputDeltaRunItemEvent extends RunItemEventBase {
  kind: 'tool/outputDelta'
  itemId: string
  toolCallId?: string
  toolName?: string
  status?: string
  delta: string
  output?: string
  data?: Record<string, unknown>
}

export interface RunCompletedItemEvent extends RunItemEventBase {
  kind: 'run/completed'
  itemKind?: 'run'
  status: string
  exitCode?: number | null
  stats?: Record<string, unknown>
}

export type RunItemEvent =
  | RunStartedItemEvent
  | TurnStartedItemEvent
  | ItemStartedRunItemEvent
  | ItemDeltaRunItemEvent
  | ItemCompletedRunItemEvent
  | ToolProgressRunItemEvent
  | ToolOutputDeltaRunItemEvent
  | RunCompletedItemEvent

type RunItemEventEnvelopeKeys =
  | 'protocolVersion'
  | 'chatId'
  | 'runId'
  | 'provider'
  | 'sequence'
  | 'createdAt'

type DraftEnvelopeOverrides = Partial<
  Pick<RunItemEventBase, 'chatId' | 'runId' | 'provider' | 'sequence' | 'createdAt'>
>

export type RunItemEventDraft =
  | (Omit<RunStartedItemEvent, RunItemEventEnvelopeKeys> & DraftEnvelopeOverrides)
  | (Omit<TurnStartedItemEvent, RunItemEventEnvelopeKeys> & DraftEnvelopeOverrides)
  | (Omit<ItemStartedRunItemEvent, RunItemEventEnvelopeKeys> & DraftEnvelopeOverrides)
  | (Omit<ItemDeltaRunItemEvent, RunItemEventEnvelopeKeys> & DraftEnvelopeOverrides)
  | (Omit<ItemCompletedRunItemEvent, RunItemEventEnvelopeKeys> & DraftEnvelopeOverrides)
  | (Omit<ToolProgressRunItemEvent, RunItemEventEnvelopeKeys> & DraftEnvelopeOverrides)
  | (Omit<ToolOutputDeltaRunItemEvent, RunItemEventEnvelopeKeys> & DraftEnvelopeOverrides)
  | (Omit<RunCompletedItemEvent, RunItemEventEnvelopeKeys> & DraftEnvelopeOverrides)

export interface RunItemEventIdentity {
  chatId: string
  runId: string
  provider: RunItemEventProvider
  participantId?: string
  providerSessionId?: string
  providerRunId?: string
  turnId?: string
}

export function createRunItemEvent(
  identity: RunItemEventIdentity,
  draft: RunItemEventDraft,
  sequence: number,
  createdAt: string
): RunItemEvent {
  return {
    ...draft,
    protocolVersion: 1,
    chatId: draft.chatId || identity.chatId,
    runId: draft.runId || identity.runId,
    provider: draft.provider || identity.provider,
    ...(draft.participantId || identity.participantId
      ? { participantId: draft.participantId || identity.participantId }
      : {}),
    ...(draft.providerSessionId || identity.providerSessionId
      ? { providerSessionId: draft.providerSessionId || identity.providerSessionId }
      : {}),
    ...(draft.providerRunId || identity.providerRunId
      ? { providerRunId: draft.providerRunId || identity.providerRunId }
      : {}),
    ...(draft.turnId || identity.turnId ? { turnId: draft.turnId || identity.turnId } : {}),
    sequence: draft.sequence || sequence,
    createdAt: draft.createdAt || createdAt
  } as RunItemEvent
}

export function isRunItemEvent(value: unknown): value is RunItemEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<RunItemEvent>
  return (
    event.protocolVersion === 1 &&
    typeof event.kind === 'string' &&
    typeof event.chatId === 'string' &&
    typeof event.runId === 'string' &&
    typeof event.provider === 'string' &&
    typeof event.sequence === 'number' &&
    typeof event.createdAt === 'string'
  )
}

export function coerceRunItemEvents(value: unknown): RunItemEvent[] {
  if (Array.isArray(value)) return value.filter(isRunItemEvent)
  return isRunItemEvent(value) ? [value] : []
}

export function runItemEventSummary(event: RunItemEvent): string {
  switch (event.kind) {
    case 'run/started':
      return `Run started${event.model ? `: ${event.model}` : ''}`
    case 'turn/started':
      return `Turn started: ${event.turnId}`
    case 'item/started':
      return `Item started: ${event.itemKind}${event.toolName ? `/${event.toolName}` : ''}`
    case 'item/delta':
      return `Item delta: ${event.channel} +${event.delta.length}`
    case 'item/completed':
      return `Item completed: ${event.status || 'complete'}`
    case 'tool/progress':
      return `Tool progress: ${event.toolName || event.itemId}`
    case 'tool/outputDelta':
      return `Tool output: ${event.toolName || event.itemId} +${event.delta.length}`
    case 'run/completed':
      return `Run completed: ${event.status}`
  }
}
