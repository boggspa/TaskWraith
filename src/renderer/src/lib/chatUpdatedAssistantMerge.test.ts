import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import { shouldPreferLiveAssistantContent } from './chatUpdatedAssistantMerge'

const NOW = '2026-06-22T00:00:00.000Z'

function assistant(content: string): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content,
    timestamp: NOW
  }
}

describe('shouldPreferLiveAssistantContent', () => {
  it('preserves a longer live assistant tail over a stale incoming broadcast', () => {
    expect(
      shouldPreferLiveAssistantContent(
        assistant('The answer starts here.'),
        assistant('The answer starts here. More text streamed locally.')
      )
    ).toBe(true)
  })

  it('does not preserve a local exact doubled copy over the authoritative incoming text', () => {
    expect(
      shouldPreferLiveAssistantContent(
        assistant('Line 3968 looks directly on point. Let me read it.'),
        assistant(
          'Line 3968 looks directly on point. Let me read it.Line 3968 looks directly on point. Let me read it.'
        )
      )
    ).toBe(false)
  })

  it('does not preserve equal or shorter live content', () => {
    expect(
      shouldPreferLiveAssistantContent(assistant('Complete answer.'), assistant('Complete answer.'))
    ).toBe(false)
    expect(
      shouldPreferLiveAssistantContent(assistant('Complete answer.'), assistant('Complete'))
    ).toBe(false)
  })
})
