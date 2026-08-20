import { describe, expect, it } from 'vitest'

import { shouldPersistCompatProviderRawEvent } from './ProviderCompatRunEventPolicy'

describe('shouldPersistCompatProviderRawEvent', () => {
  it('keeps every provider event when raw retention is enabled', () => {
    expect(shouldPersistCompatProviderRawEvent({ type: 'content', text: 'a' }, true)).toBe(true)
    expect(
      shouldPersistCompatProviderRawEvent(
        { type: 'message', role: 'assistant', delta: true, content: 'b' },
        true
      )
    ).toBe(true)
  })

  it('drops payload-less incremental assistant text records', () => {
    expect(shouldPersistCompatProviderRawEvent({ type: 'content', text: 'a' }, false)).toBe(false)
    expect(shouldPersistCompatProviderRawEvent({ type: 'token', content: 'b' }, false)).toBe(false)
    expect(
      shouldPersistCompatProviderRawEvent(
        { type: 'message', role: 'assistant', delta: true, content: 'c' },
        false
      )
    ).toBe(false)
  })

  it('retains terminal messages, tools, reasoning, and unknown payloads', () => {
    expect(
      shouldPersistCompatProviderRawEvent(
        { type: 'message', role: 'assistant', content: 'final' },
        false
      )
    ).toBe(true)
    expect(shouldPersistCompatProviderRawEvent({ type: 'tool_result' }, false)).toBe(true)
    expect(shouldPersistCompatProviderRawEvent({ type: 'thinking', text: 'why' }, false)).toBe(true)
    expect(shouldPersistCompatProviderRawEvent('opaque', false)).toBe(true)
  })
})
