import { describe, expect, it } from 'vitest'
import {
  antigravityDisplayName,
  antigravityEffortForModelId,
  antigravityVariantGroupForModel,
  groupAntigravityModelRows
} from './antigravityAgyModelGrouping'

/** The offerable agy catalogue observed 2026-08-13 (AntigravityAgyStaticModels). */
const CATALOGUE = [
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
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium'
].map((id) => ({ id, label: id }))

describe('antigravityModelGrouping', () => {
  it('groups the live catalogue to one readable row per host model', () => {
    const rows = groupAntigravityModelRows(CATALOGUE)
    expect(rows.map((row) => row.label)).toEqual([
      'Gemini 3.7 Flash',
      'Gemini 3.6 Flash',
      'Gemini 3.5 Flash',
      'Gemini 3.1 Pro',
      'Claude Sonnet 4.6',
      'Claude Opus 4.6 Thinking',
      'GPT-OSS 120B'
    ])
    // Unselected grouped rows resolve to their catalogue-first variant.
    expect(rows[0].id).toBe('gemini-3.7-flash-high')
    expect(rows[0].antigravityVariants).toEqual([
      { effort: 'low', id: 'gemini-3.7-flash-low' },
      { effort: 'medium', id: 'gemini-3.7-flash-medium' },
      { effort: 'high', id: 'gemini-3.7-flash-high' }
    ])
    expect(rows[3].id).toBe('gemini-3.1-pro-high')
    expect(rows[6].id).toBe('gpt-oss-120b-medium')
  })

  it('a grouped row follows the selected variant of its family', () => {
    const rows = groupAntigravityModelRows(CATALOGUE, 'gemini-3.7-flash-low')
    expect(rows[0].id).toBe('gemini-3.7-flash-low')
    // Other families stay on their defaults.
    expect(rows[1].id).toBe('gemini-3.6-flash-high')
  })

  it('parses effort suffixes and refuses -thinking', () => {
    expect(antigravityEffortForModelId('gemini-3.7-flash-high')).toBe('high')
    expect(antigravityEffortForModelId('gemini-3.1-pro-low')).toBe('low')
    expect(antigravityEffortForModelId('gpt-oss-120b-medium')).toBe('medium')
    expect(antigravityEffortForModelId('claude-opus-4-6-thinking')).toBeNull()
    expect(antigravityEffortForModelId('claude-sonnet-4-6')).toBeNull()
  })

  it('exposes slider variants low → high with the family default preserved', () => {
    const group = antigravityVariantGroupForModel(CATALOGUE, 'gemini-3.7-flash-medium')
    expect(group?.displayName).toBe('Gemini 3.7 Flash')
    expect(group?.variants.map((variant) => variant.effort)).toEqual(['low', 'medium', 'high'])
    expect(group?.defaultId).toBe('gemini-3.7-flash-high')

    const pro = antigravityVariantGroupForModel(CATALOGUE, 'gemini-3.1-pro-high')
    expect(pro?.variants.map((variant) => variant.effort)).toEqual(['low', 'high'])

    const oss = antigravityVariantGroupForModel(CATALOGUE, 'gpt-oss-120b-medium')
    expect(oss?.variants.map((variant) => variant.effort)).toEqual(['medium'])

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
    expect(rows.map((row) => row.label)).toContain('Gemini 3.7 Flash')
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
