import { describe, it, expect } from 'vitest'
import {
  DEFAULT_USER_MESSAGE_COLLAPSE_THRESHOLDS,
  shouldCollapseUserMessage,
  truncateUserMessagePreview
} from './UserMessageCollapse'

const T = DEFAULT_USER_MESSAGE_COLLAPSE_THRESHOLDS

describe('shouldCollapseUserMessage', () => {
  it('keeps a short message uncollapsed', () => {
    // The everyday case: "Can you summarise the README?" — there's nothing
    // worth hiding behind a "Show more".
    expect(shouldCollapseUserMessage('Hello, can you summarise the README?')).toBe(false)
  })

  it('collapses a message that overruns the character budget', () => {
    // Build a single-line message that exceeds the char threshold by a clear
    // margin so the test stays robust to small threshold tweaks.
    const longLine = 'word '.repeat(Math.ceil((T.maxChars + 50) / 5))
    expect(longLine.length).toBeGreaterThan(T.maxChars)
    expect(shouldCollapseUserMessage(longLine)).toBe(true)
  })

  it('collapses a message that overruns the line budget', () => {
    const lines = Array.from({ length: T.maxLines + 3 }, (_, i) => `line ${i}`).join('\n')
    expect(shouldCollapseUserMessage(lines)).toBe(true)
  })

  it('does NOT collapse when exactly at the threshold (off-by-one guard)', () => {
    // Exactly maxLines lines, well under maxChars — must stay visible to
    // avoid jitter at the boundary.
    const lines = Array.from({ length: T.maxLines }, (_, i) => `line ${i}`).join('\n')
    expect(lines.split('\n').length).toBe(T.maxLines)
    expect(lines.length).toBeLessThanOrEqual(T.maxChars)
    expect(shouldCollapseUserMessage(lines)).toBe(false)
  })

  it('does not collapse empty or whitespace-only content', () => {
    // Nothing to hide, and we never want a "Show more" button on a blank
    // bubble — that would look broken.
    expect(shouldCollapseUserMessage('')).toBe(false)
    expect(shouldCollapseUserMessage('   ')).toBe(false)
    expect(shouldCollapseUserMessage('\n\n  \n')).toBe(false)
  })
})

describe('truncateUserMessagePreview', () => {
  it('returns a preview that ends at a word boundary, never mid-word', () => {
    const sentence =
      'The quick brown fox jumps over the lazy dog and then the second sentence keeps going '.repeat(
        20
      )
    const preview = truncateUserMessagePreview(sentence)
    expect(preview.length).toBeLessThanOrEqual(T.previewChars)
    // No trailing partial word: the cut should land on a whitespace boundary
    // in the source string, so the next char in the original is either ws or
    // end-of-string.
    const nextChar = sentence.charAt(preview.length)
    expect(nextChar === '' || /\s/.test(nextChar) || /\s/.test(preview.slice(-1))).toBe(true)
  })

  it('never exceeds the previewChars cutoff', () => {
    // Worst case — one giant unbroken word. Even without whitespace to anchor
    // on, the preview must respect the hard cap.
    const giant = 'x'.repeat(T.previewChars * 4)
    const preview = truncateUserMessagePreview(giant)
    expect(preview.length).toBeLessThanOrEqual(T.previewChars)
  })

  it('caps multi-line briefs at previewLines and avoids breaking a markdown code block', () => {
    // A spec brief with a fenced code block early on. If the preview lands
    // mid-fence, the bubble would render a dangling opener — bad UX.
    const brief = [
      'Here is a long brief.',
      'It has several lines.',
      '```ts',
      'const example = 1;',
      'const another = 2;',
      'const yetAnother = 3;',
      'const andMore = 4;',
      'const stillGoing = 5;',
      '```',
      'Plus closing prose.',
      'Plus more closing prose.',
      'Plus even more.'
    ].join('\n')

    const preview = truncateUserMessagePreview(brief)
    const fences = (preview.match(/```/g) || []).length
    // Either zero fences (we cut before the block) or an even number (block
    // closed inside the preview). Never odd.
    expect(fences % 2).toBe(0)
    expect(preview.split('\n').length).toBeLessThanOrEqual(T.previewLines)
  })

  it('closes a leading backtick fence inside the preview instead of returning a blank or dangling block', () => {
    const preview = truncateUserMessagePreview(
      ['```ts', 'const first = "a long code example"', 'const second = "keeps going"'].join('\n'),
      { maxLines: 20, maxChars: 1_000, previewLines: 3, previewChars: 36 }
    )

    expect(preview).not.toBe('')
    expect(preview).toMatch(/^```ts/)
    expect(preview).toMatch(/\n```$/)
    expect(preview.match(/```/g) || []).toHaveLength(2)
    expect(preview.length).toBeLessThanOrEqual(36)
    expect(preview.split('\n').length).toBeLessThanOrEqual(3)
  })

  it('recognizes tilde fences and removes a trailing partial block from prose-led previews', () => {
    const preview = truncateUserMessagePreview(
      ['A short introduction.', '~~~python', 'print("a long example")', 'print("still going")'].join(
        '\n'
      ),
      { maxLines: 20, maxChars: 1_000, previewLines: 3, previewChars: 80 }
    )

    expect(preview).toBe('A short introduction.')
    expect(preview).not.toContain('~~~')
  })

  it('closes a leading tilde fence with the matching marker', () => {
    const preview = truncateUserMessagePreview(
      [
        '~~~~sql',
        'select a_really_long_column_name from example_table',
        'where enabled = true'
      ].join('\n'),
      { maxLines: 20, maxChars: 1_000, previewLines: 3, previewChars: 42 }
    )

    expect(preview).toMatch(/^~~~~sql/)
    expect(preview).toMatch(/\n~~~~$/)
    expect(preview.match(/~~~~/g) || []).toHaveLength(2)
    expect(preview.length).toBeLessThanOrEqual(42)
  })

  it('returns an empty string for empty input', () => {
    expect(truncateUserMessagePreview('')).toBe('')
  })

  it('respects custom thresholds when provided', () => {
    const text = 'one two three four five six seven eight nine ten'
    const preview = truncateUserMessagePreview(text, {
      maxLines: 100,
      maxChars: 1000,
      previewLines: 1,
      previewChars: 15
    })
    expect(preview.length).toBeLessThanOrEqual(15)
    // Word boundary respected: trailing chars are not a half-word from the
    // source.
    const nextChar = text.charAt(preview.length)
    expect(nextChar === '' || /\s/.test(nextChar) || /\s/.test(preview.slice(-1))).toBe(true)
  })
})
