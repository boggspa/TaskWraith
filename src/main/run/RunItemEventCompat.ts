import {
  createRunItemEvent,
  type RunItemEvent,
  type RunItemEventDraft,
  type RunItemEventIdentity,
  type RunItemEventProvider,
  type RunItemKind
} from '../../shared/runItemEvents'

export interface CompatRunItemIdentity {
  chatId: string
  runId: string
  provider: RunItemEventProvider
  participantId?: string
  providerSessionId?: string
  providerRunId?: string
  turnId?: string
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function payloadRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function statusFromPayload(record: Record<string, unknown>): string | undefined {
  const status = stringField(record, 'status', 'subtype')
  if (status) return status
  if (record.is_error === true || typeof record.error === 'string') return 'error'
  return undefined
}

function runItemId(identity: CompatRunItemIdentity, suffix: string): string {
  return `${identity.runId}:${suffix}`
}

export class RunItemEventCompatMapper {
  private sequenceByRunId = new Map<string, number>()
  private startedItems = new Set<string>()
  private completedRuns = new Set<string>()
  private idlessToolSeqByRunId = new Map<string, number>()
  private idlessToolIdByRunAndName = new Map<string, string>()
  private latestIdlessToolIdByRunId = new Map<string, string>()

  createEvents(identity: CompatRunItemIdentity, payload: unknown, createdAt = new Date().toISOString()): RunItemEvent[] {
    const record = payloadRecord(payload)
    if (!record) return []
    const drafts = this.draftsFromPayload(identity, record)
    return this.createDraftEvents(identity, drafts, createdAt)
  }

  createDraftEvents(
    identity: CompatRunItemIdentity,
    drafts: RunItemEventDraft[],
    createdAt = new Date().toISOString()
  ): RunItemEvent[] {
    if (drafts.length === 0) return []
    const filteredDrafts: RunItemEventDraft[] = []
    for (const draft of drafts) {
      if (draft.kind === 'run/completed') {
        if (this.completedRuns.has(identity.runId)) continue
        this.completedRuns.add(identity.runId)
      }
      filteredDrafts.push(draft)
    }
    if (filteredDrafts.length === 0) return []
    const base: RunItemEventIdentity = {
      chatId: identity.chatId,
      runId: identity.runId,
      provider: identity.provider,
      ...(identity.participantId ? { participantId: identity.participantId } : {}),
      ...(identity.providerSessionId ? { providerSessionId: identity.providerSessionId } : {}),
      ...(identity.providerRunId ? { providerRunId: identity.providerRunId } : {}),
      ...(identity.turnId ? { turnId: identity.turnId } : {})
    }
    return filteredDrafts.map((draft) =>
      createRunItemEvent(base, draft, this.nextSequence(identity.runId), createdAt)
    )
  }

  completeRun(runId: string): void {
    this.sequenceByRunId.delete(runId)
    this.idlessToolSeqByRunId.delete(runId)
    this.latestIdlessToolIdByRunId.delete(runId)
    const prefix = `${runId}\0`
    for (const key of [...this.startedItems]) {
      if (key.startsWith(prefix)) this.startedItems.delete(key)
    }
    for (const key of [...this.idlessToolIdByRunAndName.keys()]) {
      if (key.startsWith(prefix)) this.idlessToolIdByRunAndName.delete(key)
    }
    this.completedRuns.delete(runId)
  }

  private nextSequence(runId: string): number {
    const next = (this.sequenceByRunId.get(runId) || 0) + 1
    this.sequenceByRunId.set(runId, next)
    return next
  }

  private ensureItemStarted(
    identity: CompatRunItemIdentity,
    itemId: string,
    itemKind: RunItemKind,
    extra: Partial<Extract<RunItemEventDraft, { kind: 'item/started' }>> = {}
  ): RunItemEventDraft[] {
    const key = `${identity.runId}\0${itemId}`
    if (this.startedItems.has(key)) return []
    this.startedItems.add(key)
    return [
      {
        kind: 'item/started',
        itemId,
        itemKind,
        source: 'adapter',
        ...extra
      }
    ]
  }

  private explicitToolId(record: Record<string, unknown>): string {
    return stringField(record, 'tool_id', 'toolId', 'id', 'call_id', 'tool_call_id', 'toolCallId')
  }

  private idlessToolKey(identity: CompatRunItemIdentity, toolName: string | undefined): string {
    return `${identity.runId}\0${toolName || 'tool'}`
  }

  private nextIdlessToolId(identity: CompatRunItemIdentity): string {
    const next = (this.idlessToolSeqByRunId.get(identity.runId) || 0) + 1
    this.idlessToolSeqByRunId.set(identity.runId, next)
    return runItemId(identity, `tool-${next}`)
  }

  private toolItemId(
    identity: CompatRunItemIdentity,
    record: Record<string, unknown>,
    toolName: string | undefined,
    phase: 'use' | 'result'
  ): string {
    const explicit = this.explicitToolId(record)
    if (explicit) return explicit
    const key = this.idlessToolKey(identity, toolName)
    if (phase === 'result') {
      return (
        this.idlessToolIdByRunAndName.get(key) ||
        this.latestIdlessToolIdByRunId.get(identity.runId) ||
        this.nextIdlessToolId(identity)
      )
    }
    const generated = this.nextIdlessToolId(identity)
    this.idlessToolIdByRunAndName.set(key, generated)
    this.latestIdlessToolIdByRunId.set(identity.runId, generated)
    return generated
  }

  private draftsFromPayload(
    identity: CompatRunItemIdentity,
    record: Record<string, unknown>
  ): RunItemEventDraft[] {
    const type = String(record.type || '').trim()
    if (!type) return []

    if (type === 'init') {
      return [
        {
          kind: 'run/started',
          itemKind: 'run',
          itemId: runItemId(identity, 'run'),
          model: stringField(record, 'model'),
          modelLabel: stringField(record, 'modelLabel', 'model_label') || undefined,
          fallback: record.fallback === true,
          providerSessionId: stringField(record, 'session_id', 'sessionId', 'providerThreadId', 'provider_thread_id') || undefined,
          source: 'adapter'
        }
      ]
    }

    if (type === 'content' || type === 'token') {
      const text = stringField(record, 'text', 'content')
      const itemId = stringField(record, 'itemId', 'item_id') || runItemId(identity, 'assistant')
      const drafts = this.ensureItemStarted(identity, itemId, 'assistant_message')
      if (text) {
        drafts.push({
          kind: 'item/delta',
          itemId,
          itemKind: 'assistant_message',
          channel: 'assistant',
          delta: text,
          cumulative:
            record.cumulative === true ||
            record.runItemCumulative === true ||
            record.snapshot === true,
          model: stringField(record, 'model') || undefined,
          modelLabel: stringField(record, 'modelLabel', 'model_label') || undefined,
          source: 'adapter'
        })
      }
      if (record.complete === true) {
        drafts.push({
          kind: 'item/completed',
          itemId,
          itemKind: 'assistant_message',
          status: 'complete',
          source: 'adapter'
        })
      }
      return drafts
    }

    if (type === 'tool_use' || type === 'tool_call') {
      const toolName = stringField(record, 'tool_name', 'toolName', 'name', 'tool') || 'tool'
      const itemId = this.toolItemId(identity, record, toolName, 'use')
      return [
        ...this.ensureItemStarted(identity, itemId, 'tool', {
          toolName,
          data: recordField(record, 'parameters') || recordField(record, 'input')
        }),
        {
          kind: 'tool/progress',
          itemId,
          toolCallId: itemId,
          toolName,
          status: 'running',
          data: recordField(record, 'parameters') || recordField(record, 'input'),
          source: 'adapter'
        }
      ]
    }

    if (type === 'tool_result' || type === 'tool_output' || type === 'tool_response') {
      const toolName = stringField(record, 'tool_name', 'toolName', 'name', 'tool') || undefined
      const itemId = this.toolItemId(identity, record, toolName, 'result')
      const output = stringField(record, 'output', 'content', 'text', 'result', 'message')
      return [
        ...this.ensureItemStarted(identity, itemId, 'tool', {
          ...(toolName ? { toolName } : {})
        }),
        {
          kind: 'tool/outputDelta',
          itemId,
          toolCallId: itemId,
          ...(toolName ? { toolName } : {}),
          status: statusFromPayload(record),
          delta: output,
          output,
          data: record,
          source: 'adapter'
        }
      ]
    }

    if (
      type === 'progress' ||
      type === 'tool_progress' ||
      type === 'update_topic' ||
      type === 'invoke_agent' ||
      type === 'summary' ||
      type === 'intent' ||
      type === 'provider_warning'
    ) {
      const itemId = stringField(record, 'tool_id', 'toolId', 'id') || runItemId(identity, `progress-${type}`)
      const title = stringField(record, 'title', 'name') || type
      const summary = stringField(record, 'summary', 'message', 'text', 'content')
      return [
        ...this.ensureItemStarted(identity, itemId, 'tool', { toolName: type, title }),
        {
          kind: 'tool/progress',
          itemId,
          toolCallId: itemId,
          toolName: type,
          status: statusFromPayload(record) || 'running',
          title,
          summary: summary || undefined,
          data: record,
          source: 'adapter'
        }
      ]
    }

    if (type === 'media_refs') {
      const itemId = runItemId(identity, 'media')
      return [
        ...this.ensureItemStarted(identity, itemId, 'media', { title: 'Assistant media' }),
        {
          kind: 'item/completed',
          itemId,
          itemKind: 'media',
          status: 'complete',
          source: 'adapter'
        }
      ]
    }

    if (type === 'result') {
      return [
        {
          kind: 'run/completed',
          itemKind: 'run',
          itemId: runItemId(identity, 'run'),
          status: statusFromPayload(record) || 'unknown',
          stats: recordField(record, 'stats'),
          providerSessionId: stringField(record, 'session_id', 'sessionId', 'providerThreadId', 'provider_thread_id') || undefined,
          source: 'adapter'
        }
      ]
    }

    return []
  }
}
