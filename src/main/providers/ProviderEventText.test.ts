import { describe, expect, it } from 'vitest'
import { extractProviderText, extractProviderThinkingText } from './ProviderEventText'

describe('ProviderEventText thinking extraction', () => {
  it('extracts Kimi print-mode role envelopes', () => {
    expect(extractProviderText({ role: 'assistant', content: 'SUMMARY_OK' })).toBe('SUMMARY_OK')
  })

  it('does not treat non-assistant role envelopes as provider output', () => {
    expect(extractProviderText({ role: 'user', content: 'Do not echo this.' })).toBe('')
  })

  it('keeps Claude thinking blocks out of visible assistant text', () => {
    const event = {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'Checked the workspace shape.', signature: 'opaque' },
          { type: 'text', text: 'Final answer.' }
        ]
      }
    }

    expect(extractProviderText(event)).toBe('Final answer.')
    expect(extractProviderThinkingText(event, 'claude')).toBe('Checked the workspace shape.')
  })

  it('extracts Claude streaming thinking deltas', () => {
    expect(
      extractProviderThinkingText(
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'thinking_delta', thinking: 'Summary chunk.' }
          }
        },
        'claude'
      )
    ).toBe('Summary chunk.')
  })

  it('ignores Claude signatures, redacted blocks, and arbitrary reasoning fields', () => {
    expect(
      extractProviderThinkingText(
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'signature_delta', signature: 'opaque-signature' }
          }
        },
        'claude'
      )
    ).toBe('')

    expect(
      extractProviderThinkingText(
        {
          type: 'assistant',
          content: [
            { type: 'redacted_thinking', data: 'opaque-redacted' },
            { type: 'tool_result', reasoning: 'internal field should not display' }
          ]
        },
        'claude'
      )
    ).toBe('')
  })

  it('preserves generic thinking extraction for non-Claude providers', () => {
    expect(
      extractProviderThinkingText({
        type: 'assistant',
        content: [{ reasoning: 'generic provider reasoning' }]
      })
    ).toBe('generic provider reasoning')
  })
})
