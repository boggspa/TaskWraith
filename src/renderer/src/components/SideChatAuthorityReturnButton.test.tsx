import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { findClickableByClassName } from '../test/reactElementTree'
import { SideChatAuthorityReturnButton } from './SideChatAuthorityReturnButton'

describe('SideChatAuthorityReturnButton', () => {
  it('presents the default-off non-interrupting contract', () => {
    const html = renderToStaticMarkup(
      <SideChatAuthorityReturnButton enabled={false} onToggle={() => {}} />
    )

    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('active parent runs are never interrupted')
    expect(html).not.toContain('side-chat-return-toggle active')
  })

  it('shows the durable authority-inbox opt-in and invokes its toggle', () => {
    const onToggle = vi.fn()
    const tree = SideChatAuthorityReturnButton({ enabled: true, onToggle })
    const html = renderToStaticMarkup(tree)

    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('side-chat-return-toggle active')
    expect(html).toContain('parent authority inbox')
    findClickableByClassName(tree, 'side-chat-return-toggle').props.onClick?.()
    expect(onToggle).toHaveBeenCalledOnce()
  })
})
