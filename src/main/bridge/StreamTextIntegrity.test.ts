import { describe, expect, it } from 'vitest'
import { rejoinHeldSurrogate, splitTrailingLoneHighSurrogate } from './StreamTextIntegrity'

const WAVE = '🌊' // U+1F30A — one high + one low surrogate in UTF-16
const HIGH = WAVE[0]
const LOW = WAVE[1]

describe('splitTrailingLoneHighSurrogate', () => {
  it('passes ordinary text through untouched', () => {
    expect(splitTrailingLoneHighSurrogate('hello 🌊 world')).toEqual({
      emit: 'hello 🌊 world',
      held: ''
    })
    expect(splitTrailingLoneHighSurrogate('')).toEqual({ emit: '', held: '' })
  })

  it('holds back a trailing lone high surrogate', () => {
    const split = splitTrailingLoneHighSurrogate(`tide pools ${HIGH}`)
    expect(split.emit).toBe('tide pools ')
    expect(split.held).toBe(HIGH)
  })

  it('leaves a complete pair at the end alone', () => {
    const split = splitTrailingLoneHighSurrogate(`tide pools ${WAVE}`)
    expect(split.emit).toBe(`tide pools ${WAVE}`)
    expect(split.held).toBe('')
  })

  it('emits nothing when the delta is only the high half', () => {
    expect(splitTrailingLoneHighSurrogate(HIGH)).toEqual({ emit: '', held: HIGH })
  })
})

describe('rejoinHeldSurrogate', () => {
  it('heals an emoji split across two deltas', () => {
    const first = splitTrailingLoneHighSurrogate(`sea ${HIGH}`)
    const second = rejoinHeldSurrogate(first.held, `${LOW} star`)
    expect(first.emit + second.emit).toBe(`sea ${WAVE} star`)
    expect(second.held).toBe('')
    // Every emitted piece is well-formed on its own — the property the wire
    // needs so Swift's JSON decoding never sees an unpaired escape.
    expect(first.emit.isWellFormed()).toBe(true)
    expect(second.emit.isWellFormed()).toBe(true)
  })

  it('chains across consecutive split emoji', () => {
    const first = splitTrailingLoneHighSurrogate(HIGH)
    const second = rejoinHeldSurrogate(first.held, `${LOW}${HIGH}`)
    const third = rejoinHeldSurrogate(second.held, LOW)
    expect(first.emit + second.emit + third.emit).toBe(`${WAVE}${WAVE}`)
    expect(second.emit.isWellFormed()).toBe(true)
    expect(third.emit.isWellFormed()).toBe(true)
  })
})
