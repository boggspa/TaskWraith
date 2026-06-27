import { createHash, randomUUID } from 'crypto'
import type {
  RunEventFilter,
  RunEventInput,
  RunEventKind,
  RunEventArtifactRef,
  RunEventRecord,
  RunEventReplay
} from './store/types'
import { redactSecrets } from '../shared/secretRedaction'

export const RUN_EVENT_SCHEMA_VERSION = 1
export const MAX_RUN_EVENT_SUMMARY_CHARS = 500
export const MAX_RUN_EVENT_PAYLOAD_CHARS = 80_000
export const MAX_REDACTED_PROVIDER_PREVIEW_CHARS = 8_000
export const RUN_EVENT_EMPTY_HASH = '0'.repeat(64)

export function safeRunEventFileName(runId: string): string {
  const normalized = String(runId || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
  return `${normalized || 'unknown-run'}.jsonl`
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`
}

function compactSummary(value: unknown): string | undefined {
  const summary = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
  return summary ? truncate(summary, MAX_RUN_EVENT_SUMMARY_CHARS) : undefined
}

function payloadToText(payload: unknown): string {
  if (typeof payload === 'string') return payload
  try {
    return JSON.stringify(payload)
  } catch {
    return String(payload)
  }
}

function canonicalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForHash)
  if (!value || typeof value !== 'object') return value
  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      const nested = (value as Record<string, unknown>)[key]
      if (nested !== undefined) {
        result[key] = canonicalizeForHash(nested)
      }
      return result
    }, {})
}

export function hashRunEventRecord(record: Omit<RunEventRecord, 'hash'>): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeForHash(record)))
    .digest('hex')
}

function inferToolCallId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const record = payload as Record<string, unknown>
  for (const key of [
    'tool_id',
    'toolId',
    'tool_call_id',
    'toolCallId',
    'call_id',
    'callId',
    'id'
  ]) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  const nested = record.data || record.payload || record.params
  return inferToolCallId(nested)
}

function redactSensitiveText(value: string): string {
  return redactSecrets(value)
}

export function prepareRunEventPayload(
  payload: unknown,
  options: { storeRawPayload?: boolean; rawProviderPayload?: boolean } = {}
): unknown {
  if (payload === undefined) return undefined
  const text = payloadToText(payload)
  const byteLength = Buffer.byteLength(text, 'utf8')

  if (options.rawProviderPayload) {
    return {
      redacted: true,
      byteLength,
      rawStored: false,
      preview: truncate(redactSensitiveText(text), MAX_REDACTED_PROVIDER_PREVIEW_CHARS)
    }
  }

  if (text.length > MAX_RUN_EVENT_PAYLOAD_CHARS) {
    return {
      truncated: true,
      byteLength,
      preview: truncate(redactSensitiveText(text), MAX_RUN_EVENT_PAYLOAD_CHARS)
    }
  }

  return payload
}

export function createRunEventRecord(
  input: RunEventInput,
  sequence: number,
  options: {
    now?: string
    storeRawPayload?: boolean
    previousHash?: string
    artifacts?: RunEventArtifactRef[]
  } = {}
): RunEventRecord {
  const runId = String(input.runId || '').trim()
  if (!runId) {
    throw new Error('Run event requires a runId.')
  }

  const isRawProviderPayload = input.kind === 'provider_raw' || input.kind === 'provider_error'
  const recordWithoutHash: Omit<RunEventRecord, 'hash'> = {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    id: input.id || randomUUID(),
    sequence: Number.isFinite(sequence) && sequence > 0 ? Math.floor(sequence) : 1,
    previousHash: input.previousHash || options.previousHash || RUN_EVENT_EMPTY_HASH,
    runId,
    chatId: input.chatId || undefined,
    workspaceId: input.workspaceId || undefined,
    workspacePath: input.workspacePath || undefined,
    provider: input.provider,
    providerSessionId: input.providerSessionId || undefined,
    providerRunId: input.providerRunId || undefined,
    spanId:
      input.spanId ||
      `${runId}:${Number.isFinite(sequence) && sequence > 0 ? Math.floor(sequence) : 1}`,
    parentSpanId: input.parentSpanId || undefined,
    toolCallId: input.toolCallId || inferToolCallId(input.payload),
    kind: input.kind,
    phase: input.phase,
    source: input.source,
    timestamp: input.timestamp || options.now || new Date().toISOString(),
    summary: compactSummary(input.summary),
    payload: prepareRunEventPayload(input.payload, {
      rawProviderPayload: isRawProviderPayload,
      storeRawPayload: options.storeRawPayload
    }),
    artifacts: input.artifacts || options.artifacts
  }
  return {
    ...recordWithoutHash,
    hash: hashRunEventRecord(recordWithoutHash)
  }
}

export function parseRunEventLine(line: string): RunEventRecord | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as RunEventRecord
    if (!parsed || parsed.schemaVersion !== RUN_EVENT_SCHEMA_VERSION || !parsed.runId) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function serializeRunEventRecord(record: RunEventRecord): string {
  return `${JSON.stringify(record)}\n`
}

export function nextRunEventSequence(events: RunEventRecord[]): number {
  return events.reduce((max, event) => Math.max(max, Number(event.sequence) || 0), 0) + 1
}

export function lastRunEventHash(events: RunEventRecord[]): string {
  return (
    [...events]
      .sort((a, b) => a.sequence - b.sequence)
      .reverse()
      .find((event) => event.hash)?.hash || RUN_EVENT_EMPTY_HASH
  )
}

export function verifyRunEventHashChain(events: RunEventRecord[]): boolean {
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence)
  let previousHash = RUN_EVENT_EMPTY_HASH
  for (const event of sorted) {
    if (!event.hash) {
      previousHash = RUN_EVENT_EMPTY_HASH
      continue
    }
    if ((event.previousHash || RUN_EVENT_EMPTY_HASH) !== previousHash) {
      return false
    }
    const { hash: _hash, ...recordWithoutHash } = event
    if (hashRunEventRecord(recordWithoutHash) !== event.hash) {
      return false
    }
    previousHash = event.hash
  }
  return true
}

export function filterRunEvents(
  events: RunEventRecord[],
  filter: RunEventFilter = {}
): RunEventRecord[] {
  const kindSet = filter.kinds?.length ? new Set<RunEventKind>(filter.kinds) : null
  const phaseSet = filter.phases?.length ? new Set(filter.phases) : null
  const fromSequence = Number.isFinite(filter.fromSequence)
    ? Math.max(1, Number(filter.fromSequence))
    : null

  const filtered = events.filter((event) => {
    if (filter.runId && event.runId !== filter.runId) return false
    if (filter.chatId && event.chatId !== filter.chatId) return false
    if (filter.workspaceId && event.workspaceId !== filter.workspaceId) return false
    if (filter.provider && event.provider !== filter.provider) return false
    if (kindSet && !kindSet.has(event.kind)) return false
    if (phaseSet && !phaseSet.has(event.phase)) return false
    if (fromSequence !== null && event.sequence < fromSequence) return false
    return true
  })

  const sorted = [...filtered].sort((a, b) => {
    if (a.runId === b.runId) return a.sequence - b.sequence
    return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  })

  return filter.limit && filter.limit > 0 ? sorted.slice(-Math.floor(filter.limit)) : sorted
}

export function createRunEventReplay(runId: string, events: RunEventRecord[]): RunEventReplay {
  const runEvents = filterRunEvents(events, { runId })
  const countsByKind: Partial<Record<RunEventKind, number>> = {}
  for (const event of runEvents) {
    countsByKind[event.kind] = (countsByKind[event.kind] || 0) + 1
  }

  const lifecycleEvents = runEvents.filter((event) => event.kind === 'lifecycle')
  const terminalEvent = [...lifecycleEvents].reverse().find((event) => {
    const status =
      event.payload && typeof event.payload === 'object'
        ? (event.payload as { status?: unknown }).status
        : undefined
    return status === 'completed' || status === 'failed' || status === 'cancelled'
  })

  return {
    runId,
    events: runEvents,
    count: runEvents.length,
    lastSequence: runEvents.reduce((max, event) => Math.max(max, event.sequence), 0),
    hashHead: lastRunEventHash(runEvents),
    hashChainValid: verifyRunEventHashChain(runEvents),
    countsByKind,
    timeline: runEvents.map((event) => ({
      sequence: event.sequence,
      timestamp: event.timestamp,
      kind: event.kind,
      phase: event.phase,
      source: event.source,
      summary: event.summary,
      spanId: event.spanId,
      parentSpanId: event.parentSpanId,
      toolCallId: event.toolCallId,
      artifactIds: event.artifacts?.map((artifact) => artifact.id),
      hash: event.hash
    })),
    startedAt: lifecycleEvents[0]?.timestamp || runEvents[0]?.timestamp,
    endedAt: terminalEvent?.timestamp || runEvents[runEvents.length - 1]?.timestamp
  }
}
