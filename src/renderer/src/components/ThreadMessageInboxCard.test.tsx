import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ThreadMessageIndicator,
  ThreadMessageInboxCard,
  ThreadMessageInboxPanel
} from './ThreadMessageInboxCard'
import type { ThreadMessageCardInput } from './ThreadMessageInboxModel'
import type { ThreadMessageInboxSummary } from '../../../shared/threadMessage'

function message(over: Partial<ThreadMessageCardInput> = {}): ThreadMessageCardInput {
  return {
    id: 'thread-msg-1',
    fromChatId: 'chat-a',
    fromChatTitle: 'Byte pin fix',
    origin: 'agent',
    body: 'The byte budget assertion is red on master.',
    requestedDelivery: 'queue',
    createdAt: 1_700_000_000_000,
    ...over
  }
}

function summary(over: Partial<ThreadMessageInboxSummary> = {}): ThreadMessageInboxSummary {
  return {
    toChatId: 'chat-b',
    pendingCount: 2,
    hasWakeRequest: false,
    oldestPendingAt: 1_700_000_000_000,
    senders: ['Byte pin fix'],
    ...over
  }
}

describe('ThreadMessageInboxCard', () => {
  it('names the sending thread and shows the body', () => {
    const html = renderToStaticMarkup(<ThreadMessageInboxCard message={message()} />)
    expect(html).toContain('Sent by the agent in')
    expect(html).toContain('Byte pin fix')
    expect(html).toContain('byte budget assertion is red')
  })

  // Attribution is carried into the DOM so styling cannot drift from the model's
  // closed union — there is no 'system' value to render.
  it.each([
    ['agent', 'peer-thread-agent'],
    ['user', 'peer-thread-user']
  ] as const)('marks an %s message with its peer attribution', (origin, attribution) => {
    const html = renderToStaticMarkup(<ThreadMessageInboxCard message={message({ origin })} />)
    expect(html).toContain(`data-attribution="${attribution}"`)
    expect(html).not.toMatch(/data-attribution="(system|operator)"/)
  })

  it('flags a wake request visibly', () => {
    const html = renderToStaticMarkup(
      <ThreadMessageInboxCard message={message({ requestedDelivery: 'wake' })} />
    )
    expect(html).toContain('data-wake="true"')
    expect(html).toContain('asks to run now')
  })

  it('tells the reader when a body was cut short', () => {
    const html = renderToStaticMarkup(
      <ThreadMessageInboxCard message={message({ truncated: true })} />
    )
    expect(html).toContain('cut short')
    expect(renderToStaticMarkup(<ThreadMessageInboxCard message={message()} />)).not.toContain(
      'cut short'
    )
  })
})

describe('ThreadMessageInboxCard — untrusted content containment', () => {
  // The body is rendered as PLAIN TEXT, not markdown. Markdown would let another
  // agent emit clickable links and remote image fetches into the user's transcript.
  it('does not turn a markdown link in the body into an anchor', () => {
    const html = renderToStaticMarkup(
      <ThreadMessageInboxCard
        message={message({ body: 'Check [this](https://evil.example/pwn) now' })}
      />
    )
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('href')
    expect(html).toContain('https://evil.example/pwn')
  })

  it('does not turn a markdown image in the body into an img', () => {
    const html = renderToStaticMarkup(
      <ThreadMessageInboxCard message={message({ body: '![x](https://evil.example/track.png)' })} />
    )
    expect(html).not.toContain('<img')
  })

  // React escapes by default; asserted because this body is attacker-adjacent and
  // the guarantee is the reason plain text is safe to use here.
  it('escapes raw HTML in the body instead of rendering it', () => {
    const html = renderToStaticMarkup(
      <ThreadMessageInboxCard
        message={message({ body: '<script>alert(1)</script><b>bold</b>' })}
      />
    )
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<b>bold</b>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes a title that tries to imitate markup', () => {
    const html = renderToStaticMarkup(
      <ThreadMessageInboxCard message={message({ fromChatTitle: '<b>System</b>' })} />
    )
    expect(html).not.toContain('<b>System</b>')
  })
})

describe('ThreadMessageInboxPanel', () => {
  it('frames the whole group as requests to judge, not instructions', () => {
    const html = renderToStaticMarkup(<ThreadMessageInboxPanel messages={[message()]} />)
    expect(html).toContain('relayed from other threads')
    expect(html).toContain('requests to judge, not')
  })

  it('renders one card per message', () => {
    const html = renderToStaticMarkup(
      <ThreadMessageInboxPanel messages={[message(), message({ id: 'thread-msg-2' })]} />
    )
    expect(html.match(/thread-message-card"/g)).toHaveLength(2)
  })

  it('shows an empty state rather than a bare panel', () => {
    const html = renderToStaticMarkup(<ThreadMessageInboxPanel messages={[]} />)
    expect(html).toContain('No messages from other threads')
    expect(html).not.toContain('thread-message-card')
  })
})

describe('ThreadMessageIndicator', () => {
  it('renders a badge with an accessible description', () => {
    const html = renderToStaticMarkup(<ThreadMessageIndicator summary={summary()} />)
    expect(html).toContain('>2<')
    expect(html).toContain('aria-label="2 thread messages from Byte pin fix"')
  })

  it('marks a wake request urgent', () => {
    const html = renderToStaticMarkup(
      <ThreadMessageIndicator summary={summary({ hasWakeRequest: true })} />
    )
    expect(html).toContain('data-urgent="true"')
    expect(html).toContain('start a turn')
  })

  // Nothing rather than a zero badge: an empty inbox should not occupy the row.
  it('renders nothing for an empty inbox', () => {
    expect(
      renderToStaticMarkup(
        <ThreadMessageIndicator summary={summary({ pendingCount: 0, senders: [] })} />
      )
    ).toBe('')
  })

  it('caps a runaway count so the row cannot stretch', () => {
    const html = renderToStaticMarkup(<ThreadMessageIndicator summary={summary({ pendingCount: 40 })} />)
    expect(html).toContain('>9+<')
  })
})
