import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChatModeChangeNotice } from './ChatModeChangeNotice'
import { ChatModeChangeNotices } from '../lib/chatModeChangeNotices'

function render(notices: ChatModeChangeNotices, ...chatIds: (string | null | undefined)[]): string {
  return renderToStaticMarkup(createElement(ChatModeChangeNotice, { chatIds, notices }))
}

describe('ChatModeChangeNotice', () => {
  it('renders nothing while no switch has been refused', () => {
    expect(render(new ChatModeChangeNotices(), 'chat-1')).toBe('')
  })

  // The whole point of the component: the refusal is on screen on FIRST paint,
  // with no effect to run — ~251 renderer suites never run effects at all.
  it('renders the refusal for the focused thread', () => {
    const notices = new ChatModeChangeNotices()
    notices.raise('chat-1', 'Finish the current turn first to change chat mode.')
    const markup = render(notices, 'chat-1')
    expect(markup).toContain('Finish the current turn first to change chat mode.')
    expect(markup).toContain('role="alert"')
  })

  it('renders nothing when the notice belongs to a thread that is not on screen', () => {
    const notices = new ChatModeChangeNotices()
    notices.raise('chat-2', 'Ensemble Mode is switched off in Settings.')
    expect(render(notices, 'chat-1')).toBe('')
  })

  // A multiview pane runs the same handlers against its own chat, which is not
  // the focused one. Watching only the focused chat would make a pane refusal
  // invisible again.
  it('renders the refusal raised on a multiview pane thread', () => {
    const notices = new ChatModeChangeNotices()
    notices.raise('pane-chat', 'Ensemble Mode is switched off in Settings.')
    expect(render(notices, 'chat-1', 'pane-chat')).toContain(
      'Ensemble Mode is switched off in Settings.'
    )
  })

  it('shows the newest refusal when two on-screen threads both have one', () => {
    let clock = 0
    const notices = new ChatModeChangeNotices(() => clock)
    notices.raise('chat-1', 'Finish the current turn first to change chat mode.')
    clock = 5
    notices.raise('pane-chat', 'Ensemble Mode is switched off in Settings.')
    const markup = render(notices, 'chat-1', 'pane-chat')
    expect(markup).toContain('Ensemble Mode is switched off in Settings.')
    expect(markup).not.toContain('Finish the current turn first')
  })

  it('renders nothing when no thread is on screen', () => {
    const notices = new ChatModeChangeNotices()
    notices.raise('chat-1', 'Ensemble Mode is switched off in Settings.')
    expect(render(notices, null)).toBe('')
  })

  it('offers a dismiss control', () => {
    const notices = new ChatModeChangeNotices()
    notices.raise('chat-1', 'Ensemble Mode is switched off in Settings.')
    expect(render(notices, 'chat-1')).toContain('aria-label="Dismiss chat mode message"')
  })
})
