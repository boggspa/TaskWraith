import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { AppStore, HistoryDeletionMutationBlockedError } from './store'
import type { ChatRecord } from './store/types'
import {
  createThreadMessageEvent,
  THREAD_MESSAGE_TRANSCRIPT_KIND,
  type ThreadMessageEvent
} from '../shared/threadMessage'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-thread-messages-test-${process.pid}`)

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

const ledgerPath = join(userDataPath, 'thread-messages.json')

function saveChat(appChatId: string, workspaceId = 'ws-1'): void {
  AppStore.saveChat({
    appChatId,
    scope: 'workspace',
    chatKind: 'single',
    provider: 'claude',
    title: `Chat ${appChatId}`,
    workspaceId,
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: []
  } as ChatRecord)
}

function message(overrides: Partial<Parameters<typeof createThreadMessageEvent>[0]> = {}) {
  const event = createThreadMessageEvent({
    id: 'msg-1',
    fromChatId: 'chat-a',
    fromChatTitle: 'Sender',
    toChatId: 'chat-b',
    origin: 'agent',
    body: 'Byte budget assertion is red on master.',
    createdAt: 1_700_000_000_000,
    ...overrides
  })
  if (!event) throw new Error('test fixture built an unroutable message')
  return event
}

function send(event: ThreadMessageEvent = message()) {
  return AppStore.enqueueThreadMessage(event)
}

describe('AppStore thread message inbox', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(userDataPath, { recursive: true })
    AppStore.resetTransientDeletionGuardsForTests()
    saveChat('chat-a')
    saveChat('chat-b')
  })

  it('keeps delivery in its own ledger and projects the inbound message into the transcript', () => {
    expect(send().outcome).toBe('accepted')

    expect(AppStore.getThreadMessageInbox('chat-b').pending.map((event) => event.id)).toEqual([
      'msg-1'
    ])
    expect(fs.existsSync(ledgerPath)).toBe(true)
    const projections = AppStore.getChat('chat-b')?.messages.filter(
      (entry) => entry.metadata?.kind === THREAD_MESSAGE_TRANSCRIPT_KIND
    )
    expect(projections).toHaveLength(1)
    expect(projections?.[0]).toMatchObject({
      id: 'thread-message-msg-1',
      role: 'tool',
      content: 'Byte budget assertion is red on master.',
      metadata: {
        providerContextVisibility: 'projection-only',
        threadMessageId: 'msg-1',
        threadMessageFromChatTitle: 'Sender',
        threadMessageTrust: 'untrusted-thread-message'
      }
    })
  })

  it('survives a stale renderer save of the receiving chat', () => {
    send()
    saveChat('chat-b')
    expect(AppStore.getThreadMessageInbox('chat-b').pending).toHaveLength(1)
    expect(
      AppStore.getChat('chat-b')?.messages.filter(
        (entry) => entry.metadata?.kind === THREAD_MESSAGE_TRANSCRIPT_KIND
      )
    ).toHaveLength(1)
  })

  it('allows a current renderer revision to delete the transcript projection', () => {
    send()
    const current = AppStore.getChat('chat-b')
    if (!current) throw new Error('missing recipient fixture')

    AppStore.saveChat({
      ...current,
      messages: current.messages.filter(
        (entry) => entry.metadata?.kind !== THREAD_MESSAGE_TRANSCRIPT_KIND
      )
    })

    expect(
      AppStore.getChat('chat-b')?.messages.some(
        (entry) => entry.metadata?.kind === THREAD_MESSAGE_TRANSCRIPT_KIND
      )
    ).toBe(false)
    expect(AppStore.getThreadMessageInbox('chat-b').pending).toHaveLength(1)
  })

  it('reports a refusal rather than silently dropping a repeat send', () => {
    send()
    expect(send().outcome).toBe('duplicate')
    expect(AppStore.getThreadMessageInbox('chat-b').pending).toHaveLength(1)
    expect(
      AppStore.getChat('chat-b')?.messages.filter(
        (entry) => entry.metadata?.kind === THREAD_MESSAGE_TRANSCRIPT_KIND
      )
    ).toHaveLength(1)
  })

  // A message queued for a chat that does not exist can never be delivered or
  // seen, so it must not be stored at all.
  it('refuses a message addressed to an unknown chat', () => {
    expect(send(message({ toChatId: 'chat-missing' })).outcome).toBe('unknown-target')
    expect(fs.existsSync(ledgerPath)).toBe(false)
  })

  it('acknowledges only after delivery and refuses a resend of the same id', () => {
    send()
    const acknowledged = AppStore.acknowledgeThreadMessages('chat-b', ['msg-1'])
    expect(acknowledged.acknowledgedIds).toEqual(['msg-1'])
    expect(AppStore.getThreadMessageInbox('chat-b').pending).toEqual([])
    expect(
      AppStore.getChat('chat-b')?.messages.some(
        (entry) => entry.metadata?.kind === THREAD_MESSAGE_TRANSCRIPT_KIND
      )
    ).toBe(true)
    expect(send().outcome).toBe('already-delivered')
  })

  it('lists only chats holding undelivered messages', () => {
    saveChat('chat-c')
    send()
    send(message({ id: 'msg-2', toChatId: 'chat-c' }))
    AppStore.acknowledgeThreadMessages('chat-c', ['msg-2'])
    expect(AppStore.getPendingThreadMessageInboxes().map((inbox) => inbox.toChatId)).toEqual([
      'chat-b'
    ])
  })

  it('reloads the queue from disk after a restart', () => {
    send()
    const reloaded = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'))
    expect(reloaded.inboxes['chat-b'].pending[0].body).toContain('Byte budget')
    expect(reloaded.inboxes['chat-b'].pending[0].trust).toBe('untrusted-thread-message')
  })
})

describe('AppStore thread message deletion fences', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(userDataPath, { recursive: true })
    AppStore.resetTransientDeletionGuardsForTests()
    saveChat('chat-a')
    saveChat('chat-b')
  })

  it.each([
    [
      'enqueue',
      () => {
        send()
      }
    ],
    [
      'acknowledgement',
      () => {
        AppStore.acknowledgeThreadMessages('chat-b', ['msg-1'])
      }
    ]
  ])('blocks %s while a deletion of the recipient is prepared', (_label, mutate) => {
    send()
    AppStore.prepareHistoryDeletion({ kind: 'chat', rootChatId: 'chat-b' })
    expect(mutate).toThrow(HistoryDeletionMutationBlockedError)
  })

  it('removes the inbox when the recipient chat is deleted', () => {
    send()
    AppStore.deleteChat('chat-b')
    expect(AppStore.getThreadMessageInbox('chat-b').pending).toEqual([])
  })

  // The sender's deletion must take its queued messages with it: they are that
  // chat's content, and they would otherwise still be delivered into a live
  // thread's context afterwards.
  it('removes queued messages sent BY a deleted chat from a surviving inbox', () => {
    saveChat('chat-keep')
    send()
    send(message({ id: 'msg-2', fromChatId: 'chat-keep' }))
    AppStore.deleteChat('chat-a')

    const remaining = AppStore.getThreadMessageInbox('chat-b')
    expect(remaining.pending.map((event) => event.id)).toEqual(['msg-2'])
  })

  it('clears the whole ledger with global history', () => {
    send()
    AppStore.clearChats()
    expect(fs.existsSync(ledgerPath)).toBe(false)
  })
})
