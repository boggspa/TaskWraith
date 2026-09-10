import type { ItemDeltaRunItemEvent, RunItemEvent } from '../../../shared/runItemEvents'
import type { AssistantDeltaInput } from './applyAssistantDelta'
import type { ProviderId } from '../../../main/store/types'
import { mergeToolResultParameters } from '../../../shared/toolInvocationPresentation'

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

/**
 * The exact shape the sidecar lane can carry into the transcript: an
 * assistant-channel `item/delta` that actually has text in it.
 *
 * `GeminiStreamAdapter` suppresses the legacy `assistant_message_delta` twin
 * on any line whose sidecar matches this, and `projectRunItemAssistantDelta`
 * below decides what the sidecar lane will apply — so the two MUST agree.
 * They were spelled out separately (`event.delta.length > 0` in the adapter,
 * `!event.delta` here) with nothing holding them in step; the moment they
 * drift, the adapter disarms the only other copy of the text for a delta the
 * projector then refuses, and the answer is lost with no fallback.
 */
export function carriesAssistantRunItemText(
  event: RunItemEvent
): event is ItemDeltaRunItemEvent & { channel: 'assistant' } {
  return isAssistantRunItemDelta(event) && typeof event.delta === 'string' && event.delta.length > 0
}

/** The route a wire line declares for itself (`sendAgentCompatLine` stamps
 *  both onto every payload it publishes). */
export interface RunItemWireRoute {
  appChatId?: unknown
  appRunId?: unknown
}

/**
 * True when a sidecar event is addressed to the same chat/run as the wire line
 * that carried it.
 *
 * The renderer's sidecar applier is keyed on the RUN's chat (`runChatId`), so a
 * sidecar addressed anywhere else is dropped there — while the legacy twin on
 * the same line IS applied to the run's chat. Suppressing that twin for a
 * sidecar the other lane will refuse is total, silent text loss, so the
 * dual-lane skip is scoped by this. A line that declares no route (legacy
 * spawns, unrouted main emissions) constrains nothing and matches.
 */
export function runItemEventMatchesWireRoute(
  event: RunItemEvent,
  route: RunItemWireRoute | null | undefined
): boolean {
  if (!route || typeof route !== 'object') return true
  const { appChatId, appRunId } = route
  if (typeof appChatId === 'string' && appChatId && appChatId !== event.chatId) return false
  if (typeof appRunId === 'string' && appRunId && appRunId !== event.runId) return false
  return true
}

export function projectRunItemAssistantDelta(
  event: RunItemEvent,
  providerModelMetadata?: AssistantDeltaInput['providerModelMetadata']
): RunItemAssistantProjection | null {
  if (!carriesAssistantRunItemText(event)) return null
  return {
    chatId: event.chatId,
    runId: event.runId,
    itemId: event.itemId,
    sequence: event.sequence,
    input: {
      incoming: event.delta,
      runId: event.runId,
      cumulative: event.cumulative === true,
      // Cursor's `assistant` frames restart at each post-tool prose segment;
      // they are cumulative within that segment, not guaranteed whole-turn
      // restatements. Preserve divergent post-tool snapshots instead of using
      // Claude's safe-to-skip divergent-envelope rule.
      ...(event.provider === 'cursor' && event.cumulative === true
        ? { preserveDivergentSnapshot: true }
        : {}),
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
    const compatType = visibleProgressCompatType(event)
    // Warnings remain available on the provider event stream for diagnostics
    // and runtime handling, but are not transcript tool calls. Without this
    // boundary they surface as a synthetic "Used Provider warning" activity.
    if (compatType === 'provider_warning') return []

    const toolId = event.toolCallId || event.itemId
    const isVisibleProgress = LEGACY_VISIBLE_PROGRESS_TYPES.has(compatType)
    const toolName = isVisibleProgress ? compatType : event.toolName || event.title || 'tool'
    const data = event.data && typeof event.data === 'object' ? event.data : {}
    const title = isVisibleProgress ? visibleProgressTitle(event, toolName) : event.title
    const output = isVisibleProgress ? visibleProgressOutput(event) : ''
    // Run-item `data` is already the sidecar's canonical argument bag. Do
    // not unwrap it a second time: capability_invoke deliberately owns an
    // outer `{ name, arguments }` envelope which the transcript presenter
    // needs in order to resolve the concrete target.
    const parameters = isVisibleProgress
      ? {
          title,
          kind: toolName,
          ...(output ? { summary: output } : {}),
          ...stripHiddenProgressFields(data)
        }
      : data
    const fallbackParameters =
      !isVisibleProgress && Object.keys(parameters).length === 0
        ? {
            ...(event.title ? { title: event.title } : {}),
            ...(event.summary ? { summary: event.summary } : {}),
            ...(event.status ? { status: event.status } : {}),
            ...data
          }
        : parameters

    const projections: RunItemToolProjection[] = [
      {
        chatId: event.chatId,
        runId: event.runId,
        itemId: event.itemId,
        sequence: event.sequence,
        event: {
          type: 'tool_event',
          name: toolName,
          data: {
            type: 'tool_use',
            tool_id: toolId,
            tool_name: toolName,
            parameters: fallbackParameters,
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
      projections.push({
        chatId: event.chatId,
        runId: event.runId,
        itemId: event.itemId,
        sequence: event.sequence,
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
    const resultParameters = mergeToolResultParameters(undefined, event.data)
    return [
      {
        chatId: event.chatId,
        runId: event.runId,
        itemId: event.itemId,
        sequence: event.sequence,
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
            // The renderer's legacy lane is intentionally skipped whenever a
            // sidecar rides the same line. Keep terminal `changes`, patches,
            // and provider-specific result arguments here so pairToolResult
            // receives the same evidence as the skipped legacy event.
            parameters: resultParameters,
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
