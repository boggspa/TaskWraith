import { describe, expect, it } from 'vitest'
import {
  activeCodexModelRows,
  codexModelRetiresAt,
  hasReachedCodexRetirementDate,
  isCodexModelRetired
} from './codexModelLifecycle'

describe('Codex model lifecycle', () => {
  it('retires GPT-5.4 on the user-approved date, not the 2026-07-23 rumor', () => {
    // The 5.4 pair and Spark were retired by the user on 2026-09-18. That is a
    // product decision, and it must not be confused with — or quietly
    // rewritten to — the 2026-07-23 deprecation-table rumor this test has
    // guarded against since 5.4 shipped: all three were still runnable then.
    for (const model of ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark']) {
      expect(codexModelRetiresAt(model)).toBe('2026-09-18')
      expect(codexModelRetiresAt(model)).not.toBe('2026-07-23')
      expect(isCodexModelRetired(model, new Date(2026, 6, 23, 12))).toBe(false)
      expect(isCodexModelRetired(model, new Date(2026, 8, 17, 23, 59))).toBe(false)
      expect(isCodexModelRetired(model, new Date(2026, 8, 18, 0, 0))).toBe(true)
    }
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
    // gpt-5.5 is the control: it carries no retirement row at all, so it must
    // survive every clock. gpt-5.4 is dated now, so it can no longer play that
    // part — on 2026-07-22 it still shows, but carrying its warning date.
    const rows = [
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
      { id: 'gpt-5.2', label: 'GPT-5.2' }
    ]

    expect(activeCodexModelRows(rows, new Date(2026, 6, 22))).toEqual([
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'gpt-5.4', label: 'GPT-5.4', retiresAt: '2026-09-18' },
      { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', retiresAt: '2026-07-23' }
    ])
    expect(activeCodexModelRows(rows, new Date(2026, 6, 23))).toEqual([
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'gpt-5.4', label: 'GPT-5.4', retiresAt: '2026-09-18' }
    ])
    // And on the 5.4 retirement day only the undated control is left.
    expect(activeCodexModelRows(rows, new Date(2026, 8, 18))).toEqual([
      { id: 'gpt-5.5', label: 'GPT-5.5' }
    ])
  })
})
