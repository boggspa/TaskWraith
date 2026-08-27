import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { TranscriptJumpToLatestPill } from './TranscriptJumpToLatestPill'

describe('TranscriptJumpToLatestPill', () => {
  it('renders nothing while the transcript still owns auto-follow', () => {
    expect(
      renderToStaticMarkup(
        <TranscriptJumpToLatestPill
          visible={false}
          unreadCount={3}
          provider="codex"
          onJumpToLatest={() => {}}
        />
      )
    ).toBe('')
  })

  it('labels a streaming response when no new message bubble has landed', () => {
    const html = renderToStaticMarkup(
      <TranscriptJumpToLatestPill
        visible
        unreadCount={0}
        provider="claude"
        onJumpToLatest={() => {}}
      />
    )

    expect(html).toContain('transcript-jump-to-latest-pill provider-claude')
    expect(html).toContain('aria-label="Jump to latest — response streaming below"')
    expect(html).toContain('Jump to latest')
  })

  it('hands the click back to the owning transcript scroll state', () => {
    const onJumpToLatest = vi.fn()
    const pill = TranscriptJumpToLatestPill({
      visible: true,
      unreadCount: 0,
      provider: 'codex',
      onJumpToLatest
    })

    pill?.props.onClick()

    expect(onJumpToLatest).toHaveBeenCalledOnce()
  })

  it('renders the pane-local unread count with singular and plural labels', () => {
    const singular = renderToStaticMarkup(
      <TranscriptJumpToLatestPill
        visible
        unreadCount={1}
        provider="gemini"
        onJumpToLatest={() => {}}
      />
    )
    const plural = renderToStaticMarkup(
      <TranscriptJumpToLatestPill
        visible
        unreadCount={12}
        provider="kimi"
        onJumpToLatest={() => {}}
      />
    )

    expect(singular).toContain('aria-label="Jump to latest — 1 new message"')
    expect(singular).toContain('<span class="sr-only">1 new message</span>')
    expect(plural).toContain('aria-label="Jump to latest — 12 new messages"')
    expect(plural).toContain('<span class="sr-only">12 new messages</span>')
  })
})
