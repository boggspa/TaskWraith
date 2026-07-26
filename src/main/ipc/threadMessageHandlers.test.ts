import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { ChatRecord } from '../store/types'
import {
  registerThreadMessageHandlers,
  type ThreadMessageIpcHandlersDeps
} from './threadMessageHandlers'
import { emptyThreadMessageInbox, type ThreadMessageEvent } from '../../shared/threadMessage'
import { ipcChannelRequiresMainRenderer } from '../RendererIpcPolicy'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

function chat(appChatId: string, workspaceId: string | null, title: string): ChatRecord {
  return {
    appChatId,
    scope: workspaceId ? 'workspace' : 'global',
    chatKind: 'single',
    provider: 'claude',
    title,
    workspaceId: workspaceId ?? undefined,
    workspacePath: workspaceId ? '/repo' : undefined,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: []
  } as unknown as ChatRecord
}

const CHATS = [
  chat('chat-a', 'ws-1', 'Provider ToS audit'),
  chat('chat-b', 'ws-1', 'Byte pin fix'),
  chat('chat-far', 'ws-2', 'Other workspace')
]

function harness(overrides: Partial<ThreadMessageIpcHandlersDeps> = {}) {
  const enqueued: ThreadMessageEvent[] = []
  const broadcasts: string[] = []
  const scopeChecks: string[] = []
  const deps: ThreadMessageIpcHandlersDeps = {
    isMainRendererSender: () => true,
    assertSenderChatScope: (_event, chatId) => {
      scopeChecks.push(chatId)
    },
    getChat: (id) => CHATS.find((c) => c.appChatId === id) ?? null,
    listChats: () => CHATS,
    getThreadMessageInbox: (chatId) => emptyThreadMessageInbox(chatId),
    enqueueThreadMessage: (event) => {
      enqueued.push(event)
      return { outcome: 'accepted' as const }
    },
    resolveServicePolicy: () => 'ask',
    mintThreadMessageId: (from, to, nonce) => `thread-msg-${from}-${to}-${nonce}`,
    now: () => 1_700_000_000_000,
    broadcastThreadMessageInboxChanged: (chatId) => broadcasts.push(chatId),
    ...overrides
  }
  registerThreadMessageHandlers(deps)
  const handler = (channel: string) => {
    const fn = mockedHandle.mock.calls.find(([name]) => name === channel)?.[1]
    if (typeof fn !== 'function') throw new Error(`${channel} was not registered`)
    return fn as (event: unknown, payload?: unknown) => unknown
  }
  return { handler, enqueued, broadcasts, scopeChecks }
}

const EVENT = {} as unknown

describe('thread-message:send', () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    fromChatId: 'chat-a',
    toChatId: 'chat-b',
    message: 'The byte pin is red on master.',
    ...over
  })

  it('sends as the user and marks the message user-authored', () => {
    const h = harness()
    const result = h.handler('thread-message:send')(EVENT, payload()) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(h.enqueued).toHaveLength(1)
    expect(h.enqueued[0].origin).toBe('user')
    expect(h.enqueued[0].trust).toBe('untrusted-thread-message')
    expect(h.enqueued[0].fromChatTitle).toBe('Provider ToS audit')
    expect(h.broadcasts).toEqual(['chat-b'])
  })

  // The whole reason this path may skip the prompt: the human composed it. So the
  // claim that a human did must be proven, not accepted.
  it('refuses a send that is not from the main renderer', () => {
    const h = harness({ isMainRendererSender: () => false })
    expect(() => h.handler('thread-message:send')(EVENT, payload())).toThrow(/main renderer/i)
    expect(h.enqueued).toHaveLength(0)
  })

  it('scope-checks the SENDING chat, so a renderer cannot send as a chat it does not own', () => {
    const h = harness({
      assertSenderChatScope: (_event, chatId) => {
        if (chatId === 'chat-a') throw new Error('not your chat')
      }
    })
    expect(() => h.handler('thread-message:send')(EVENT, payload())).toThrow(/not your chat/)
    expect(h.enqueued).toHaveLength(0)
  })

  // A global policy deny is the user's own kill switch and outranks the UI.
  it('honours a policy deny even for a user-composed send', () => {
    const h = harness({ resolveServicePolicy: () => 'deny' })
    const result = h.handler('thread-message:send')(EVENT, payload()) as {
      ok: boolean
      error?: string
    }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/disabled/i)
    expect(h.enqueued).toHaveLength(0)
  })

  // A user send needs no approval for these, unlike an agent send: the human is
  // the authority for their own message.
  it.each([
    ['cross-workspace', { toChatId: 'chat-far' }],
    ['a wake request', { wake: true }],
    ['cross-workspace with wake', { toChatId: 'chat-far', wake: true }]
  ])('sends %s without a prompt', (_label, over) => {
    const h = harness()
    const result = h.handler('thread-message:send')(EVENT, payload(over)) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(h.enqueued).toHaveLength(1)
  })

  it('records a wake request when asked and queue otherwise', () => {
    const h = harness()
    h.handler('thread-message:send')(EVENT, payload({ wake: true }))
    h.handler('thread-message:send')(EVENT, payload({ idempotencyKey: 'k2' }))
    expect(h.enqueued.map((e) => e.requestedDelivery)).toEqual(['wake', 'queue'])
  })

  it.each([
    ['no sender', { fromChatId: undefined }],
    ['no target', { toChatId: undefined }],
    ['an empty message', { message: '   ' }]
  ])('rejects %s without enqueueing', (_label, over) => {
    const h = harness()
    const result = h.handler('thread-message:send')(EVENT, payload(over)) as { ok: boolean }
    expect(result.ok).toBe(false)
    expect(h.enqueued).toHaveLength(0)
  })

  it('reports a vanished target rather than queueing an undeliverable message', () => {
    const h = harness()
    const result = h.handler('thread-message:send')(EVENT, payload({ toChatId: 'chat-gone' })) as {
      ok: boolean
      outcome?: string
    }
    expect(result.ok).toBe(false)
    expect(result.outcome).toBe('unknown-target')
    expect(h.enqueued).toHaveLength(0)
  })

  it('is idempotent on an explicit key', () => {
    const h = harness()
    h.handler('thread-message:send')(EVENT, payload({ idempotencyKey: 'k1' }))
    h.handler('thread-message:send')(EVENT, payload({ idempotencyKey: 'k1' }))
    expect(h.enqueued[0].id).toBe(h.enqueued[1].id)
  })

  it('does not announce an inbox change when the enqueue was refused', () => {
    const h = harness({ enqueueThreadMessage: () => ({ outcome: 'inbox-full' as const }) })
    const result = h.handler('thread-message:send')(EVENT, payload()) as { ok: boolean }
    expect(result.ok).toBe(false)
    expect(h.broadcasts).toEqual([])
  })
})

describe('thread-message:targets', () => {
  it('lists addressable threads, excluding the sender, and flags cross-workspace', () => {
    const h = harness()
    const targets = h.handler('thread-message:targets')(EVENT, 'chat-a') as Array<{
      chatId: string
      crossWorkspace: boolean
    }>
    expect(targets.map((t) => t.chatId)).toEqual(['chat-b', 'chat-far'])
    expect(targets.find((t) => t.chatId === 'chat-b')?.crossWorkspace).toBe(false)
    // Flagged up front so the UI can warn before the send rather than letting the
    // user discover it from an approval prompt.
    expect(targets.find((t) => t.chatId === 'chat-far')?.crossWorkspace).toBe(true)
  })

  it('scope-checks the requesting chat', () => {
    const h = harness()
    h.handler('thread-message:targets')(EVENT, 'chat-a')
    expect(h.scopeChecks).toContain('chat-a')
  })

  it('requires a chat id', () => {
    const h = harness()
    expect(() => h.handler('thread-message:targets')(EVENT, '')).toThrow(/required/i)
  })
})

describe('thread-message:inbox', () => {
  it('returns a summary plus undelivered messages', () => {
    const h = harness()
    const result = h.handler('thread-message:inbox')(EVENT, 'chat-b') as {
      summary: { pendingCount: number; toChatId: string }
      pending: unknown[]
    }
    expect(result.summary.toChatId).toBe('chat-b')
    expect(result.summary.pendingCount).toBe(0)
    expect(result.pending).toEqual([])
  })

  // An inbox holds prose another agent wrote. That is the user's data, so no
  // renderer should be able to enumerate a chat it does not own.
  it('scope-checks the chat being read', () => {
    const h = harness({
      assertSenderChatScope: (_event, chatId) => {
        if (chatId === 'chat-b') throw new Error('not your chat')
      }
    })
    expect(() => h.handler('thread-message:inbox')(EVENT, 'chat-b')).toThrow(/not your chat/)
  })

  it('requires a chat id', () => {
    const h = harness()
    expect(() => h.handler('thread-message:inbox')(EVENT, undefined)).toThrow(/required/i)
  })
})

describe('channel registration', () => {
  // These channels are main-renderer-only by the allowlist's fail-closed default
  // (ipcChannelRequiresMainRenderer treats anything unlisted as main-only). If one
  // is ever added to SECONDARY_RENDERER_SAFE_IPC_CHANNELS, the explicit
  // isMainRendererSender check on send is what still holds.
  it('registers exactly the three thread-message channels', () => {
    harness()
    const names = mockedHandle.mock.calls.map(([name]) => name)
    expect(names).toEqual([
      'thread-message:targets',
      'thread-message:inbox',
      'thread-message:send'
    ])
  })

  // Asserted rather than assumed: the send path carries `origin: 'user'`, which the
  // gate lets through unprompted, so a secondary renderer must not be able to reach
  // any of these. This holds today because unlisted channels fail closed; the test
  // is what catches someone adding them to the secondary-safe list.
  it.each([
    'thread-message:targets',
    'thread-message:inbox',
    'thread-message:send'
  ])('keeps %s main-renderer-only', (channel) => {
    expect(ipcChannelRequiresMainRenderer(channel)).toBe(true)
  })
})
