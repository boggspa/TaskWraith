import { coerceRunItemEvents, type RunItemEvent } from '../../../shared/runItemEvents'
import type { ClaudeWorkflowTelemetry } from '../../../shared/claudeWorkflow'
import type { CodexReviewTelemetry } from '../../../shared/codexReview'
import type { CodexMultiAgentTelemetry } from '../../../shared/codexMultiAgent'
import type {
  ContextCompactionSignalKind,
  ContextCompactionTelemetry
} from '../../../shared/contextCompaction'

export type NormalizedEvent =
  | {
      type: 'run_started'
      session_id: string
      model: string
      modelLabel?: string
      timestamp: string
      fallback?: boolean
    }
  | { type: 'user_message'; content: string; timestamp: string }
  // Phase K1 — Codex emits `itemId` per logical assistant-message item.
  // The renderer doesn't scope deltas by item today (see Phase K2 trade-off
  // re: multi-bubble per turn), but propagating the id here is a pure data
  // plumbing change so when we want to wire item-scoped append, the
  // metadata is already present at the adapter boundary.
  | {
      type: 'assistant_message_delta'
      content: string
      itemId?: string
      cumulative?: boolean
      model?: string
      modelLabel?: string
      projectedFromRunItem?: boolean
    }
  | { type: 'assistant_media_refs'; mediaRefs: any[] }
  | { type: 'assistant_message_complete'; content: string; itemId?: string }
  | { type: 'run_item_event'; event: RunItemEvent }
  // Claude-native Workflow telemetry, keyed back to the originating `Workflow`
  // tool activity by tool_use id. Not a tool row of its own — the renderer
  // merges it onto that activity's `workflowSummary` to drive the workflow card.
  | { type: 'workflow_telemetry'; toolUseId?: string; telemetry: Partial<ClaudeWorkflowTelemetry> }
  // Codex native-review status, keyed back to the synthesized `codex_review`
  // anchor by tool_use id. Merged onto that activity's `reviewSummary`.
  | { type: 'review_telemetry'; toolUseId?: string; telemetry: Partial<CodexReviewTelemetry> }
  // Codex native Multi-agent episode status, keyed back to the synthesized
  // `codex_multi_agent` anchor by tool_use id. Merged onto that activity's
  // `multiAgentSummary` to drive the Codex Multi-agent card.
  | {
      type: 'multi_agent_telemetry'
      toolUseId?: string
      telemetry: Partial<CodexMultiAgentTelemetry>
    }
  // Provider context-window compaction (src/shared/contextCompaction.ts) —
  // rides its own compat line so it can never enter the assistant-text lanes.
  // The renderer appends a persisted `contextCompaction` system card for
  // completed/failed signals (solo chats only; the orchestrator is canonical
  // for ensembles).
  | {
      type: 'compaction_notice'
      kind: ContextCompactionSignalKind
      telemetry: ContextCompactionTelemetry
    }
  | {
      type: 'tool_event'
      name: string
      data: any
      timestamp: string
      isUse: boolean
      isResult: boolean
    }
  | { type: 'error'; message: string; timestamp: string }
  | {
      type: 'run_finished'
      status: string
      stats: any
      timestamp: string
      providerThreadId?: string
    }
  | { type: 'raw_event'; data: any }
  | { type: 'malformed_json'; text: string }

export class GeminiStreamAdapter {
  private buffer = ''

  constructor(private onEvent: (event: NormalizedEvent) => void) {}

  public appendChunk(chunk: string) {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    // The last element is either an empty string (if chunk ended in \n)
    // or an incomplete line.
    this.buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue
      this.parseLine(line)
    }
  }

  public end() {
    if (this.buffer.trim()) {
      this.parseLine(this.buffer)
      this.buffer = ''
    }
  }

  private parseLine(line: string) {
    try {
      const parsed = JSON.parse(line)
      const runItemEvents = coerceRunItemEvents(parsed?.runItemEvents)
      const projectedAssistantDeltaFromRunItem = runItemEvents.some(
        (event) =>
          event.kind === 'item/delta' && event.channel === 'assistant' && event.delta.length > 0
      )
      for (const event of runItemEvents) {
        this.onEvent({ type: 'run_item_event', event })
      }
      this.normalizeEvent(parsed, { projectedAssistantDeltaFromRunItem })
      this.onEvent({ type: 'raw_event', data: parsed })
    } catch {
      this.onEvent({ type: 'malformed_json', text: line })
    }
  }

  private normalizeEvent(
    parsed: any,
    hints: { projectedAssistantDeltaFromRunItem?: boolean } = {}
  ) {
    if (!parsed || typeof parsed !== 'object') return

    // Provider-native workflow telemetry rides its own compat line. Intercept
    // BEFORE the visible-progress / tool-event paths so a `task_notification`
    // summary isn't mis-rendered as a generic "Summary" tool row. The
    // originating provider is carried at top level; fold it into the telemetry
    // so the card can pick its glyph/accent (the downstream merge is otherwise
    // provider-blind).
    if (parsed.type === 'workflow_event') {
      const workflow =
        parsed.workflow && typeof parsed.workflow === 'object' && !Array.isArray(parsed.workflow)
          ? parsed.workflow
          : {}
      this.onEvent({
        type: 'workflow_telemetry',
        ...(typeof parsed.tool_id === 'string' && parsed.tool_id
          ? { toolUseId: parsed.tool_id }
          : {}),
        telemetry:
          typeof parsed.provider === 'string' && parsed.provider && !workflow.provider
            ? { ...workflow, provider: parsed.provider }
            : workflow
      })
      return
    }

    // Codex native-review status rides its own compat line, same shape/pattern
    // as workflow_event — intercept before the tool-event paths so it never
    // becomes a generic tool row.
    if (parsed.type === 'review_event') {
      const review =
        parsed.review && typeof parsed.review === 'object' && !Array.isArray(parsed.review)
          ? parsed.review
          : {}
      this.onEvent({
        type: 'review_telemetry',
        ...(typeof parsed.tool_id === 'string' && parsed.tool_id
          ? { toolUseId: parsed.tool_id }
          : {}),
        telemetry:
          typeof parsed.provider === 'string' && parsed.provider && !review.provider
            ? { ...review, provider: parsed.provider }
            : review
      })
      return
    }

    // Codex native Multi-agent episode status rides its own compat line, same
    // shape/pattern as workflow_event/review_event — intercept before the
    // tool-event paths so coordination never becomes a generic tool row.
    if (parsed.type === 'multi_agent_event') {
      const multiAgent =
        parsed.multiAgent &&
        typeof parsed.multiAgent === 'object' &&
        !Array.isArray(parsed.multiAgent)
          ? parsed.multiAgent
          : {}
      this.onEvent({
        type: 'multi_agent_telemetry',
        ...(typeof parsed.tool_id === 'string' && parsed.tool_id
          ? { toolUseId: parsed.tool_id }
          : {}),
        telemetry:
          typeof parsed.provider === 'string' && parsed.provider && !multiAgent.provider
            ? { ...multiAgent, provider: parsed.provider }
            : multiAgent
      })
      return
    }

    // Provider context-compaction signals ride their own compat line, same
    // pattern as workflow_event/review_event — intercept before the
    // visible-progress / tool-event paths so they never render as tool rows.
    if (parsed.type === 'compaction_event') {
      const compaction =
        parsed.compaction &&
        typeof parsed.compaction === 'object' &&
        !Array.isArray(parsed.compaction)
          ? parsed.compaction
          : {}
      const kind: ContextCompactionSignalKind =
        compaction.kind === 'started' || compaction.kind === 'failed'
          ? compaction.kind
          : 'completed'
      const telemetry =
        compaction.telemetry &&
        typeof compaction.telemetry === 'object' &&
        !Array.isArray(compaction.telemetry)
          ? compaction.telemetry
          : {}
      this.onEvent({
        type: 'compaction_notice',
        kind,
        telemetry:
          typeof parsed.provider === 'string' && parsed.provider && !telemetry.provider
            ? { ...telemetry, provider: parsed.provider }
            : telemetry
      })
      return
    }

    if (this.emitVisibleProgress(parsed)) {
      return
    }

    switch (parsed.type) {
      case 'init':
        this.onEvent({
          type: 'run_started',
          session_id:
            parsed.session_id || parsed.providerThreadId || parsed.provider_thread_id || '',
          model: parsed.model || 'unknown',
          ...(typeof parsed.modelLabel === 'string' || typeof parsed.model_label === 'string'
            ? { modelLabel: parsed.modelLabel || parsed.model_label }
            : {}),
          timestamp: parsed.timestamp || new Date().toISOString(),
          fallback: Boolean(parsed.fallback)
        })
        break
      case 'content': {
        // Phase K1 — propagate `itemId` (Codex item id) and respect the
        // `complete: true` sentinel that main emits at the end of each
        // `agentMessage` item. The sentinel carries empty text; we skip
        // emitting an event for it so the renderer doesn't see a
        // zero-content "complete" that would clobber the live message.
        // Item-scoped append (multiple bubbles per turn) is a separate
        // Phase K2 trade-off and is intentionally NOT wired here.
        const itemId =
          typeof parsed.itemId === 'string' && parsed.itemId ? parsed.itemId : undefined
        const text = parsed.text || parsed.content || ''
        if (parsed.complete === true && !text) {
          // End-of-item sentinel — no payload to render. Skip.
          break
        }
        this.onEvent({
          type: 'assistant_message_delta',
          content: text,
          ...(itemId ? { itemId } : {}),
          ...(typeof parsed.model === 'string' && parsed.model ? { model: parsed.model } : {}),
          ...(typeof parsed.modelLabel === 'string' || typeof parsed.model_label === 'string'
            ? { modelLabel: parsed.modelLabel || parsed.model_label }
            : {}),
          // 1.0.6 dup-fix — main tags a cumulative full-turn re-statement
          // (Claude's divergent envelope) so the renderer REPLACES the
          // bubble instead of appending and doubling it.
          ...(parsed.cumulative === true ? { cumulative: true } : {}),
          ...(hints.projectedAssistantDeltaFromRunItem ? { projectedFromRunItem: true } : {})
        })
        break
      }
      case 'media_refs':
        if (Array.isArray(parsed.mediaRefs)) {
          this.onEvent({
            type: 'assistant_media_refs',
            mediaRefs: parsed.mediaRefs
          })
        }
        break
      case 'message':
        if (parsed.role === 'user') {
          this.onEvent({
            type: 'user_message',
            content: parsed.content || '',
            timestamp: parsed.timestamp || new Date().toISOString()
          })
        } else if (parsed.role === 'assistant') {
          if (parsed.delta) {
            this.onEvent({
              type: 'assistant_message_delta',
              content: parsed.content || '',
              ...(hints.projectedAssistantDeltaFromRunItem ? { projectedFromRunItem: true } : {})
            })
          } else {
            this.onEvent({
              type: 'assistant_message_complete',
              content: parsed.content || ''
            })
          }
        }
        break
      case 'result':
        this.onEvent({
          type: 'run_finished',
          status: parsed.status || 'unknown',
          stats: parsed.stats || {},
          timestamp: parsed.timestamp || new Date().toISOString(),
          providerThreadId:
            parsed.providerThreadId ||
            parsed.provider_thread_id ||
            parsed.session_id ||
            parsed.sessionId
        })
        break
      case 'error':
        this.onEvent({
          type: 'error',
          message: parsed.message || parsed.error || 'Unknown error',
          timestamp: parsed.timestamp || new Date().toISOString()
        })
        break
      default:
        // E.g., 'token', or tool calls
        // Note: The previous logic treated 'token' as textual output.
        // We'll treat them as tool_event or raw data. If it's literally 'token',
        // maybe it's just text chunks, but we map 'assistant_message_delta' from 'delta: true' messages.
        // If the CLI emits `{ "type": "token", "content": "..." }`, we can map it to delta:
        if (parsed.type === 'token') {
          this.onEvent({
            type: 'assistant_message_delta',
            content: parsed.content || '',
            ...(hints.projectedAssistantDeltaFromRunItem ? { projectedFromRunItem: true } : {})
          })
        } else {
          const isUse = parsed.type === 'tool_use' || parsed.type === 'tool_call'
          const isSubagentEvent =
            String(
              parsed.params?.type || parsed.item?.type || parsed.params?.item?.type || ''
            ).toLowerCase() === 'subagentevent'
          const isResult =
            parsed.type === 'tool_result' ||
            parsed.type === 'tool_output' ||
            parsed.type === 'tool_response'
          const toolName =
            parsed.tool_name ||
            parsed.toolName ||
            parsed.name ||
            parsed.function?.name ||
            parsed.tool ||
            parsed.params?.type ||
            parsed.item?.type ||
            parsed.params?.item?.type ||
            parsed.type ||
            'unknown'
          const normalizedData = isSubagentEvent
            ? {
                ...parsed,
                type: 'tool_use',
                tool_name: toolName,
                tool_id:
                  parsed.params?.agent_id ||
                  parsed.params?.parent_tool_call_id ||
                  parsed.id ||
                  `${toolName}-${Date.now()}`
              }
            : parsed
          this.onEvent({
            type: 'tool_event',
            name: toolName,
            data: normalizedData,
            timestamp: parsed.timestamp || new Date().toISOString(),
            isUse: isUse || isSubagentEvent,
            isResult
          })
        }
        break
    }
  }

  private emitVisibleProgress(parsed: any): boolean {
    const eventName = String(
      parsed.type || parsed.name || parsed.tool_name || parsed.method || ''
    ).trim()
    const payload = parsed.payload || parsed.params?.payload || parsed.params || parsed
    const normalizedName = eventName.toLowerCase()
    const hasTopLevelSummary = typeof parsed.summary === 'string' && normalizedName !== 'result'
    const progressNames = new Set([
      'update_topic',
      'invoke_agent',
      'summary',
      'intent',
      'progress',
      'tool_progress'
    ])
    if (!progressNames.has(normalizedName) && !hasTopLevelSummary) {
      return false
    }

    const toolName =
      hasTopLevelSummary && !progressNames.has(normalizedName) ? 'summary' : normalizedName
    const title =
      this.visibleString(payload?.title) ||
      this.visibleString(payload?.topic) ||
      this.visibleString(parsed.title) ||
      (toolName === 'invoke_agent'
        ? 'Delegated task'
        : toolName === 'intent'
          ? 'Intent'
          : toolName === 'summary'
            ? 'Summary'
            : 'Task update')
    const output =
      this.visibleString(payload?.summary) ||
      this.visibleString(parsed.summary) ||
      this.visibleString(payload?.message) ||
      this.visibleString(payload?.text) ||
      this.visibleString(payload?.content) ||
      this.visibleString(parsed.text) ||
      this.visibleString(parsed.content) ||
      this.visibleString(payload?.intent) ||
      this.visibleString(parsed.intent)
    const toolId = String(
      parsed.tool_id || parsed.toolId || parsed.id || `${toolName}-${Date.now()}`
    )
    const parameters = {
      title,
      kind: toolName,
      ...(output ? { summary: output } : {}),
      ...(payload && typeof payload === 'object' ? this.stripHiddenProgressFields(payload) : {})
    }

    this.onEvent({
      type: 'tool_event',
      name: toolName,
      data: {
        type: 'tool_use',
        tool_id: toolId,
        tool_name: toolName,
        parameters,
        provider: parsed.provider
      },
      timestamp: parsed.timestamp || new Date().toISOString(),
      isUse: true,
      isResult: false
    })

    if (output) {
      this.onEvent({
        type: 'tool_event',
        name: toolName,
        data: {
          type: 'tool_result',
          tool_id: toolId,
          tool_name: toolName,
          output,
          status: parsed.status === 'failed' || parsed.error ? 'error' : 'success',
          provider: parsed.provider
        },
        timestamp: parsed.timestamp || new Date().toISOString(),
        isUse: false,
        isResult: true
      })
    }

    return true
  }

  private visibleString(value: unknown): string {
    if (typeof value === 'string') return value.trim()
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    return ''
  }

  private stripHiddenProgressFields(value: Record<string, unknown>): Record<string, unknown> {
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
}
