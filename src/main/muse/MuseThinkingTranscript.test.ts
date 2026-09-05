import { describe, expect, it } from 'vitest'
import type { MuseExecNormalizedEvent } from './MuseExecJson'
import { createMuseThinkingTranscript } from './MuseThinkingTranscript'

function summary(text: string, thinkingId = 'message-1'): MuseExecNormalizedEvent {
  return {
    type: 'thinking',
    payloadType: 'runtime.session',
    thinkingId,
    thinkingCumulative: true,
    text,
    raw: {}
  }
}

describe('Muse Thinking transcript', () => {
  it('uses the shared provider activity shape and updates one summary in place', () => {
    const transcript = createMuseThinkingTranscript('app-run')
    const first = transcript.project(summary('Inspect'))
    expect(first).toEqual([
      {
        type: 'tool_use',
        tool_id: 'muse-thinking-app-run-summary1',
        tool_name: 'muse_thinking',
        parameters: { title: 'Muse thinking', kind: 'reasoning' },
        provider: 'muse'
      },
      {
        type: 'tool_result',
        tool_id: 'muse-thinking-app-run-summary1',
        tool_name: 'muse_thinking',
        status: 'success',
        output: 'Inspect',
        provider: 'muse'
      }
    ])
    expect(transcript.project(summary('Inspect the fixture.'))).toEqual([
      { ...first[1], output: 'Inspect the fixture.' }
    ])
    expect(transcript.project(summary('Inspect the fixture.'))).toEqual([])
  })

  it.each(['content', 'tool_use', 'tool_result', 'progress'])(
    'opens a later thinking segment after %s without repeating the earlier summary',
    (type) => {
      const transcript = createMuseThinkingTranscript('run')
      transcript.project(summary('Inspect.'))
      transcript.observe({ type, text: 'I will check it.', tool_name: 'read_file' })
      expect(transcript.project(summary('Inspect.'))).toEqual([])
      const later = transcript.project(summary('Inspect.\n\nVerify.'))
      expect(later).toMatchObject([
        { type: 'tool_use', tool_id: 'muse-thinking-run-summary1-seg2' },
        { type: 'tool_result', output: '\n\nVerify.' }
      ])
    }
  )

  it('isolates simultaneous messages and runs while preserving their chronological positions', () => {
    const transcript = createMuseThinkingTranscript('run')
    const otherRun = createMuseThinkingTranscript('other-run')
    const first = transcript.project(summary('Check.', 'parent'))
    const child = transcript.project(summary('Check.', 'child'))
    expect(child[0].tool_id).not.toBe(first[0].tool_id)
    expect(otherRun.project(summary('Check.', 'parent'))[0].tool_id).not.toBe(first[0].tool_id)
    expect(transcript.project(summary('Check. Done.', 'parent'))).toMatchObject([
      { type: 'tool_use', tool_id: 'muse-thinking-run-summary1-seg2' },
      { type: 'tool_result', output: ' Done.' }
    ])
  })
})
