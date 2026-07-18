import { describe, expect, it } from 'vitest'
import {
  activeCodexModelRows,
  codexModelRetiresAt,
  hasReachedCodexRetirementDate,
  isCodexModelRetired
} from './codexModelLifecycle'

describe('Codex model lifecycle', () => {
  it('does not encode the unsubstantiated 2026-07-23 rumor for GPT-5.4', () => {
    expect(codexModelRetiresAt('gpt-5.4')).toBeUndefined()
    expect(codexModelRetiresAt('gpt-5.4-mini')).toBeUndefined()
    expect(isCodexModelRetired('gpt-5.4', new Date(2026, 6, 23, 12))).toBe(false)
    expect(isCodexModelRetired('gpt-5.4-mini', new Date(2026, 6, 23, 12))).toBe(false)
  })

  it('takes a verified date-only sunset at the start of the local calendar day', () => {
    for (const model of [
      'gpt-5-codex',
      'gpt-5.1-codex',
      'gpt-5.1-codex-max',
      'gpt-5.1-codex-mini',
      'gpt-5.2-codex'
    ]) {
      expect(codexModelRetiresAt(model)).toBe('2026-07-23')
    }
    expect(isCodexModelRetired('gpt-5.2-codex', new Date(2026, 6, 22, 23, 59))).toBe(false)
    expect(isCodexModelRetired('gpt-5.2-codex', new Date(2026, 6, 23, 0, 0))).toBe(true)
    expect(isCodexModelRetired('gpt-5.2-codex', new Date(2026, 6, 24, 0, 0))).toBe(true)
  })

  it('fails open for malformed lifecycle dates', () => {
    const now = new Date(2026, 6, 23, 12)
    expect(hasReachedCodexRetirementDate('2026-02-30', now)).toBe(false)
    expect(hasReachedCodexRetirementDate('23-07-2026', now)).toBe(false)
    expect(hasReachedCodexRetirementDate('', now)).toBe(false)
    expect(hasReachedCodexRetirementDate(undefined, now)).toBe(false)
  })

  it('keeps historical hard retirements blocked and annotated', () => {
    expect(codexModelRetiresAt(' GPT-5.2 ')).toBe('2026-06-02')
    expect(isCodexModelRetired('gpt-5.2', new Date(2026, 4, 1))).toBe(true)
    expect(isCodexModelRetired('gpt-5.3-codex')).toBe(true)
  })

  it('warns before a dated sunset and removes the row on the retirement day', () => {
    const rows = [
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
      { id: 'gpt-5.2', label: 'GPT-5.2' }
    ]

    expect(activeCodexModelRows(rows, new Date(2026, 6, 22))).toEqual([
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', retiresAt: '2026-07-23' }
    ])
    expect(activeCodexModelRows(rows, new Date(2026, 6, 23))).toEqual([
      { id: 'gpt-5.4', label: 'GPT-5.4' }
    ])
  })
})
