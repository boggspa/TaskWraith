import { describe, expect, it } from 'vitest'
import {
  codexReasoningSummaryActivityId,
  codexReasoningSummaryDisplayText,
  codexReasoningSummaryGroupDisplayText,
  codexReasoningSummaryModeForEffort,
  codexReasoningSummaryText,
  shouldGroupCodexReasoningSummaries,
  type CodexReasoningSummaryGroupState
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

describe('codexReasoningSummaryDisplayText', () => {
  it('removes Codex empty-comment separators without joining summary parts', () => {
    expect(
      codexReasoningSummaryDisplayText(
        '**Planning the fix**\n\n<!-- -->**Checking the fix**\n\n<!---->'
      )
    ).toBe('**Planning the fix**\n\n**Checking the fix**')
  })

  it('hides an empty-comment marker while its closing delta is incomplete', () => {
    const deltas = ['**Planning the fix**', '\n\n<!--', '-', ' -->']
    let raw = ''

    expect(
      deltas.map((delta) => {
        raw += delta
        return codexReasoningSummaryDisplayText(raw)
      })
    ).toEqual([
      '**Planning the fix**',
      '**Planning the fix**',
      '**Planning the fix**',
      '**Planning the fix**'
    ])
  })

  it('preserves meaningful HTML comments in reasoning about markup', () => {
    expect(codexReasoningSummaryDisplayText('Inspect `<!-- TODO -->` next.')).toBe(
      'Inspect `<!-- TODO -->` next.'
    )
  })
})

describe('GPT-5.6 reasoning summary grouping', () => {
  function groupState(): CodexReasoningSummaryGroupState {
    return {
      reasoningSummaryGroupIdByItemId: new Map(),
      reasoningSummaryItemIdsByGroupId: new Map()
    }
  }

  it('is exclusive to Luna, Terra, and Sol (including preview aliases)', () => {
    expect(shouldGroupCodexReasoningSummaries('gpt-5.6-luna')).toBe(true)
    expect(shouldGroupCodexReasoningSummaries('GPT-5.6-Terra')).toBe(true)
    expect(shouldGroupCodexReasoningSummaries('preview:openai:gpt-5.6:sol')).toBe(true)
    expect(shouldGroupCodexReasoningSummaries('gpt-5.5')).toBe(false)
    expect(shouldGroupCodexReasoningSummaries('gpt-5.6')).toBe(false)
    expect(shouldGroupCodexReasoningSummaries(undefined)).toBe(false)
  })

  it('coalesces adjacent decoded summaries with paragraph breaks', () => {
    const state = groupState()
    const firstGroup = codexReasoningSummaryActivityId(state, 'gpt-5.6-sol', 'reasoning-1')
    const secondGroup = codexReasoningSummaryActivityId(state, 'gpt-5.6-sol', 'reasoning-2')
    const textByItemId = new Map([
      ['reasoning-1', '**Planning the fix**\n\n<!-- -->'],
      ['reasoning-2', '**Checking the result**']
    ])

    expect(firstGroup).toBe('reasoning-1')
    expect(secondGroup).toBe(firstGroup)
    expect(codexReasoningSummaryGroupDisplayText(state, firstGroup, textByItemId)).toBe(
      '**Planning the fix**\n\n**Checking the result**'
    )
  })

  it('starts a new row after visible non-reasoning output', () => {
    const state = groupState()
    expect(codexReasoningSummaryActivityId(state, 'gpt-5.6-luna', 'reasoning-1')).toBe(
      'reasoning-1'
    )
    state.thinkingChronoBreak = true
    expect(codexReasoningSummaryActivityId(state, 'gpt-5.6-luna', 'reasoning-2')).toBe(
      'reasoning-2'
    )
  })

  it('keeps existing item updates in their original group without consuming a later break', () => {
    const state = groupState()
    expect(codexReasoningSummaryActivityId(state, 'gpt-5.6-terra', 'reasoning-1')).toBe(
      'reasoning-1'
    )
    state.thinkingChronoBreak = true
    expect(codexReasoningSummaryActivityId(state, 'gpt-5.6-terra', 'reasoning-1')).toBe(
      'reasoning-1'
    )
    expect(state.thinkingChronoBreak).toBe(true)
    expect(codexReasoningSummaryActivityId(state, 'gpt-5.6-terra', 'reasoning-2')).toBe(
      'reasoning-2'
    )
  })

  it('preserves per-item rows for other Codex models', () => {
    const state = groupState()
    expect(codexReasoningSummaryActivityId(state, 'gpt-5.5', 'reasoning-1')).toBe('reasoning-1')
    expect(codexReasoningSummaryActivityId(state, 'gpt-5.5', 'reasoning-2')).toBe('reasoning-2')
  })
})
