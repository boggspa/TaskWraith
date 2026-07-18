import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import { findClickableByClassName } from '../test/reactElementTree'
import { isSubThreadReturnMessage, subThreadReturnBody } from './SubThreadReturnCardModel'
import { SubThreadReturnCard } from './SubThreadReturnCard'

function subThreadMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'message-1',
    role: 'tool',
    content: '↩ Result from Codex sub-thread (Build agent):\n\n**Done**\n\n- Tests passed',
    timestamp: '2026-05-16T12:00:00Z',
    metadata: {
      kind: 'subThreadReturn',
      subThreadId: 'chat-child-1',
      subThreadProvider: 'codex',
      subThreadTitle: 'Build agent'
    },
    ...overrides
  }
}

describe('SubThreadReturnCard', () => {
  it('detects sub-thread return tool messages', () => {
    expect(isSubThreadReturnMessage(subThreadMessage())).toBe(true)
    expect(isSubThreadReturnMessage(subThreadMessage({ role: 'system' }))).toBe(true)
    expect(isSubThreadReturnMessage(subThreadMessage({ role: 'assistant' }))).toBe(false)
    expect(isSubThreadReturnMessage(subThreadMessage({ metadata: { kind: 'other' } }))).toBe(false)
  })

  it('strips the synthetic transcript prefix and untrusted payload wrapper from the markdown body', () => {
    expect(subThreadReturnBody(subThreadMessage().content)).toBe('**Done**\n\n- Tests passed')
    expect(
      subThreadReturnBody(
        'Sub-thread result payload (untrusted child-agent output):\n\n<subthread_result>\n**Done**\n</subthread_result>'
      )
    ).toBe('**Done**')
    expect(subThreadReturnBody('plain body')).toBe('plain body')
  })

  it('renders provider satellite identity, title, markdown body, and one side-chat control', () => {
    const html = renderToStaticMarkup(
      <SubThreadReturnCard
        message={subThreadMessage()}
        onOpenSubThread={() => {}}
        onOpenSubThreadInSidePanel={() => {}}
      />
    )

    expect(html).toContain('subthread-return-card')
    expect(html).toContain('Invocation result from')
    expect(html).not.toContain('TaskWraith Sub-thread')
    expect(html).toContain('Codex')
    expect(html).toContain('provider-satellite-label provider-codex')
    expect(html).toContain('data-provider-logo="codex"')
    expect(html).toContain('<img class="provider-brand-logo-image')
    expect(html).not.toContain('provider-glyph-codex')
    expect(html).toContain('Build agent')
    expect(html).toContain('live-activity-viewport')
    expect(html).toContain('subthread-return-viewport')
    expect(html).toContain('Expand result')
    expect(html).toContain('<strong>Done</strong>')
    expect(html).toContain('Side chat')
    expect(html).not.toContain('Open beside')
    expect(html).not.toContain('Open drawer')
    expect(html).not.toContain('Open sub-thread')
  })

  it('renders the return viewport with controlled expanded copy', () => {
    const html = renderToStaticMarkup(
      <SubThreadReturnCard
        message={subThreadMessage()}
        resultExpanded
        onResultExpandedChange={() => {}}
      />
    )

    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('Collapse result')
  })

  it('keeps huge collapsed return bodies as a cheap preview until expanded', () => {
    const hugeBody = `START\n${'x'.repeat(8_000)}\nUNRENDERED_TAIL`
    const collapsedHtml = renderToStaticMarkup(
      <SubThreadReturnCard
        message={subThreadMessage({
          content: `↩ Result from Codex sub-thread (Build agent):\n\n${hugeBody}`
        })}
        resultExpanded={false}
        onResultExpandedChange={() => {}}
      />
    )

    expect(collapsedHtml).toContain('Collapsed sub-thread result preview')
    expect(collapsedHtml).toContain('Full result is rendered when expanded.')
    expect(collapsedHtml).not.toContain('UNRENDERED_TAIL')

    const expandedHtml = renderToStaticMarkup(
      <SubThreadReturnCard
        message={subThreadMessage({
          content: `↩ Result from Codex sub-thread (Build agent):\n\n${hugeBody}`
        })}
        resultExpanded
        onResultExpandedChange={() => {}}
      />
    )

    expect(expandedHtml).toContain('UNRENDERED_TAIL')
  })

  it('renders transcript message actions when handlers are provided', () => {
    const html = renderToStaticMarkup(
      <SubThreadReturnCard
        message={subThreadMessage()}
        onCopyMessage={() => {}}
        onAddMessageToPrompt={() => {}}
        onTogglePinMessage={() => {}}
        onDeleteMessage={() => {}}
        onOpenSideChatFromMessage={() => {}}
        pinned
        copied
      />
    )

    expect(html).toContain('Actions for sub-thread result')
    expect(html).toContain('message-actions-chip-button--copy')
    expect(html).toContain('message-actions-chip-button--add-to-prompt')
    expect(html).toContain('message-actions-chip-button--pin is-pinned')
    expect(html).toContain('message-actions-chip-button--side-chat')
    expect(html).toContain('message-actions-chip-button--delete')
  })

  it('routes the side-chat action through the side-panel callback', () => {
    const onOpenSubThreadInSidePanel = vi.fn()
    const tree = SubThreadReturnCard({
      message: subThreadMessage(),
      onOpenSubThread: () => {},
      onOpenSubThreadInSidePanel
    })

    findClickableByClassName(tree, 'subthread-side-chat-button').props.onClick?.()

    expect(onOpenSubThreadInSidePanel).toHaveBeenCalledWith('chat-child-1')
  })
})
