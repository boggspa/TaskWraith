import {
  advanceCliProviderThinkingSegments,
  cliProviderThinkingSegmentToolId,
  shouldBreakThinkingChronology,
  type CliProviderThinkingSegmentsState
} from '../providers/CliProviderThinking'
import type { MuseExecNormalizedEvent } from './MuseExecJson'

/** Use the same activity protocol, segmentation and display kind as other CLIs. */
export function createMuseThinkingTranscript(appRunId: string) {
  const traces = new Map<string, { state: CliProviderThinkingSegmentsState; ordinal: number }>()
  let previousId: string | undefined

  return {
    observe(payload: Record<string, unknown>): void {
      if (shouldBreakThinkingChronology(payload)) {
        for (const trace of traces.values()) trace.state.thinkingChronoBreak = true
      }
    },
    project(event: MuseExecNormalizedEvent): Record<string, unknown>[] {
      if (event.type !== 'thinking' || !event.text?.trim()) return []
      const id = event.thinkingId || event.sessionId || appRunId
      let trace = traces.get(id)
      if (!trace) {
        trace = { state: {}, ordinal: traces.size + 1 }
        traces.set(id, trace)
      }
      if (previousId && previousId !== id) {
        const previous = traces.get(previousId)
        if (previous) previous.state.thinkingChronoBreak = true
      }
      const advance = advanceCliProviderThinkingSegments(trace.state, event.text, {
        cumulative: event.thinkingCumulative
      })
      if (!advance) return []
      previousId = id
      const toolId = cliProviderThinkingSegmentToolId(
        'muse',
        `${appRunId}-summary${trace.ordinal}`,
        advance.segmentSeq
      )
      const payloads: Record<string, unknown>[] = []
      if (advance.startedNewActivity) {
        payloads.push({
          type: 'tool_use',
          tool_id: toolId,
          tool_name: 'muse_thinking',
          parameters: { title: 'Muse thinking', kind: 'reasoning' },
          provider: 'muse'
        })
      }
      payloads.push({
        type: 'tool_result',
        tool_id: toolId,
        tool_name: 'muse_thinking',
        status: 'success',
        output: advance.text,
        provider: 'muse'
      })
      return payloads
    }
  }
}
