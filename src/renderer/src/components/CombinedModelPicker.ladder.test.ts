import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ReasoningLadderSlider,
  buildLadderModel,
  clampedLadderIndex,
  ladderIndexForOption,
  nearestEnabledLadderIndex,
  reasoningLadderFxProfile
} from './CombinedModelPicker'

describe('reasoning ladder mapping', () => {
  it('maps codex/claude efforts onto their canonical stops', () => {
    expect(ladderIndexForOption('codex', 'low')).toBe(1)
    expect(ladderIndexForOption('codex', 'medium')).toBe(2)
    expect(ladderIndexForOption('codex', 'high')).toBe(3)
    expect(ladderIndexForOption('codex', 'xhigh')).toBe(4)
    expect(ladderIndexForOption('codex', 'max')).toBe(5)
    expect(ladderIndexForOption('codex', 'ultracode')).toBe(6)
  })

  it('coalesces provider synonyms (extra→xhigh, light→low)', () => {
    expect(ladderIndexForOption('claude', 'extra')).toBe(4)
    expect(ladderIndexForOption('claude', 'Light')).toBe(1)
  })

  it('rides Kimi thinking on the bottom two stops (off→Off, on→Light)', () => {
    expect(ladderIndexForOption('kimi', 'off')).toBe(0)
    expect(ladderIndexForOption('kimi', 'on')).toBe(1)
    // Kimi never carries reasoning efforts, so a stray effort does not map.
    expect(ladderIndexForOption('kimi', 'high')).toBeNull()
  })

  it('returns null for values off the ladder', () => {
    expect(ladderIndexForOption('codex', 'turbo')).toBeNull()
  })
})

describe('buildLadderModel', () => {
  it('builds an ascending enabled set + provider label map for Sol (ultracode = "Ultra")', () => {
    const ladder = buildLadderModel('codex', [
      { value: 'low', label: 'Light' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra High' },
      { value: 'max', label: 'Max' },
      { value: 'ultracode', label: 'Ultra' }
    ])
    expect(ladder.enabledIndices).toEqual([1, 2, 3, 4, 5, 6])
    expect(ladder.valueByIndex[6]).toBe('ultracode')
    // Sol's Codex label is "Ultra"; it still lands on the shared Ultracode stop.
    expect(ladder.labelByIndex[6]).toBe('Ultra')
  })

  it('drops disabled options from the enabled set (thumb can never park there)', () => {
    const ladder = buildLadderModel('claude', [
      { value: 'low', label: 'Light' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra High', disabled: true }
    ])
    expect(ladder.enabledIndices).toEqual([1, 2, 3])
    expect(ladder.enabledSet.has(4)).toBe(false)
  })

  it('places Grok/Cursor low/medium/high on stops 1-3', () => {
    const ladder = buildLadderModel('grok', [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' }
    ])
    expect(ladder.enabledIndices).toEqual([1, 2, 3])
  })

  it('maps Kimi thinking on/off to a two-stop ladder with its own labels', () => {
    const ladder = buildLadderModel('kimi', [
      { value: 'on', label: 'Thinking on' },
      { value: 'off', label: 'Thinking off' }
    ])
    expect(ladder.enabledIndices).toEqual([0, 1])
    expect(ladder.valueByIndex[0]).toBe('off')
    expect(ladder.valueByIndex[1]).toBe('on')
    expect(ladder.labelByIndex[1]).toBe('Thinking on')
  })
})

describe('nearestEnabledLadderIndex (drag snap)', () => {
  it('breaks exact ties to the higher stop, matching iOS', () => {
    expect(nearestEnabledLadderIndex(4, [3, 5])).toBe(5)
  })

  it('returns the closest enabled stop', () => {
    expect(nearestEnabledLadderIndex(6, [1, 2, 3])).toBe(3)
    expect(nearestEnabledLadderIndex(0, [1, 2, 3])).toBe(1)
    expect(nearestEnabledLadderIndex(2, [1, 2, 3])).toBe(2)
  })

  it('returns null for an empty enabled set', () => {
    expect(nearestEnabledLadderIndex(3, [])).toBeNull()
  })
})

describe('clampedLadderIndex (thumb parking)', () => {
  const grokLadder = buildLadderModel('grok', [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' }
  ])

  it('parks on the current effort when enabled', () => {
    expect(clampedLadderIndex('grok', 'medium', grokLadder)).toBe(2)
  })

  it('clamps a carried-over disabled effort to the nearest enabled stop', () => {
    // 'ultracode' (index 6) is not offered by Grok → clamps down to high (3).
    expect(clampedLadderIndex('grok', 'ultracode', grokLadder)).toBe(3)
  })

  it('falls back to the lowest enabled stop for an unmappable effort', () => {
    expect(clampedLadderIndex('grok', 'turbo', grokLadder)).toBe(1)
  })
})

describe('reasoning ladder visual taper', () => {
  it('ramps intensity and density from Low/Thinking through Ultra', () => {
    expect(
      Array.from({ length: 7 }, (_, index) => reasoningLadderFxProfile(index).sparkleCount)
    ).toEqual([0, 3, 5, 8, 11, 13, 16])
    expect(
      Array.from({ length: 7 }, (_, index) => reasoningLadderFxProfile(index).shimmerBandCount)
    ).toEqual([0, 1, 1, 2, 2, 3, 3])
    expect(reasoningLadderFxProfile(0)).toEqual({
      active: false,
      strength: 0,
      sparkleCount: 0,
      shimmerBandCount: 0
    })
    expect(reasoningLadderFxProfile(1)).toEqual({
      active: true,
      strength: 1 / 6,
      sparkleCount: 3,
      shimmerBandCount: 1
    })
    expect(reasoningLadderFxProfile(3)).toEqual({
      active: true,
      strength: 1 / 2,
      sparkleCount: 8,
      shimmerBandCount: 2
    })
    expect(reasoningLadderFxProfile(6)).toEqual({
      active: true,
      strength: 1,
      sparkleCount: 16,
      shimmerBandCount: 3
    })
  })

  it('mounts sparse Low FX inside the active fill and keeps Off neutral', () => {
    const ladder = buildLadderModel('codex', [
      { value: 'off', label: 'Off' },
      { value: 'low', label: 'Light' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra' },
      { value: 'max', label: 'Max' },
      { value: 'ultracode', label: 'Ultra' }
    ])
    const render = (selectedReasoning: string) =>
      renderToStaticMarkup(
        createElement(ReasoningLadderSlider, {
          provider: 'codex',
          ladder,
          selectedReasoning,
          onSelectReasoning: () => undefined,
          onInteract: () => undefined
        })
      )

    const off = render('off')
    expect(off).not.toContain('data-fx-active')
    expect(off).not.toContain('composer-combined-picker-ladder-pulse')

    const low = render('low')
    expect(low).toContain('data-fx-active="true"')
    expect(low).toContain('--ladder-fill-height:calc(')
    expect(low).toContain('composer-combined-picker-ladder-pulse')
    expect(low.match(/class="composer-combined-picker-ladder-sparkle"/g)).toHaveLength(3)
    expect(low.match(/class="composer-combined-picker-ladder-shimmer-band"/g)).toHaveLength(1)
  })
})
