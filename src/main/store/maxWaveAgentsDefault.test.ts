import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_WAVE_AGENTS } from '../../shared/fleetWave'
import { MainSourceProbe } from '../mainSourceProbe.testutil'
import { adoptSupersededMaxWaveAgents } from './maxWaveAgentsDefault'

describe('Max Wave Agents default', () => {
  it('keeps the shipped default and the wave parser default in step', () => {
    // `defaultSettings` states the number as a literal (it is the shipped
    // settings shape, not a derived value), so it can drift from the parser's
    // default silently — and a store default of 8 against a parser default of
    // 12 would refuse the very roster the slider claims to allow.
    //
    // Anchored on the `defaultSettings` declaration rather than scanned over
    // the file: a bare `/maxWaveAgents: (\d+),/` took whichever entry came
    // first across 14k lines, so any other object literal that grew the field
    // would have been read in place of the shipped one, and renaming or
    // deleting `defaultSettings` would have left the check green over the
    // wrong subject entirely. `binding` throws when the declaration goes, and
    // the scan then covers only that initializer.
    const store = new MainSourceProbe(
      'src/main/store/index.ts',
      new URL('./index.ts', import.meta.url)
    )
    const shipped = [
      ...store.text(store.binding('defaultSettings')).matchAll(/\bmaxWaveAgents\s*:\s*(\d+)\b/g)
    ]

    // Exactly one entry: with two, the later one wins at runtime while a
    // first-match read reports the earlier — the silent-drift shape this test
    // exists to catch.
    expect(shipped).toHaveLength(1)
    expect(Number(shipped[0][1])).toBe(DEFAULT_MAX_WAVE_AGENTS)
  })

  it('lifts an install still carrying the superseded default', () => {
    // Every settings write persisted the whole merged object, so 8 is on disk
    // for installs that never opened the slider. Without this the raised
    // default would reach nobody.
    expect(adoptSupersededMaxWaveAgents(8)).toBe(DEFAULT_MAX_WAVE_AGENTS)
  })

  it('honours any other stored choice', () => {
    expect(adoptSupersededMaxWaveAgents(2)).toBe(2)
    expect(adoptSupersededMaxWaveAgents(6)).toBe(6)
    expect(adoptSupersededMaxWaveAgents(20)).toBe(20)
    expect(adoptSupersededMaxWaveAgents(64)).toBe(64)
  })

  it('still clamps to the 2–64 band', () => {
    expect(adoptSupersededMaxWaveAgents(1)).toBe(2)
    expect(adoptSupersededMaxWaveAgents(0)).toBe(2)
    expect(adoptSupersededMaxWaveAgents(999)).toBe(64)
    expect(adoptSupersededMaxWaveAgents(12.9)).toBe(12)
  })

  it('takes the default for a missing or malformed value', () => {
    expect(adoptSupersededMaxWaveAgents(undefined)).toBe(DEFAULT_MAX_WAVE_AGENTS)
    expect(adoptSupersededMaxWaveAgents(null)).toBe(DEFAULT_MAX_WAVE_AGENTS)
    expect(adoptSupersededMaxWaveAgents('nope')).toBe(DEFAULT_MAX_WAVE_AGENTS)
    expect(adoptSupersededMaxWaveAgents(Number.NaN)).toBe(DEFAULT_MAX_WAVE_AGENTS)
    expect(adoptSupersededMaxWaveAgents(Number.POSITIVE_INFINITY)).toBe(DEFAULT_MAX_WAVE_AGENTS)
  })

  it('a value clamping ONTO the superseded default is still lifted', () => {
    // 8.4 floors to 8; treating that differently from a stored 8 would be an
    // arbitrary distinction the reader could never predict.
    expect(adoptSupersededMaxWaveAgents(8.4)).toBe(DEFAULT_MAX_WAVE_AGENTS)
  })
})
