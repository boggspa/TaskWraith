import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

/**
 * A user row that arrived through a machine channel (the local-control
 * socket) keeps the user bubble but names its sender instead of "You". The
 * label logic is tested in shared/messageOrigin.test.ts; this pins the wiring
 * in the transcript, which has no DOM test environment here (the established
 * source-structure style of composerSteerButton.test.ts).
 */
describe('transcript user-row speaker label', () => {
  const source = readFileSync(new URL('./TranscriptPanel.tsx', import.meta.url), 'utf8')

  it('names a socket-sent row by its origin and falls back to "You"', () => {
    expect(source).toContain("import { messageOriginLabel } from '../../../shared/messageOrigin'")
    expect(source).toContain(
      '<div className="message-meta user-meta">\n' +
        "                            {messageOriginLabel(msg.metadata?.origin) ?? 'You'}\n" +
        '                          </div>'
    )
  })
})
