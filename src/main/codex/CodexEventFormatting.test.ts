import { describe, expect, it } from 'vitest'
import {
  codexReasoningSummaryModeForEffort,
  codexReasoningSummaryText
} from './CodexEventFormatting'

describe('codexReasoningSummaryModeForEffort', () => {
  it('opts into OpenAI reasoning summaries for active reasoning efforts', () => {
    expect(codexReasoningSummaryModeForEffort('medium')).toBe('auto')
    expect(codexReasoningSummaryModeForEffort('xhigh')).toBe('auto')
  })

  it('does not request summaries when reasoning is disabled or unset', () => {
    expect(codexReasoningSummaryModeForEffort('off')).toBeUndefined()
    expect(codexReasoningSummaryModeForEffort('none')).toBeUndefined()
    expect(codexReasoningSummaryModeForEffort(null)).toBeUndefined()
  })
})

describe('codexReasoningSummaryText', () => {
  it('extracts only explicit Codex/OpenAI summary text', () => {
    expect(
      codexReasoningSummaryText([
        { type: 'summary_text', text: 'Read files. ' },
        { type: 'reasoning_summary_text', text: 'Picked the narrow fix.' }
      ])
    ).toBe('Read files. Picked the narrow fix.')
  })

  it('does not stringify raw reasoning content or opaque encrypted state', () => {
    expect(
      codexReasoningSummaryText({
        content: [{ type: 'reasoning_text', text: 'raw chain should stay hidden' }],
        encrypted_content: 'opaque'
      })
    ).toBe('')
    expect(codexReasoningSummaryText({ type: 'reasoning_text', delta: 'raw delta' })).toBe('')
  })
})
