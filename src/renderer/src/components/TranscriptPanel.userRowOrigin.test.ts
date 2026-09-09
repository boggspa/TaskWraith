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

  it('renders the origin speaker in place of "You", keeping the user-meta seam', () => {
    expect(source).toContain(
      '<div className="message-meta user-meta">\n' +
        '                            <span className="message-meta-label">\n' +
        "                              {originSpeaker ?? 'You'}\n" +
        '                            </span>'
    )
  })

  it('renders each identifying chip as its own badge beside the speaker', () => {
    expect(source).toContain(
      '{messageOriginBadges(msg.metadata?.origin).map((badge) => (\n' +
        '                              <span key={badge} className="message-meta-model-badge">\n' +
        '                                {badge}\n' +
        '                              </span>\n' +
        '                            ))}'
    )
  })
})
