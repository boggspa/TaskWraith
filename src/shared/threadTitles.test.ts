import { describe, expect, it } from 'vitest'
import {
  isPlaceholderThreadTitle,
  normalizeThreadTitle,
  THREAD_TITLE_MAX_CHARS
} from './threadTitles'

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

describe('placeholder title detection', () => {
  it('recognises every create-factory placeholder, whitespace-tolerant', () => {
    expect(isPlaceholderThreadTitle('New Chat')).toBe(true)
    expect(isPlaceholderThreadTitle('New Ensemble')).toBe(true)
    expect(isPlaceholderThreadTitle('New Workflow')).toBe(true)
    expect(isPlaceholderThreadTitle('  New   Chat  ')).toBe(true)
  })

  it('treats empty and missing titles as placeholders', () => {
    expect(isPlaceholderThreadTitle('')).toBe(true)
    expect(isPlaceholderThreadTitle('   ')).toBe(true)
    expect(isPlaceholderThreadTitle(null)).toBe(true)
    expect(isPlaceholderThreadTitle(undefined)).toBe(true)
  })

  it('never claims a user-authored title', () => {
    expect(isPlaceholderThreadTitle('New chat about crabs')).toBe(false)
    expect(isPlaceholderThreadTitle('Tidepool refactor')).toBe(false)
    expect(isPlaceholderThreadTitle('new chat')).toBe(false)
  })
})

