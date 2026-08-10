/**
 * Pure parser for `muse exec --json` stdout JSONL lifecycle envelopes.
 *
 * Muse emits one envelope object per line. Stdout and on-disk `session.jsonl`
 * do **not** share the same payload_type catalog — this module is the stdout
 * control/transcript plane only. Usage metering lives in MuseUsage / the
 * session-log tailer (see wave1-C §3, wave1-E).
 *
 * Observed stdout payload_types (echo probe):
 *   runtime.command.accepted, session.run.linked, turn.input.user,
 *   run.lifecycle.started, task.stream.linked, task.lifecycle.*,
 *   run.output.delta, run.terminal.completed
 *
 * No Electron / fs / child_process imports — unit-testable against fixtures.
 */

export interface MuseEnvelopeStream {
  kind: string
  id: string
}

export interface MuseEnvelope {
  schema_version: number
  id: string
  stream: MuseEnvelopeStream
  sequence: number
  recorded_at: number
  record_type: string
  durability?: string
  causation_id?: string | null
  payload_type: string
  payload_schema_version?: number
  payload: Record<string, unknown>
  raw: Record<string, unknown>
}

export interface MuseExecJsonLine {
  envelope?: MuseEnvelope
  json?: Record<string, unknown>
  nonJson?: string
  parseError?: string
}

export type MuseExecNormalizedType =
  | 'command_accepted'
  | 'session_linked'
  | 'user_input'
  | 'run_started'
  | 'task'
  | 'content'
  | 'terminal'
  | 'unknown'

export interface MuseExecNormalizedEvent {
  type: MuseExecNormalizedType
  payloadType: string
  payloadKind?: string
  sessionId?: string
  runId?: string
  text?: string
  terminal?: string
  reason?: string
  sequence?: number
  envelopeId?: string
  raw: unknown
}

/**
 * Split a stdout chunk into NDJSON lines, carrying any partial trailing line
 * across chunk boundaries. Mirrors `parseCursorStreamChunk`.
 */
export function parseMuseExecJsonChunk(
  rawChunk: string,
  carry: string
): { lines: MuseExecJsonLine[]; carry: string } {
  const buffer = (carry || '') + (rawChunk || '')
  const segments = buffer.split(/\r?\n/)
  const nextCarry = segments.pop() ?? ''
  const lines: MuseExecJsonLine[] = []
  for (const segment of segments) {
    const trimmed = segment.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>
        const envelope = parseMuseEnvelope(obj)
        if (envelope) {
          lines.push({ envelope, json: obj })
        } else {
          lines.push({ json: obj })
        }
      } else {
        lines.push({ nonJson: segment })
      }
    } catch (err) {
      lines.push({
        nonJson: segment,
        parseError: err instanceof Error ? err.message : 'json parse failed'
      })
    }
  }
  return { lines, carry: nextCarry }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Convert Muse `recorded_at` microseconds to JS milliseconds. */
export function museRecordedAtMs(recordedAtUs: number): number {
  if (!Number.isFinite(recordedAtUs) || recordedAtUs <= 0) return 0
  return Math.floor(recordedAtUs / 1_000)
}

/**
 * Validate and normalize a Muse envelope object. Returns null when required
 * fields are missing — callers skip rather than throw.
 */
export function parseMuseEnvelope(value: unknown): MuseEnvelope | null {
  const obj = asRecord(value)
  if (!obj) return null
  const stream = asRecord(obj.stream)
  const payload = asRecord(obj.payload)
  const id = asString(obj.id)
  const payloadType = asString(obj.payload_type)
  const recordType = asString(obj.record_type)
  const streamId = stream ? asString(stream.id) : undefined
  const streamKind = stream ? asString(stream.kind) : undefined
  const sequence = asNumber(obj.sequence)
  const recordedAt = asNumber(obj.recorded_at)
  const schemaVersion = asNumber(obj.schema_version)
  if (
    !id ||
    !payloadType ||
    !recordType ||
    !payload ||
    !streamId ||
    !streamKind ||
    sequence == null ||
    recordedAt == null ||
    schemaVersion == null
  ) {
    return null
  }
  return {
    schema_version: schemaVersion,
    id,
    stream: { kind: streamKind, id: streamId },
    sequence,
    recorded_at: recordedAt,
    record_type: recordType,
    durability: asString(obj.durability),
    causation_id:
      obj.causation_id === null
        ? null
        : typeof obj.causation_id === 'string'
          ? obj.causation_id
          : undefined,
    payload_type: payloadType,
    payload_schema_version: asNumber(obj.payload_schema_version),
    payload,
    raw: obj
  }
}

function payloadKind(payload: Record<string, unknown>): string | undefined {
  return asString(payload.kind)
}

function extractText(payload: Record<string, unknown>): string | undefined {
  return asString(payload.text) ?? asString(payload.prompt)
}

/**
 * Map one stdout JSONL line into zero or more normalized lifecycle events.
 * Never throws; unknown payload types become `unknown` (still surfaced).
 */
export function museExecLineToEvents(line: MuseExecJsonLine): MuseExecNormalizedEvent[] {
  if (line.nonJson != null && !line.envelope) {
    return [
      {
        type: 'content',
        payloadType: 'non_json',
        text: `${line.nonJson}\n`,
        raw: line.nonJson
      }
    ]
  }
  const envelope = line.envelope
  if (!envelope) {
    if (line.json) {
      return [
        {
          type: 'unknown',
          payloadType: asString(line.json.payload_type) || 'unknown',
          raw: line.json
        }
      ]
    }
    return []
  }

  const base = {
    payloadType: envelope.payload_type,
    payloadKind: payloadKind(envelope.payload),
    sessionId: envelope.stream.id,
    sequence: envelope.sequence,
    envelopeId: envelope.id,
    raw: envelope.raw
  }
  const runId =
    asString(envelope.payload.run_id) ||
    asString(asRecord(envelope.payload.run_stream)?.id) ||
    asString(asRecord(envelope.payload.run)?.id)

  switch (envelope.payload_type) {
    case 'runtime.command.accepted':
      return [{ ...base, type: 'command_accepted', runId }]
    case 'session.run.linked':
      return [{ ...base, type: 'session_linked', runId }]
    case 'turn.input.user':
      return [
        {
          ...base,
          type: 'user_input',
          runId,
          text: extractText(envelope.payload)
        }
      ]
    case 'run.lifecycle.started':
      return [{ ...base, type: 'run_started', runId, text: extractText(envelope.payload) }]
    case 'run.output.delta': {
      const text = extractText(envelope.payload)
      return text
        ? [{ ...base, type: 'content', runId, text }]
        : [{ ...base, type: 'content', runId }]
    }
    case 'run.terminal.completed': {
      const terminal =
        asString(envelope.payload.terminal) ||
        asString(asRecord(envelope.payload.terminal_state)?.terminal) ||
        'completed'
      return [
        {
          ...base,
          type: 'terminal',
          runId,
          text: extractText(envelope.payload),
          terminal,
          reason: asString(envelope.payload.reason)
        }
      ]
    }
    default:
      if (envelope.payload_type.startsWith('task.')) {
        return [{ ...base, type: 'task', runId }]
      }
      return [{ ...base, type: 'unknown', runId }]
  }
}

/** Convenience: parse a complete JSONL string (tests / offline). */
export function parseMuseExecJsonl(text: string): MuseExecNormalizedEvent[] {
  const { lines, carry } = parseMuseExecJsonChunk(text.endsWith('\n') ? text : `${text}\n`, '')
  void carry
  const out: MuseExecNormalizedEvent[] = []
  for (const line of lines) out.push(...museExecLineToEvents(line))
  return out
}
