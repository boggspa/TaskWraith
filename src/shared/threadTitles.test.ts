import { describe, expect, it } from 'vitest'
import { normalizeThreadTitle, THREAD_TITLE_MAX_CHARS } from './threadTitles'

describe('thread title normalization', () => {
  it('collapses whitespace and trims without adding ellipses', () => {
    expect(normalizeThreadTitle('  Rename\n this\tchat  ')).toBe('Rename this chat')
  })

  it('bounds titles to the remote bridge title limit', () => {
    const title = normalizeThreadTitle('A'.repeat(THREAD_TITLE_MAX_CHARS + 20))
    expect(title).toHaveLength(THREAD_TITLE_MAX_CHARS)
    expect(title.endsWith('...')).toBe(false)
  })

  it('uses the fallback for empty titles', () => {
    expect(normalizeThreadTitle('   ', 'New Chat')).toBe('New Chat')
  })
})

