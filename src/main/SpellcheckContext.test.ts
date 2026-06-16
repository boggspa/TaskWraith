import { describe, expect, it } from 'vitest'
import { sanitizeSpellcheckContext, spellcheckContextMatchesPoint } from './SpellcheckContext'

describe('SpellcheckContext', () => {
  it('keeps a small sanitized snapshot of misspelled word suggestions', () => {
    const snapshot = sanitizeSpellcheckContext(
      {
        x: 40.4,
        y: 80.6,
        misspelledWord: '  teh  ',
        dictionarySuggestions: ['the', 'ten', 'the', '', 'then']
      },
      1000
    )

    expect(snapshot).toEqual({
      x: 40,
      y: 81,
      misspelledWord: 'teh',
      dictionarySuggestions: ['the', 'ten', 'then'],
      createdAt: 1000
    })
  })

  it('rejects empty words and stale or distant point lookups', () => {
    expect(
      sanitizeSpellcheckContext({
        x: 1,
        y: 2,
        misspelledWord: '',
        dictionarySuggestions: ['word']
      })
    ).toBeNull()

    const snapshot = sanitizeSpellcheckContext(
      {
        x: 100,
        y: 120,
        misspelledWord: 'recieve',
        dictionarySuggestions: ['receive']
      },
      2000
    )

    expect(spellcheckContextMatchesPoint(snapshot, { x: 110, y: 130 }, 2200)).toBe(true)
    expect(spellcheckContextMatchesPoint(snapshot, { x: 180, y: 130 }, 2200)).toBe(false)
    expect(spellcheckContextMatchesPoint(snapshot, { x: 110, y: 130 }, 4000)).toBe(false)
  })
})
