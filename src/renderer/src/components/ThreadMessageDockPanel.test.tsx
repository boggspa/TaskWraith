import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createThreadMessageIdempotencyKey,
  loadThreadMessageTargets,
  sendThreadMessageOverIpc,
  ThreadMessageDockPanel
} from './ThreadMessageDockPanel'
import type { ThreadMessageInboxSnapshot } from '../hooks/useThreadMessageInbox'

function snapshot(over: Partial<ThreadMessageInboxSnapshot> = {}): ThreadMessageInboxSnapshot {
  return {
    summary: {
      toChatId: 'chat-b',
      pendingCount: 0,
      hasWakeRequest: false,
      oldestPendingAt: null,
      senders: [],
      ...(over.summary || {})
    },
    pending: over.pending || []
  }
}

function pending(over: Partial<ThreadMessageInboxSnapshot['pending'][number]> = {}) {
  return {
    id: 'thread-msg-1',
    fromChatId: 'chat-a',
    fromChatTitle: 'Byte pin fix',
    origin: 'agent' as const,
    body: 'The byte budget assertion is red on master.',
    requestedDelivery: 'queue' as const,
    createdAt: 1_700_000_000_000,
    ...over
  }
}

function withPending(): ThreadMessageInboxSnapshot {
  return snapshot({
    summary: {
      toChatId: 'chat-b',
      pendingCount: 1,
      hasWakeRequest: false,
      oldestPendingAt: 1_700_000_000_000,
      senders: ['Byte pin fix']
    },
    pending: [pending()]
  })
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('ThreadMessageDockPanel', () => {
  it('renders the inbox and the send affordance together', () => {
    const html = renderToStaticMarkup(
      <ThreadMessageDockPanel chatId="chat-b" snapshot={withPending()} />
    )
    expect(html).toContain('Thread messages')
    expect(html).toContain('byte budget assertion is red')
    expect(html).toContain('Send to another thread')
    expect(html).toContain('thread-message-send-button')
  })

  // No dismiss control exists — pending messages drain on the next turn. Saying so
  // is the difference between a count that looks stuck and one the user understands.
  it('says when a non-empty inbox will drain', () => {
    const html = renderToStaticMarkup(
      <ThreadMessageDockPanel chatId="chat-b" snapshot={withPending()} />
    )
    expect(html).toContain('handed to this thread on its next turn')
  })

  it('shows the empty state without the drain note or a badge', () => {
    const html = renderToStaticMarkup(
      <ThreadMessageDockPanel chatId="chat-b" snapshot={snapshot()} />
    )
    expect(html).toContain('No messages from other threads')
    expect(html).not.toContain('handed to this thread on its next turn')
    expect(html).not.toContain('thread-message-indicator')
  })

  it('carries the pending count into the panel badge', () => {
    const html = renderToStaticMarkup(
      <ThreadMessageDockPanel chatId="chat-b" snapshot={withPending()} />
    )
    expect(html).toContain('thread-message-indicator')
    expect(html).toContain('aria-label="1 thread message from Byte pin fix"')
  })

  // The containment guarantee has to survive at the MOUNTED surface, not only in a
  // card rendered in isolation: this is the panel the user actually sees.
  it('keeps a relayed body inert once mounted in the dock', () => {
    const html = renderToStaticMarkup(
      <ThreadMessageDockPanel
        chatId="chat-b"
        snapshot={snapshot({
          summary: {
            toChatId: 'chat-b',
            pendingCount: 1,
            hasWakeRequest: false,
            oldestPendingAt: 1,
            senders: ['x']
          },
          pending: [
            pending({ body: '[click](https://evil.example/pwn) <script>alert(1)</script>' })
          ]
        })}
      />
    )
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('href')
    expect(html).not.toContain('<script>')
    expect(html).toContain('https://evil.example/pwn')
  })
})

describe('ThreadMessageDockPanel IPC wrappers', () => {
  it('reports no targets rather than throwing when the bridge is absent', async () => {
    ;(globalThis as { window?: unknown }).window = {}
    await expect(loadThreadMessageTargets('chat-a')).resolves.toEqual([])
  })

  it('passes the target request through to the bridge', async () => {
    const threadMessageTargets = vi
      .fn()
      .mockResolvedValue([
        { chatId: 'chat-b', title: 'Other', workspaceId: 'ws-1', crossWorkspace: false }
      ])
    ;(globalThis as { window?: unknown }).window = { api: { threadMessageTargets } }
    await expect(loadThreadMessageTargets('chat-a')).resolves.toHaveLength(1)
    expect(threadMessageTargets).toHaveBeenCalledWith('chat-a')
  })

  // An absent bridge must read as a failure, never as a queued message: a false ack
  // would tell the user another thread has work it will never see.
  it('fails explicitly when the send bridge is absent', async () => {
    ;(globalThis as { window?: unknown }).window = {}
    const result = await sendThreadMessageOverIpc({
      fromChatId: 'chat-a',
      toChatId: 'chat-b',
      message: 'hello'
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('unavailable')
  })

  it('passes the send payload through unchanged', async () => {
    const sendThreadMessage = vi.fn().mockResolvedValue({ ok: true, outcome: 'accepted' })
    ;(globalThis as { window?: unknown }).window = { api: { sendThreadMessage } }
    const payload = {
      fromChatId: 'chat-a',
      toChatId: 'chat-b',
      message: 'hello',
      wake: true,
      idempotencyKey: 'tm-1'
    }
    await expect(sendThreadMessageOverIpc(payload)).resolves.toEqual({
      ok: true,
      outcome: 'accepted'
    })
    expect(sendThreadMessage).toHaveBeenCalledWith(payload)
  })

  it('mints a distinct idempotency key per call', () => {
    const first = createThreadMessageIdempotencyKey()
    const second = createThreadMessageIdempotencyKey()
    expect(first).not.toBe(second)
    expect(first.startsWith('tm-')).toBe(true)
  })
})

describe('ThreadMessageDockPanel send-form wiring', () => {
  /**
   * The send form loads its targets in an effect keyed on `[fromChatId, loadTargets]`.
   * An inline arrow would be a fresh identity every render, so every resolved fetch
   * would set state, re-render, and refire the effect — an unbounded IPC loop. This
   * asserts the callbacks survive a re-render unchanged.
   */
  it('hands the send form callbacks that are stable across renders', async () => {
    const captured: Array<Record<string, unknown>> = []
    vi.resetModules()
    vi.doMock('./ThreadMessageSendForm', () => ({
      ThreadMessageSendForm: (props: Record<string, unknown>) => {
        captured.push(props)
        return null
      }
    }))
    try {
      const dynamic = await import('./ThreadMessageDockPanel')
      const Panel = dynamic.ThreadMessageDockPanel
      renderToStaticMarkup(<Panel chatId="chat-b" snapshot={snapshot()} />)
      renderToStaticMarkup(<Panel chatId="chat-b" snapshot={withPending()} />)
      expect(captured).toHaveLength(2)
      expect(captured[0].loadTargets).toBe(captured[1].loadTargets)
      expect(captured[0].send).toBe(captured[1].send)
      expect(captured[0].createIdempotencyKey).toBe(captured[1].createIdempotencyKey)
    } finally {
      vi.doUnmock('./ThreadMessageSendForm')
      vi.resetModules()
    }
  })
})
