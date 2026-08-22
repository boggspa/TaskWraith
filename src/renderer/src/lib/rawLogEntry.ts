import type { RunEventRecord } from '../../../main/store/types'
import { redactLog } from './ErrorClassifier'
import { rawLogPayloadForStringify } from './rawLogPayload'

export type RawLogEntry = {
  type: 'stdout' | 'stderr' | 'tool' | 'info'
  content: string
  timestamp?: string
  sequence?: number
  hash?: string
  spanId?: string
  toolCallId?: string
  artifactCount?: number
}

const deferredPayloadByEntry = new WeakMap<RawLogEntry, unknown>()

/** Retain an unformatted provider payload until a visible consumer asks for it. */
export function deferredRawLogEntry(type: RawLogEntry['type'], payload: unknown): RawLogEntry {
  const entry: RawLogEntry = { type, content: '' }
  // Bound retained cumulative-thinking fields at ingest. This is the only
  // recursive wire-cadence work left; stringify and regex redaction stay lazy.
  deferredPayloadByEntry.set(entry, rawLogPayloadForStringify(payload))
  return entry
}

export function rawLogEntryContent(entry: RawLogEntry): string {
  if (!deferredPayloadByEntry.has(entry)) return entry.content
  const payload = deferredPayloadByEntry.get(entry)
  deferredPayloadByEntry.delete(entry)
  try {
    entry.content = redactLog(JSON.stringify(payload, null, 2))
  } catch {
    entry.content = redactLog(String(payload ?? ''))
  }
  return entry.content
}

export function materializeRawLogEntries(entries: readonly RawLogEntry[]): RawLogEntry[] {
  for (const entry of entries) rawLogEntryContent(entry)
  return entries as RawLogEntry[]
}

export const rawLogFromRunEvent = (event: RunEventRecord): RawLogEntry | null => {
  const payload = event.payload
  const payloadRecord =
    payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const payloadText =
    typeof payload === 'string'
      ? payload
      : typeof payloadRecord.data === 'string'
        ? payloadRecord.data
        : typeof payloadRecord.error === 'string'
          ? payloadRecord.error
          : typeof payloadRecord.preview === 'string'
            ? payloadRecord.preview
            : event.summary || ''
  if (!payloadText.trim()) return null
  const metadata = {
    timestamp: event.timestamp,
    sequence: event.sequence,
    hash: event.hash,
    spanId: event.spanId,
    toolCallId: event.toolCallId,
    artifactCount: event.artifacts?.length
  }
  if (event.kind === 'provider_error')
    return { type: 'stderr', content: redactLog(payloadText), ...metadata }
  if (event.kind === 'provider_raw')
    return { type: 'stdout', content: redactLog(payloadText), ...metadata }
  if (event.kind === 'tool') return { type: 'tool', content: redactLog(payloadText), ...metadata }
  if (
    event.kind === 'approval_request' ||
    event.kind === 'approval_response' ||
    event.kind === 'provider_exit' ||
    event.kind === 'lifecycle'
  ) {
    return { type: 'info', content: redactLog(payloadText), ...metadata }
  }
  return null
}
