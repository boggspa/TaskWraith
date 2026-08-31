import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MentionHighlightedText } from './MentionHighlightedText'

describe('MentionHighlightedText', () => {
  it('keeps roster groups on the OS accent while user addresses follow the message bubble', () => {
    const html = renderToStaticMarkup(
      <MentionHighlightedText value="@All report back to @user" participants={[]} />
    )

    expect(html).toContain(
      'mention-highlighted-token mention-highlighted-token--group" style="color:var(--accent)"'
    )
    expect(html).toContain(
      'mention-highlighted-token mention-highlighted-token--user" style="color:var(--user-bubble-base, var(--accent))"'
    )
  })
})
