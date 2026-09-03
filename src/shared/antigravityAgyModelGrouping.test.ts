import { describe, expect, it } from 'vitest'
import {
  antigravityDisplayName,
  antigravityEffortForModelId,
  antigravityReasoningLadderOptions,
  antigravityUltraTaskTargetId,
  antigravityVariantGroupForModel,
  groupAntigravityModelRows
} from './antigravityAgyModelGrouping'

/** The offerable agy catalogue observed 2026-09-02 (AntigravityAgyStaticModels). */
const CATALOGUE = [
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'gemini-3.7-flash-high',
  'gemini-3.7-flash-medium',
  'gemini-3.7-flash-low',
  'gemini-3.6-flash-high',
  'gemini-3.6-flash-medium',
  'gemini-3.6-flash-low',
  'gemini-3.5-flash-high',
  'gemini-3.5-flash-medium',
  'gemini-3.5-flash-low',
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-low',
  'flash-3.7',
  'flash-3.6',
  'flash-3.5',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'gpt-oss-120b-medium'
].map((id) => ({ id, label: id }))

describe('antigravityModelGrouping', () => {
  it('groups the live catalogue to one readable row per host model', () => {
    const rows = groupAntigravityModelRows(CATALOGUE)
    expect(rows.map((row) => row.label)).toEqual([
      'Gemini 3.8 Flash',
      'Gemini 3.7 Flash',
      'Gemini 3.6 Flash',
      'Gemini 3.5 Flash',
      'Gemini 3.1 Pro',
      'Flash 3.7 Fast',
      'Flash 3.6 Fast',
      'Flash 3.5 Fast',
      'Sonnet 4.6',
      'Opus 4.6',
      'GPT-OSS (120B Param)'
    ])
    // Unselected grouped rows resolve to their catalogue-first variant.
    expect(rows[0].id).toBe('gemini-3.8-flash-high')
    expect(rows[0].antigravityVariants).toEqual([
      { effort: 'low', id: 'gemini-3.8-flash-low' },
      { effort: 'medium', id: 'gemini-3.8-flash-medium' },
      { effort: 'high', id: 'gemini-3.8-flash-high' }
    ])
    expect(rows[4].id).toBe('gemini-3.1-pro-high')
    expect(rows[10].id).toBe('gpt-oss-120b-medium')
  })

  it('a grouped row follows the selected variant of its family', () => {
    const rows = groupAntigravityModelRows(CATALOGUE, 'gemini-3.8-flash-low')
    expect(rows[0].id).toBe('gemini-3.8-flash-low')
    // Other families stay on their defaults.
    expect(rows[1].id).toBe('gemini-3.7-flash-high')
  })

  it('preserves exact support metadata for single and selected grouped rows', () => {
    const rows = groupAntigravityModelRows(
      [
        { id: 'gemini-api:gemini-3.6-flash', ultraTaskSupported: true },
        { id: 'gemini-4-flash-high', ultraTaskSupported: true },
        { id: 'gemini-4-flash-low', ultraTaskSupported: false },
        { id: 'claude-sonnet-4-6', ultraTaskSupported: false }
      ],
      'gemini-4-flash-low'
    )

    expect(rows[0]).toMatchObject({ ultraTaskSupported: true })
    expect(rows[1]).toMatchObject({
      id: 'gemini-4-flash-low',
      ultraTaskSupported: false
    })
    expect(rows[2]).toMatchObject({ ultraTaskSupported: false })
  })

  it('parses effort suffixes and fixed reasoning', () => {
    expect(antigravityEffortForModelId('gemini-3.8-flash-high')).toBe('high')
    expect(antigravityEffortForModelId('gemini-3.1-pro-low')).toBe('low')
    expect(antigravityEffortForModelId('gpt-oss-120b-medium')).toBe('medium')
    expect(antigravityEffortForModelId('claude-opus-4-6')).toBe('on')
    expect(antigravityEffortForModelId('claude-sonnet-4-6')).toBe('on')
  })

  it('exposes slider variants low → high with the family default preserved', () => {
    const group = antigravityVariantGroupForModel(CATALOGUE, 'gemini-3.8-flash-medium')
    expect(group?.displayName).toBe('Gemini 3.8 Flash')
    expect(group?.variants.map((variant) => variant.effort)).toEqual(['low', 'medium', 'high'])
    expect(group?.defaultId).toBe('gemini-3.8-flash-high')

    const pro = antigravityVariantGroupForModel(CATALOGUE, 'gemini-3.1-pro-high')
    expect(pro?.variants.map((variant) => variant.effort)).toEqual(['low', 'high'])

    const oss = antigravityVariantGroupForModel(CATALOGUE, 'gpt-oss-120b-medium')
    expect(oss).toBeNull()

    expect(antigravityVariantGroupForModel(CATALOGUE, 'claude-sonnet-4-6')).toBeNull()
  })

  it('prettifies unknown future ids without a table entry', () => {
    expect(antigravityDisplayName('gemini-4-flash')).toBe('Gemini 4 Flash')
    expect(antigravityDisplayName('llama-scout-8b')).toBe('Llama Scout 8B')
    expect(antigravityDisplayName('claude-haiku-4-5')).toBe('Claude Haiku 4.5')
  })

  it('passes gemini-api lane rows through untouched — curated labels win', () => {
    // The API lane has its own curated naming and no effort-suffix
    // convention; my prettifier mangled these live (2026-07-28 regression:
    // "Gemini Api:gemini 3.5 Flash").
    const mixed = [
      { id: 'gemini-api:gemini-3.5-flash', label: '3.5 Flash' },
      { id: 'gemini-api:gemini-2.5-flash-lite', label: '2.5 Flash-Lite' },
      ...CATALOGUE
    ]
    const rows = groupAntigravityModelRows(mixed)
    expect(rows[0]).toEqual({ id: 'gemini-api:gemini-3.5-flash', label: '3.5 Flash' })
    expect(rows[1]).toEqual({ id: 'gemini-api:gemini-2.5-flash-lite', label: '2.5 Flash-Lite' })
    // The agy families still group after the api rows.
    expect(rows.map((row) => row.label)).toContain('Gemini 3.8 Flash')
    // An api id never joins a variant group even hypothetically.
    expect(antigravityVariantGroupForModel(mixed, 'gemini-api:gemini-3.5-flash')).toBeNull()
  })

  it('keeps a curated label on a suffix-less agy row', () => {
    const rows = groupAntigravityModelRows([
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (Antigravity)' }
    ])
    expect(rows[0].label).toBe('Sonnet 4.6 (Antigravity)')
  })
})

/** Verbatim `agy models` result observed 2026-09-03 (the app's on-disk cache),
 * as the picker receives it: bare wire ids, labels equal to the CLI's own. */
const LIVE_CATALOGUE = [
  { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
  { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
  { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
  { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
  { id: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
  { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
  { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
  { id: 'gemini-api:gemini-3.8-flash', label: '3.8 Flash' }
]

describe('antigravity reasoning ladder options', () => {
  it('offers a variant family its variants with UltraTask on top', () => {
    expect(antigravityReasoningLadderOptions(LIVE_CATALOGUE, 'gemini-3.8-flash-low', true)).toEqual(
      [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        { value: 'ultraTask', label: 'UltraTask' }
      ]
    )
    // A family that ships without a Medium is still a movable ladder.
    expect(
      antigravityReasoningLadderOptions(LIVE_CATALOGUE, 'gemini-3.1-pro-high', true).map(
        (option) => option.value
      )
    ).toEqual(['low', 'high', 'ultraTask'])
  })

  it('gives a fixed-reasoning row its own Thinking stop, never a fake Off', () => {
    // These models cannot stop reasoning. Offering `off` (or dropping the stop
    // entirely) left the ladder with UltraTask as its ONLY stop, which the
    // picker renders as an inert locked rail — the shipped bug.
    for (const modelId of ['claude-sonnet-4-6', 'claude-opus-4-6-thinking']) {
      const options = antigravityReasoningLadderOptions(LIVE_CATALOGUE, modelId, true)
      expect(options).toEqual([
        { value: 'on', label: 'Thinking' },
        { value: 'ultraTask', label: 'UltraTask' }
      ])
      expect(options.some((option) => option.value === 'off')).toBe(false)
    }
    expect(antigravityReasoningLadderOptions(LIVE_CATALOGUE, 'gpt-oss-120b-medium', true)).toEqual([
      { value: 'medium', label: 'Medium' },
      { value: 'ultraTask', label: 'UltraTask' }
    ])
  })

  it('keeps a fixed-reasoning stop even when UltraTask is unsupported', () => {
    expect(antigravityReasoningLadderOptions(LIVE_CATALOGUE, 'claude-sonnet-4-6', false)).toEqual([
      { value: 'on', label: 'Thinking' }
    ])
    expect(
      antigravityReasoningLadderOptions(LIVE_CATALOGUE, 'gemini-3.8-flash-high', false).map(
        (option) => option.value
      )
    ).toEqual(['low', 'medium', 'high'])
  })

  it('seeds an Off bottom stop only where the model has no reasoning of its own', () => {
    // The gemini-api lane carries no effort convention, so UltraTask alone
    // would be the ladder's single (locked) stop without a bottom stop.
    expect(
      antigravityReasoningLadderOptions(LIVE_CATALOGUE, 'gemini-api:gemini-3.8-flash', true)
    ).toEqual([
      { value: 'off', label: 'Off' },
      { value: 'ultraTask', label: 'UltraTask' }
    ])
    expect(
      antigravityReasoningLadderOptions(LIVE_CATALOGUE, 'gemini-api:gemini-3.8-flash', false)
    ).toEqual([])
  })

  it('maps UltraTask onto the family ceiling, and onto itself when fixed', () => {
    expect(antigravityUltraTaskTargetId(LIVE_CATALOGUE, 'gemini-3.8-flash-low')).toBe(
      'gemini-3.8-flash-high'
    )
    // Derived from the family, not the literal `-high` suffix: a family whose
    // ceiling is Medium still has a target.
    expect(
      antigravityUltraTaskTargetId(
        [{ id: 'gemini-4-flash-low' }, { id: 'gemini-4-flash-medium' }],
        'gemini-4-flash-low'
      )
    ).toBe('gemini-4-flash-medium')
    expect(antigravityUltraTaskTargetId(LIVE_CATALOGUE, 'claude-sonnet-4-6')).toBe(
      'claude-sonnet-4-6'
    )
    expect(antigravityUltraTaskTargetId(LIVE_CATALOGUE, 'gemini-api:gemini-3.8-flash')).toBeNull()
  })
})
