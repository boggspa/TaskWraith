/**
 * Project Muse durable `runtime.session` envelopes into Claude/Codex-shaped
 * tool events for ActivityStack display.
 *
 * Muse commits tools inside session.jsonl (not the stdout control plane):
 *   - assistant_tool_calls_committed → tool_use
 *   - tool_result_batch_committed / tool_result(s)_committed → tool_result
 *
 * Display-only: TaskWraith does not mediate Muse-native tool execution.
 */

import type { MuseEnvelope, MuseExecNormalizedEvent } from './MuseExecJson'

const TOOL_CALL_KINDS = new Set(['assistant_tool_calls_committed'])
const TOOL_RESULT_KINDS = new Set([
  'tool_result_batch_committed',
  'tool_result_committed',
  'tool_results_committed'
])

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function parseArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
      return { raw: value }
    } catch {
      return { raw: value }
    }
  }
  return {}
}

function nestedEvent(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  return asRecord(payload.event)
}

function sessionRunId(payload: Record<string, unknown>): string | undefined {
  return asString(payload.run_id) || asString(asRecord(payload.run)?.id)
}

/**
 * Relative path under the session dir (e.g. `subagent/<uuid>/session.jsonl`)
 * when a background/child task stream is linked.
 */
export function museLinkedSubagentSessionLogPath(envelope: MuseEnvelope): string | null {
  if (envelope.payload_type !== 'runtime.session') return null
  const event = nestedEvent(envelope.payload)
  if (!event || asString(event.kind) !== 'task_stream_linked') return null
  const display = asRecord(event.display)
  const path = display ? asString(display.path) : undefined
  if (!path || path.includes('..') || path.startsWith('/') || path.startsWith('\\')) {
    return null
  }
  return path.replace(/\\/g, '/')
}

/**
 * Map one Muse envelope into zero or more normalized tool events.
 */
export function projectMuseEnvelopeTools(envelope: MuseEnvelope): MuseExecNormalizedEvent[] {
  if (envelope.payload_type !== 'runtime.session') return []
  const event = nestedEvent(envelope.payload)
  if (!event) return []
  const kind = asString(event.kind)
  if (!kind) return []

  const base = {
    payloadType: envelope.payload_type,
    payloadKind: asString(envelope.payload.kind),
    sessionId: envelope.stream.id,
    runId: sessionRunId(envelope.payload),
    sequence: envelope.sequence,
    envelopeId: envelope.id,
    raw: envelope.raw
  }

  if (TOOL_CALL_KINDS.has(kind)) {
    const calls = Array.isArray(event.tool_calls) ? event.tool_calls : []
    const out: MuseExecNormalizedEvent[] = []
    for (const call of calls) {
      const record = asRecord(call)
      if (!record) continue
      const toolId =
        asString(record.call_id) || asString(record.id) || asString(record.tool_call_id)
      const toolName = asString(record.name) || asString(record.tool_name) || 'tool'
      if (!toolId) continue
      out.push({
        ...base,
        type: 'tool_use',
        toolId,
        toolName,
        toolInput: parseArgs(record.args ?? record.arguments ?? record.input)
      })
    }
    return out
  }

  if (TOOL_RESULT_KINDS.has(kind)) {
    const results = Array.isArray(event.results) ? event.results : [event]
    const out: MuseExecNormalizedEvent[] = []
    for (const result of results) {
      const record = asRecord(result)
      if (!record) continue
      const toolId =
        asString(record.tool_call_id) || asString(record.call_id) || asString(record.id)
      if (!toolId) continue
      const output =
        asString(record.text) || asString(record.output) || asString(record.result) || ''
      const failed =
        record.is_error === true ||
        record.error === true ||
        asString(record.status)?.toLowerCase() === 'error'
      out.push({
        ...base,
        type: 'tool_result',
        toolId,
        toolOutput: output,
        toolStatus: failed ? 'error' : 'success'
      })
    }
    return out
  }

  return []
}
