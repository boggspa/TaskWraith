import { describe, expect, it } from 'vitest'
import {
  derivePromptFallbackThreadTitle,
  isPlaceholderThreadTitle,
  isKnownPromptFallbackThreadTitle,
  normalizeLocalAiThreadTitle,
  normalizeThreadTitle,
  THREAD_TITLE_LOCAL_AI_MAX_CHARS,
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

describe('prompt fallback titles', () => {
  it('uses the first meaningful markdown-free line and truncates at a word boundary', () => {
    expect(
      derivePromptFallbackThreadTitle(
        '\n## Repair the resumed thread naming lifecycle without breaking manual titles\n\nDetails'
      )
    ).toBe('Repair the resumed thread naming lifecycle without breaking manual…')
  })

  it('recognises current and legacy automatic first-prompt shapes', () => {
    const prompt = 'Explain why resumed placeholder threads keep their factory title'
    expect(isKnownPromptFallbackThreadTitle(prompt, prompt)).toBe(true)
    expect(isKnownPromptFallbackThreadTitle(`${prompt.slice(0, 30)}...`, prompt)).toBe(true)
    expect(isKnownPromptFallbackThreadTitle('My manual name', prompt)).toBe(false)
  })
})

describe('local AI title normalization', () => {
  it('accepts a plain three-to-seven-word title', () => {
    expect(normalizeLocalAiThreadTitle('  Resilient Thread Title Lifecycle  ')).toBe(
      'Resilient Thread Title Lifecycle'
    )
  })

  it('rejects placeholders, prose, and oversized results', () => {
    expect(normalizeLocalAiThreadTitle('New Chat')).toBeNull()
    expect(normalizeLocalAiThreadTitle('Too short')).toBeNull()
    expect(normalizeLocalAiThreadTitle('word '.repeat(8))).toBeNull()
    expect(normalizeLocalAiThreadTitle('x'.repeat(THREAD_TITLE_LOCAL_AI_MAX_CHARS + 1))).toBeNull()
  })
})
