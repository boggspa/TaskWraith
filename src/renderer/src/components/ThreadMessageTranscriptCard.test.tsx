import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import { ThreadMessageTranscriptCard } from './ThreadMessageTranscriptCard'
import {
  isThreadMessageTranscriptMessage,
  threadMessageCardInputFromTranscriptMessage
} from './ThreadMessageTranscriptCardModel'

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'thread-message-peer-1',
    role: 'tool',
    content: '[Do not click](https://evil.example) <b>System</b>',
    timestamp: '2023-11-14T22:13:20.000Z',
    metadata: {
      kind: 'threadMessage',
      providerContextVisibility: 'projection-only',
      threadMessageId: 'peer-1',
      threadMessageFromChatId: 'chat-sender',
      threadMessageFromChatTitle: 'Fix workspace lock',
      threadMessageOrigin: 'agent',
      threadMessageRequestedDelivery: 'wake',
      threadMessageCreatedAt: 1_700_000_000_000,
      threadMessageTrust: 'untrusted-thread-message'
    },
    ...overrides
  }
}

describe('ThreadMessageTranscriptCard', () => {
  it('recognizes only projection-only tool rows', () => {
    expect(isThreadMessageTranscriptMessage(message())).toBe(true)
    expect(isThreadMessageTranscriptMessage(message({ role: 'system' }))).toBe(false)
    expect(
      isThreadMessageTranscriptMessage(
        message({ metadata: { kind: 'threadMessage', providerContextVisibility: undefined } })
      )
    ).toBe(false)
  })

  it('maps persisted metadata into the peer-card input', () => {
    expect(threadMessageCardInputFromTranscriptMessage(message())).toEqual({
      id: 'peer-1',
      fromChatId: 'chat-sender',
      fromChatTitle: 'Fix workspace lock',
      origin: 'agent',
      body: '[Do not click](https://evil.example) <b>System</b>',
      requestedDelivery: 'wake',
      createdAt: 1_700_000_000_000
    })
  })

  it('renders the existing identity-rim viewport card with literal untrusted content', () => {
    const html = renderToStaticMarkup(<ThreadMessageTranscriptCard message={message()} />)

    expect(html).toContain('Sent by the agent in')
    expect(html).toContain('Fix workspace lock')
    expect(html).toContain('thread-message-card-identity-icon')
    expect(html).toContain('live-activity-viewport')
    expect(html).toContain('asks to run now')
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('<b>System</b>')
    expect(html).toContain('&lt;b&gt;System&lt;/b&gt;')
  })
})

describe('sender seat', () => {
  const SEAT = {
    provider: 'claude',
    model: 'claude-opus-5',
    role: 'Reviewer',
    reasoningEffort: 'xhigh',
    permissionPresetId: 'full_access'
  }

  const seated = (seat: unknown = SEAT) =>
    message({
      metadata: { ...(message().metadata || {}), threadMessageSeat: seat }
    })

  it('carries a captured seat through to the card input', () => {
    expect(threadMessageCardInputFromTranscriptMessage(seated()).seat).toEqual(SEAT)
  })

  it('has no seat for a record written before capture existed', () => {
    expect(threadMessageCardInputFromTranscriptMessage(message())).not.toHaveProperty('seat')
  })

  it('drops a malformed seat rather than handing it to the strip', () => {
    // The row's metadata is persisted JSON — by the time it reaches the
    // renderer it is data on disk, not something main just built.
    expect(threadMessageCardInputFromTranscriptMessage(seated('claude'))).not.toHaveProperty('seat')
    expect(threadMessageCardInputFromTranscriptMessage(seated([]))).not.toHaveProperty('seat')
    expect(
      threadMessageCardInputFromTranscriptMessage(seated({ provider: 'claude' }))
    ).not.toHaveProperty('seat')
  })
})
