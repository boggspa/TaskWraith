import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  CombinedModelPicker,
  ReasoningLadderSlider,
  buildLadderModel,
  chipReasoningSparkleTier,
  clampedLadderIndex,
  splitChipReasoningPieces,
  ladderIndexForOption,
  nearestEnabledLadderIndex,
  resolveReasoningLadderAvailability,
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

  it('maps Kimi fixed On plus K3 Low/High/Max onto the shared ladder', () => {
    expect(ladderIndexForOption('kimi', 'off')).toBe(0)
    expect(ladderIndexForOption('kimi', 'on')).toBe(1)
    expect(ladderIndexForOption('kimi', 'low')).toBe(1)
    expect(ladderIndexForOption('kimi', 'high')).toBe(3)
    expect(ladderIndexForOption('kimi', 'max')).toBe(5)
  })

  it('returns null for values off the ladder', () => {
    expect(ladderIndexForOption('codex', 'turbo')).toBeNull()
  })

  it('maps Muse Meta /effort onto the shared ladder (minimal→xhigh→ultra)', () => {
    // Muse's CLI ladder is minimal|low|medium|high|xhigh|ultra. Minimal parks
    // at Off (0); ultra parks at the Ultracode stop (6) with value "ultra"
    // (not Codex's "ultracode"); xhigh must not be dropped.
    expect(ladderIndexForOption('muse', 'minimal')).toBe(0)
    expect(ladderIndexForOption('muse', 'low')).toBe(1)
    expect(ladderIndexForOption('muse', 'medium')).toBe(2)
    expect(ladderIndexForOption('muse', 'high')).toBe(3)
    expect(ladderIndexForOption('muse', 'xhigh')).toBe(4)
    expect(ladderIndexForOption('muse', 'ultra')).toBe(6)
    // Muse-scoped synonyms must not remap a foreign provider's minimal/ultra.
    expect(ladderIndexForOption('codex', 'minimal')).toBeNull()
    expect(ladderIndexForOption('pi', 'minimal')).toBeNull()
  })
})

describe('buildLadderModel', () => {
  it('enables Muse minimal/low/medium/high/xhigh/ultra on stops [0,1,2,3,4,6]', () => {
    const ladder = buildLadderModel('muse', [
      { value: 'minimal', label: 'Minimal' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra High' },
      { value: 'ultra', label: 'Ultra' }
    ])
    expect(ladder.enabledIndices).toEqual([0, 1, 2, 3, 4, 6])
    expect(ladder.valueByIndex).toEqual({
      0: 'minimal',
      1: 'low',
      2: 'medium',
      3: 'high',
      4: 'xhigh',
      6: 'ultra'
    })
    expect(ladder.valueByIndex[6]).toBe('ultra')
    expect(ladder.valueByIndex[6]).not.toBe('ultracode')
    // Intentional Max hole: drag/clamp near index 5 snaps to Ultra (tie→higher).
    expect(nearestEnabledLadderIndex(5, ladder.enabledIndices)).toBe(6)
    expect(clampedLadderIndex('muse', 'max', ladder)).toBe(6)
    expect(clampedLadderIndex('muse', 'ultracode', ladder)).toBe(6)
  })

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

describe('unavailable reasoning presentation', () => {
  const emptyLadder = buildLadderModel('ollama', [])

  it('uses disabled Medium only for Cursor Composer 2.5 variants', () => {
    for (const modelId of ['composer-2.5', 'composer-2.5-fast']) {
      expect(resolveReasoningLadderAvailability('cursor', modelId, emptyLadder)).toMatchObject({
        mutable: false,
        unavailablePresentation: { index: 2, label: 'Medium' }
      })
    }

    for (const [provider, modelId] of [
      ['cursor', 'grok-4.5'],
      ['cursor', 'unknown-cursor-model'],
      ['grok', 'grok-composer-2.5-fast'],
      ['gemini', 'gemini-3.1-pro'],
      ['ollama', 'qwen3.5:9b']
    ] as const) {
      expect(resolveReasoningLadderAvailability(provider, modelId, emptyLadder)).toMatchObject({
        mutable: false,
        unavailablePresentation: { index: 0, label: '—' }
      })
    }
  })

  it('treats K2.7 Coding as fixed On and K3 Low/High/Max as mutable', () => {
    const fixed = buildLadderModel('codex', [{ value: 'medium', label: 'Medium' }])
    const kimiFixed = buildLadderModel('kimi', [{ value: 'on', label: 'On' }])
    const kimiMutable = buildLadderModel('kimi', [
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max' }
    ])

    expect(resolveReasoningLadderAvailability('codex', 'fixed-live-model', fixed)).toEqual({
      mutable: false,
      unavailablePresentation: {
        index: 2,
        label: 'Medium',
        disabledReason: 'Reasoning is fixed for this model'
      }
    })
    expect(resolveReasoningLadderAvailability('kimi', 'kimi-k2.7-code', kimiFixed)).toEqual({
      mutable: false,
      unavailablePresentation: {
        index: 1,
        label: 'On',
        disabledReason: 'Thinking is always on and cannot be disabled for this model.'
      }
    })
    expect(resolveReasoningLadderAvailability('kimi', 'kimi-k3', kimiMutable)).toEqual({
      mutable: true
    })

    const markup = renderToStaticMarkup(
      createElement(ReasoningLadderSlider, {
        provider: 'kimi',
        modelId: 'kimi-k2.7-code',
        ladder: kimiFixed,
        selectedReasoning: 'on',
        onSelectReasoning: () => undefined,
        unavailablePresentation: resolveReasoningLadderAvailability(
          'kimi',
          'kimi-k2.7-code',
          kimiFixed
        ).unavailablePresentation,
        onInteract: () => undefined
      })
    )
    expect(markup).toContain('data-disabled="true"')
    expect(markup).toContain('aria-valuenow="1"')
    expect(markup).toContain('--ladder-accent:var(--provider-kimi-color, var(--accent))')
    expect(markup).toContain('data-fx-active="true"')
    expect(markup.match(/class="composer-combined-picker-ladder-sparkle"/g)).toHaveLength(3)
  })

  it('enables configurable reasoning for Devstral Small and Mistral Medium 3.5', () => {
    const mistralLadder = buildLadderModel('mistral', [
      { value: 'off', label: 'Off' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max' }
    ])

    expect(resolveReasoningLadderAvailability('mistral', 'mistral-medium-3.5', mistralLadder)).toEqual({
      mutable: true
    })
    expect(resolveReasoningLadderAvailability('pi', 'mistral/mistral-medium-3.5', mistralLadder)).toEqual(
      {
        mutable: true
      }
    )
    expect(resolveReasoningLadderAvailability('mistral', 'devstral-small', mistralLadder)).toEqual({
      mutable: true
    })
    expect(resolveReasoningLadderAvailability('pi', 'mistral/devstral-small', mistralLadder)).toEqual(
      {
        mutable: true
      }
    )

    const markup = renderToStaticMarkup(
      createElement(ReasoningLadderSlider, {
        provider: 'mistral',
        ladder: mistralLadder,
        selectedReasoning: 'high',
        onSelectReasoning: () => undefined,
        unavailablePresentation: resolveReasoningLadderAvailability(
          'mistral',
          'mistral-medium-3.5',
          mistralLadder
        ).unavailablePresentation,
        onInteract: () => undefined
      })
    )
    expect(markup).toContain('aria-valuenow="3"')
    expect(markup).toContain('aria-valuetext="High"')
    expect(markup).toContain('--ladder-accent:var(--provider-mistral-color, var(--accent))')
    expect(markup).toContain('data-fx-active="true"')
    expect(markup).toContain('--ladder-fx-strength:0.5')
    expect(markup).toContain('composer-combined-picker-ladder-sparkles')
    expect(markup.match(/class="composer-combined-picker-ladder-sparkle"/g)).toHaveLength(8)
    expect(markup).not.toContain('data-disabled="true"')
    expect(markup).toContain('composer-combined-picker-ladder-shimmer-band')
  })

  it('keeps generic zero neutral and animates implicit Cursor Medium', () => {
    const renderUnavailable = (provider: 'cursor' | 'ollama', modelId: string) => {
      const ladder = buildLadderModel(provider, [])
      const availability = resolveReasoningLadderAvailability(provider, modelId, ladder)
      return renderToStaticMarkup(
        createElement(ReasoningLadderSlider, {
          provider,
          ladder,
          selectedReasoning: '',
          onSelectReasoning: () => undefined,
          unavailablePresentation: availability.unavailablePresentation,
          onInteract: () => undefined
        })
      )
    }

    const generic = renderUnavailable('ollama', 'qwen3.5:9b')
    expect(generic).toContain('data-disabled="true"')
    expect(generic).toContain('aria-disabled="true"')
    expect(generic).toContain('tabindex="-1"')
    expect(generic).toContain('aria-valuenow="0"')
    expect(generic).toContain('aria-valuetext="—"')
    expect(generic).toContain('--ladder-accent:var(--text-secondary)')

    for (const modelId of ['composer-2.5', 'composer-2.5-fast']) {
      const cursor = renderUnavailable('cursor', modelId)
      expect(cursor).toContain('aria-valuenow="2"')
      expect(cursor).toContain('aria-valuetext="Medium"')
      expect(cursor).toContain('--ladder-accent:var(--provider-cursor-color, var(--accent))')
      expect(cursor).toContain('data-fx-active="true"')
      expect(cursor).toContain('composer-combined-picker-ladder-pulse')
      expect(cursor).toContain('composer-combined-picker-ladder-shimmer')
      expect(cursor).toContain('composer-combined-picker-ladder-sparkles')
      expect(cursor.match(/class="composer-combined-picker-ladder-sparkle"/g)).toHaveLength(5)
      expect(cursor.match(/class="composer-combined-picker-ladder-shimmer-band"/g)).toHaveLength(1)
    }
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
    expect(low).not.toContain('aria-disabled')
    expect(low).toContain('data-fx-active="true"')
    expect(low).toContain('--ladder-fill-height:calc(')
    expect(low).toContain('composer-combined-picker-ladder-pulse')
    expect(low.match(/class="composer-combined-picker-ladder-sparkle"/g)).toHaveLength(3)
    expect(low.match(/class="composer-combined-picker-ladder-shimmer-band"/g)).toHaveLength(1)
  })

  it('uses the selected Pi upstream hue for reasoning ladder FX', () => {
    const ladder = buildLadderModel('pi', [
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' }
    ])
    const html = renderToStaticMarkup(
      createElement(ReasoningLadderSlider, {
        provider: 'pi',
        modelId: 'deepseek/deepseek-v4-pro',
        ladder,
        selectedReasoning: 'high',
        onSelectReasoning: () => undefined,
        onInteract: () => undefined
      })
    )

    expect(html).toContain('--ladder-accent:var(--provider-deepseek-color, var(--accent))')
  })
})

describe('chipReasoningSparkleTier', () => {
  it('keeps the full sparkle field for Max and Ultra/Ultracode', () => {
    expect(chipReasoningSparkleTier('max')).toBe('full')
    expect(chipReasoningSparkleTier('ultracode')).toBe('full')
    expect(chipReasoningSparkleTier('ultra')).toBe('full')
    expect(chipReasoningSparkleTier(' Max ')).toBe('full')
  })

  it('gives Extra (xhigh) the faint field only', () => {
    expect(chipReasoningSparkleTier('xhigh')).toBe('faint')
  })

  it('renders no overlay for hue-only and plain tiers', () => {
    // High/Medium/Low/Thinking are provider-hue-only (pure CSS); Off and
    // unknown values stay entirely plain.
    for (const value of ['high', 'medium', 'low', 'light', 'on', 'off', '', 'mystery']) {
      expect(chipReasoningSparkleTier(value)).toBeNull()
    }
  })
})

describe('splitChipReasoningPieces', () => {
  it('splits a plain trailing reasoning suffix', () => {
    expect(splitChipReasoningPieces('GPT-5.6-Sol Light', 'Light')).toEqual({
      primary: 'GPT-5.6-Sol',
      suffix: 'Light',
      tail: ''
    })
    expect(splitChipReasoningPieces('Grok 4.5 \u00b7 High', 'High')).toEqual({
      primary: 'Grok 4.5',
      suffix: 'High',
      tail: ''
    })
  })

  it('keeps the reasoning suffix span when Cursor appends " Fast" after it', () => {
    expect(splitChipReasoningPieces('Grok 4.5 \u00b7 High Fast', 'High')).toEqual({
      primary: 'Grok 4.5',
      suffix: 'High',
      tail: 'Fast'
    })
    expect(splitChipReasoningPieces('Grok 4.5 High Fast', 'High')).toEqual({
      primary: 'Grok 4.5',
      suffix: 'High',
      tail: 'Fast'
    })
  })

  it('degrades to an unsplit chip when the suffix is absent or unmatched', () => {
    expect(splitChipReasoningPieces('Composer 2.5 \u00b7 Fast', '')).toEqual({
      primary: 'Composer 2.5 \u00b7 Fast',
      suffix: '',
      tail: ''
    })
    expect(splitChipReasoningPieces('Some Chip', 'High')).toEqual({
      primary: 'Some Chip',
      suffix: '',
      tail: ''
    })
  })
})

describe('trigger chip fast-mode rendering', () => {
  const cursorFastProps = {
    provider: 'cursor' as const,
    composerStyle: 'taskwraith' as never,
    modelOptions: [{ id: 'grok-4.5', label: 'Cursor Grok 4.5' }],
    selectedModelId: 'grok-4.5',
    onSelectModel: () => {},
    reasoningOptions: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' }
    ],
    selectedReasoning: 'high',
    onSelectReasoning: () => {},
    cursorReasoningEffort: 'high',
    fastModeCapableModelIds: new Set(['grok-4.5']),
    fastModeEnabled: true,
    onToggleFastMode: () => {}
  }

  it('renders the bolt + hued reasoning suffix + plain Fast tail for Cursor Fast', () => {
    const html = renderToStaticMarkup(createElement(CombinedModelPicker, cursorFastProps))
    // Bolt to the left of the model label on a non-Codex shell.
    expect(html).toContain('composer-combined-picker-trigger-fast-bolt')
    // The reasoning suffix keeps its own span (tier hue hooks onto it)…
    expect(html).toMatch(/composer-combined-picker-trigger-suffix[^>]*>High</)
    // …and "Fast" renders as its own plain tail, not inside the suffix.
    expect(html).toMatch(/composer-combined-picker-trigger-fast[^-][^>]*>Fast</)
    // Cursor needs its Fast tail to retain a visible gap after the reasoning suffix.
    expect(html).toContain('style="margin-left:0"')
    expect(html).toMatch(/composer-combined-picker-trigger-primary[^>]*>Grok 4\.5</)
    expect(html).toContain('data-selected-reasoning="high"')
  })

  it('spreads the faint Extra sparkle field across the whole suffix', () => {
    const codexXhighProps = {
      ...cursorFastProps,
      provider: 'codex' as const,
      modelOptions: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }],
      selectedModelId: 'gpt-5.6-sol',
      reasoningOptions: [
        { value: 'xhigh', label: 'Extra High' },
        { value: 'max', label: 'Max' }
      ],
      selectedReasoning: 'xhigh',
      codexReasoningEffort: 'xhigh',
      cursorReasoningEffort: undefined,
      fastModeEnabled: false
    }
    const html = renderToStaticMarkup(createElement(CombinedModelPicker, codexXhighProps))
    expect(html).toContain('composer-combined-picker-trigger-sparkles is-faint')
    // 4 dots spanning the field — including one right of 54% (the plain
    // slice(0,4) regression clustered every dot on the left half).
    const dots = html.match(/composer-combined-picker-trigger-sparkle"/g) ?? []
    expect(dots.length).toBe(4)
    expect(html).toContain('left:93%')
  })

  it('renders no bolt when fast mode is off or the model is not capable', () => {
    const off = renderToStaticMarkup(
      createElement(CombinedModelPicker, { ...cursorFastProps, fastModeEnabled: false })
    )
    expect(off).not.toContain('composer-combined-picker-trigger-fast-bolt')
    const incapable = renderToStaticMarkup(
      createElement(CombinedModelPicker, {
        ...cursorFastProps,
        fastModeCapableModelIds: new Set<string>()
      })
    )
    expect(incapable).not.toContain('composer-combined-picker-trigger-fast-bolt')
  })
})
