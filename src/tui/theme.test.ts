import { describe, expect, it } from 'vitest'
import { visibleWidth } from './ansi'
import {
  detectTuiUnicode,
  resolveTuiDensity,
  TUI_GLYPHS_ASCII,
  TUI_GLYPHS_UNICODE,
  TUI_MIN_COLUMNS,
  tuiStatusGlyph,
  tuiStatusTone,
  type TuiRunStatus
} from './theme'

const runStatuses: TuiRunStatus[] = [
  'working',
  'next',
  'queued',
  'needs-input',
  'failed',
  'done',
  'skipped',
  'sleeping',
  'idle'
]

describe('TaskWraith TUI design tokens', () => {
  it('keeps every ASCII fallback glyph to exactly one terminal column', () => {
    for (const glyph of Object.values(TUI_GLYPHS_ASCII)) {
      expect(visibleWidth(glyph)).toBe(1)
    }
  })

  it('provides every Unicode glyph slot in the ASCII fallback', () => {
    expect(Object.keys(TUI_GLYPHS_ASCII).sort()).toEqual(Object.keys(TUI_GLYPHS_UNICODE).sort())
  })

  it('uses a distinct glyph for every run status in both glyph sets', () => {
    for (const glyphs of [TUI_GLYPHS_UNICODE, TUI_GLYPHS_ASCII]) {
      const glyphsByStatus = runStatuses.map((status) => tuiStatusGlyph(status, glyphs))
      expect(new Set(glyphsByStatus).size).toBe(runStatuses.length)
    }
  })

  it('maps terminal run outcomes to semantic tones', () => {
    expect(tuiStatusTone('failed')).toBe('error')
    expect(tuiStatusTone('needs-input')).toBe('warning')
    expect(tuiStatusTone('done')).toBe('good')
    expect(tuiStatusTone('working')).toBe('neutral')
  })

  it('resolves density tiers at the documented boundaries', () => {
    expect(resolveTuiDensity(71).tier).toBe('compact')
    expect(resolveTuiDensity(72).tier).toBe('normal')
    expect(resolveTuiDensity(99).tier).toBe('normal')
    expect(resolveTuiDensity(100).tier).toBe('expanded')
  })

  it('keeps density sub-affordance thresholds explicit and stable', () => {
    expect(resolveTuiDensity(85).batonCastSlots).toBe(2)
    expect(resolveTuiDensity(86).batonCastSlots).toBe(3)
    expect(resolveTuiDensity(103).batonCastSlots).toBe(3)
    expect(resolveTuiDensity(104).batonCastSlots).toBe(4)

    expect(resolveTuiDensity(63).composerHints).toBe('none')
    expect(resolveTuiDensity(64).composerHints).toBe('short')
    expect(resolveTuiDensity(87).composerHints).toBe('short')
    expect(resolveTuiDensity(88).composerHints).toBe('full')
  })

  it('clamps density resolution below the supported terminal width', () => {
    const density = resolveTuiDensity(0)
    expect(density.width).toBe(TUI_MIN_COLUMNS)
    expect(density.tier).toBe('compact')
  })

  it('only enables Unicode chrome for positively identified UTF-8 terminals', () => {
    expect(detectTuiUnicode({ TERM: 'linux', LANG: 'en_GB.UTF-8' })).toBe(false)
    expect(detectTuiUnicode({ TERM: 'dumb', LANG: 'en_GB.UTF-8' })).toBe(false)
    expect(detectTuiUnicode({ TASKWRAITH_TUI_ASCII: '1', LANG: 'en_GB.UTF-8' })).toBe(false)
    expect(detectTuiUnicode({ LANG: 'en_GB.UTF-8' })).toBe(true)
    expect(detectTuiUnicode({})).toBe(false)
  })
})
