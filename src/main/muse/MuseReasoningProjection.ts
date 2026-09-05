import type { MuseEnvelope, MuseExecNormalizedEvent } from './MuseExecJson'

interface SummaryState {
  parts: Map<number, string>
  seen: Set<string>
  text: string
  completed: boolean
}

/**
 * Muse Code records readable summaries in runtime.session, separately from
 * exec stdout and the encrypted reasoning_committed record. Project only the
 * provider's summary text; neither private reasoning nor ciphertext is a trace.
 * State belongs to one run and identities include the native session so child
 * streams and repeated model calls cannot overwrite each other's summaries.
 */
export function createMuseReasoningProjector() {
  const summaries = new Map<string, SummaryState>()

  return (envelope: MuseEnvelope): MuseExecNormalizedEvent[] => {
    if (envelope.payload_type !== 'runtime.session') return []
    const event = envelope.payload.event
    if (!event || typeof event !== 'object' || Array.isArray(event)) return []
    const record = event as Record<string, unknown>
    const committed = record.kind === 'reasoning_summary_committed'
    if (!committed && record.kind !== 'reasoning_summary_delta') return []
    if (typeof record.message_id !== 'string' || !record.message_id) return []
    if (typeof record.text !== 'string') return []
    const runId = typeof envelope.payload.run_id === 'string' ? envelope.payload.run_id : undefined
    const thinkingId = JSON.stringify([envelope.stream.id, runId, record.message_id])
    const index = record.summary_index ?? 0
    if (!committed && (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0)) {
      return []
    }
    let state = summaries.get(thinkingId)
    if (!state) {
      state = { parts: new Map(), seen: new Set(), text: '', completed: false }
      summaries.set(thinkingId, state)
    }
    if (state.seen.has(envelope.id) || state.completed) return []
    state.seen.add(envelope.id)

    let text: string
    if (committed) {
      text = record.text
      state.completed = true
    } else {
      const part = index as number
      state.parts.set(part, (state.parts.get(part) || '') + record.text)
      text = [...state.parts.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, value]) => value)
        .join('\n\n')
    }
    if (!text.trim() || text === state.text) return []
    state.text = text
    return [
      {
        type: 'thinking',
        payloadType: envelope.payload_type,
        payloadKind: String(record.kind),
        sessionId: envelope.stream.id,
        runId,
        thinkingId,
        thinkingCumulative: true,
        text,
        sequence: envelope.sequence,
        envelopeId: envelope.id,
        // Keep only the exposed summary on the normalized diagnostic surface.
        raw: { kind: record.kind, message_id: record.message_id, text }
      }
    ]
  }
}
