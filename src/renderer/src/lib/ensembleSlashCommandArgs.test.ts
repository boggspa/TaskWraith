import { describe, expect, it } from 'vitest'

import {
  parsePositiveIntArg,
  parseSlashToggleArg,
  remainingTextAfterFirstArg
} from './ensembleSlashCommandArgs'

describe('parseSlashToggleArg', () => {
  it('parses explicit on / off / toggle commands (case-insensitive)', () => {
    expect(parseSlashToggleArg('on', false)).toBe(true)
    expect(parseSlashToggleArg('OFF', true)).toBe(false)
    expect(parseSlashToggleArg('toggle', true)).toBe(false)
    expect(parseSlashToggleArg('tOgGlE', false)).toBe(true)
  })

  it('defaults bare input to toggling', () => {
    expect(parseSlashToggleArg('', false)).toBe(true)
    expect(parseSlashToggleArg('   ', true)).toBe(false)
  })

  it('uses only the first token and preserves unknown tokens', () => {
    expect(parseSlashToggleArg('on now', false)).toBe(true)
    expect(parseSlashToggleArg('off everything', true)).toBe(false)
    expect(parseSlashToggleArg('toggle after this', true)).toBe(false)
    expect(parseSlashToggleArg('later', true)).toBe(true)
  })
})

describe('parsePositiveIntArg', () => {
  it('parses first-token integers and clamps by optional bounds', () => {
    expect(parsePositiveIntArg('12', { fallback: 6, min: 1, max: 20 })).toBe(12)
    expect(parsePositiveIntArg('0', { fallback: 6, min: 1, max: 20 })).toBe(6)
    expect(parsePositiveIntArg('999', { fallback: 6, min: 1, max: 20 })).toBe(20)
    expect(parsePositiveIntArg('1', { fallback: 6, min: 4, max: 20 })).toBe(4)
  })

  it('parses the first token and ignores trailing text', () => {
    expect(parsePositiveIntArg('12 extra text', { fallback: 9, min: 1, max: 20 })).toBe(12)
  })

  it('falls back for malformed numeric values', () => {
    expect(parsePositiveIntArg('abc', { fallback: 6, min: 1, max: 20 })).toBe(6)
    expect(parsePositiveIntArg('12.1', { fallback: 6, min: 1, max: 20 })).toBe(6)
    expect(parsePositiveIntArg('-3', { fallback: 6, min: 1, max: 20 })).toBe(6)
    expect(parsePositiveIntArg('', { fallback: 6, min: 1, max: 20 })).toBe(6)
    expect(parsePositiveIntArg('   ', { fallback: 6, min: 1, max: 20 })).toBe(6)
  })
})

describe('remainingTextAfterFirstArg', () => {
  it('returns the trimmed suffix after the first token', () => {
    expect(remainingTextAfterFirstArg('  toggle  with extra')).toBe('with extra')
    expect(remainingTextAfterFirstArg('on\t with\tmixed spacing')).toBe('with\tmixed spacing')
    expect(remainingTextAfterFirstArg('single')).toBe('')
    expect(remainingTextAfterFirstArg('')).toBe('')
  })
})
