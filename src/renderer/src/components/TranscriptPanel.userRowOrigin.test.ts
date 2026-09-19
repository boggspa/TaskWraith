import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

/**
 * A user row that arrived through a machine channel (the local-control
 * socket) keeps the user bubble but names its sender instead of "You". The
 * speaker and badge logic is tested in shared/messageOrigin.test.ts; this pins
 * the wiring in the transcript, which has no DOM test environment here (the
 * established source-structure style of composerSteerButton.test.ts).
 */
describe('transcript user-row speaker label', () => {
  const source = readFileSync(new URL('./TranscriptPanel.tsx', import.meta.url), 'utf8')

  it('imports the speaker and badge helpers rather than a flattened label', () => {
    expect(source).toContain(
      "import { messageOriginBadges, messageOriginSpeaker } from '../../../shared/messageOrigin'"
    )
    expect(source).not.toContain('messageOriginLabel(')
  })

  /**
   * Indentation is not the guarded property. These pins previously embedded the
   * exact leading whitespace of the JSX, so any reindent or line-shape change
   * reddened them while the wiring they exist to protect was untouched -- and
   * this repo has already had to unwind a formatting pay-down for breaking
   * byte-pinned files (63f4f200c). Comparing with whitespace squashed keeps the
   * full structural guard -- element nesting, class names, the key, the
   * fallback -- without pinning the formatter's output.
   */
  const squash = (text: string): string => text.replace(/\s+/g, '')
  const squashedSource = squash(source)

  it('renders the origin speaker in place of "You", keeping the user-meta seam', () => {
    expect(squashedSource).toContain(
      squash(`<div className="message-meta user-meta">
        <span className="message-meta-label">{originSpeaker ?? 'You'}</span>`)
    )
  })

  it('renders each identifying chip as its own badge beside the speaker', () => {
    expect(squashedSource).toContain(
      squash(`{messageOriginBadges(msg.metadata?.origin).map((badge) => (
        <span key={badge} className="message-meta-model-badge">{badge}</span>
      ))}`)
    )
  })
})
