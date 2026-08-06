import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_FANOUT_LANE_LAYOUT, resolveFanoutLaneLayout } from './fanoutLanePairing'

const SRC = join(__dirname, '..')

describe('fan-out lane layout default', () => {
  it('lays lanes two-across out of the box', () => {
    expect(DEFAULT_FANOUT_LANE_LAYOUT).toBe('paired')
  })

  it('pairs for a settings file that has never carried the key', () => {
    // The 15aa51e37 build shipped the setting as opt-in, so every user who
    // upgraded — and every fresh install — has NO `fanoutLaneLayout` key at
    // all. If absence did not mean the default, the new default would reach
    // nobody but a user who had already found the control.
    expect(resolveFanoutLaneLayout(undefined)).toBe('paired')
    expect(resolveFanoutLaneLayout(null)).toBe('paired')
  })

  it('honours an explicit opt-out', () => {
    expect(resolveFanoutLaneLayout('stacked')).toBe('stacked')
  })

  it('honours an explicit opt-in', () => {
    expect(resolveFanoutLaneLayout('paired')).toBe('paired')
  })

  it('falls back to the default for a value it does not recognise', () => {
    // A hand-edited settings file, or one written by a build that later grows a
    // third layout, must land on the default rather than on `undefined` — the
    // root attribute is stamped unconditionally and CSS would match neither.
    expect(resolveFanoutLaneLayout('two-across')).toBe('paired')
    expect(resolveFanoutLaneLayout(7)).toBe('paired')
  })
})

describe('fan-out lane layout default has no second source of truth', () => {
  // The layout reaches the DOM through three independent seams: the appearance
  // hook (which stamps `data-fanout-lane-layout` on :root), the Settings select
  // (which shows the user what is in force), and the transcript panel (which
  // stamps the per-lane slot). A literal fallback left behind in any one of
  // them does not fail to compile and does not fail a render — it just quietly
  // serves the OLD default from that seam, which is exactly how the setting
  // came to be invisible in the first place.
  const seams = [
    'hooks/useAppearance.ts',
    'components/SettingsPanel.tsx',
    'components/TranscriptPanel.tsx'
  ]

  for (const seam of seams) {
    it(`${seam} resolves the layout through the shared default`, () => {
      const source = readFileSync(join(SRC, seam), 'utf8')
      const fallbacks = source.match(/fanoutLaneLayout[^\n]*?['"]stacked['"]/g) ?? []
      expect(fallbacks).toEqual([])
      expect(source).toMatch(/DEFAULT_FANOUT_LANE_LAYOUT|resolveFanoutLaneLayout/)
    })
  }
})
