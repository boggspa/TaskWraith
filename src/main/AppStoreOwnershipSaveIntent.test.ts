import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { persistIdempotencyKeyFor, type ChatSaveOwnershipPort } from '../shared/chatSaveIntentQueue'
import type { ThreadOwnershipReceiptEvidence } from './host/ThreadOwnershipReceiptEvidence'
import { AppStore } from './store'
import type { ChatRecord } from './store/types'

const userDataPath = vi.hoisted(() => {
  const tmpRoot =
    process.platform === 'win32' && /^[A-Za-z]:/.test(process.cwd())
      ? `${process.cwd().slice(0, 2)}/tmp`
      : '/tmp'
  return `${tmpRoot}/taskwraith-ownership-save-intent-test-${process.pid}`
})

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

const SHA = 'c'.repeat(64)
const exact = (threadId: string, revision: number): ThreadOwnershipReceiptEvidence => ({
  kind: 'exact',
  threadId,
  commandId: `host-${revision}`,
  revision,
  sha256: SHA
})

function port(overrides: Partial<ChatSaveOwnershipPort> = {}): ChatSaveOwnershipPort & {
  minted: string[]
} {
  const minted: string[] = []
  let counter = 0
  return {
    minted,
    mintHandle() {
      counter += 1
      const commandId = `intent-${counter}`
      minted.push(commandId)
      return { commandId, idempotencyKey: persistIdempotencyKeyFor(commandId) }
    },
    receiptsFor: () => [],
    hydrateReceipts: () => undefined,
    isActive: () => false,
    ...overrides
  }
}

function draft(title = 'Thread'): ChatRecord {
  const chat = AppStore.createChat('workspace-1', '/repo')
  return {
    ...chat,
    title,
    messages: [{ id: 'm1', role: 'user', content: 'hello', timestamp: '2026-05-08T00:00:00.000Z' }]
  } as ChatRecord
}

describe('AppStore.saveChat ownership save intents', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(join(userDataPath, 'chats'), { recursive: true })
    AppStore.getSaveIntentQueue().forgetAll()
  })

  afterEach(() => {
    AppStore.installThreadOwnershipSavePort(null)
    AppStore.getSaveIntentQueue().forgetAll()
  })

  it('changes nothing without a port: no intent, no receipts field', () => {
    const chat = draft()
    AppStore.saveChat(chat)
    const queue = AppStore.getSaveIntentQueue()
    expect(queue.peek(chat.appChatId)).toEqual([])
    expect(queue.admittedHead(chat.appChatId)).toBeNull()
    expect(AppStore.getChat(chat.appChatId)).not.toHaveProperty('threadOwnershipReceipts')
  })

  it('queues the intent before the authored record reaches disk, with the exact minted handle', () => {
    const chat = draft()
    const chatFile = join(userDataPath, 'chats', `${chat.appChatId}.json`)
    const messagesOnDiskWhenMinted: number[] = []
    const hook = port()
    const mint = hook.mintHandle
    hook.mintHandle = () => {
      messagesOnDiskWhenMinted.push(
        (JSON.parse(fs.readFileSync(chatFile, 'utf8')).messages ?? []).length
      )
      return mint()
    }
    AppStore.installThreadOwnershipSavePort(hook)

    AppStore.saveChat(chat)

    // createChat already wrote the file; the authored message is not on disk yet.
    expect(messagesOnDiskWhenMinted).toEqual([0])
    expect(AppStore.getChat(chat.appChatId)?.messages).toHaveLength(1)
    const [intent] = AppStore.getSaveIntentQueue().peek(chat.appChatId)
    expect(intent.commandId).toBe('intent-1')
    expect(intent.idempotencyKey).toBe('thread:record-persist:intent-1')
    expect(intent.record.appChatId).toBe(chat.appChatId)
    expect(AppStore.getChat(chat.appChatId)?.title).toBe('Thread')
  })

  it('coalesces repeated saves of one chat and keeps every handle', () => {
    const chat = draft()
    AppStore.installThreadOwnershipSavePort(port())
    AppStore.saveChat(chat)
    AppStore.saveChat({ ...chat, title: 'Second' })
    AppStore.saveChat({ ...chat, title: 'Third' })

    const pending = AppStore.getSaveIntentQueue().peek(chat.appChatId)
    expect(pending).toHaveLength(1)
    expect(pending[0].commandId).toBe('intent-3')
    expect(pending[0].supersedes?.map((handle) => handle.commandId)).toEqual([
      'intent-1',
      'intent-2'
    ])
  })

  it('stamps the desktop receipt evidence onto the record it persists', () => {
    const chat = draft()
    AppStore.installThreadOwnershipSavePort(
      port({ receiptsFor: (id) => (id === chat.appChatId ? [exact(id, 1)] : []) })
    )
    AppStore.saveChat(chat)
    expect(AppStore.getChat(chat.appChatId)?.threadOwnershipReceipts).toEqual([
      exact(chat.appChatId, 1)
    ])
  })

  it('hydrates the store from the previous record and never drops evidence the record carried', () => {
    const chat = draft()
    const hydrate = vi.fn()
    AppStore.installThreadOwnershipSavePort(port({ receiptsFor: () => [exact(chat.appChatId, 1)] }))
    AppStore.saveChat(chat)

    // A later save from a client that never saw the field, with an empty store.
    AppStore.installThreadOwnershipSavePort(port({ hydrateReceipts: hydrate }))
    AppStore.saveChat({ ...AppStore.getChat(chat.appChatId)!, threadOwnershipReceipts: undefined })

    expect(hydrate).toHaveBeenCalledWith(chat.appChatId, [exact(chat.appChatId, 1)])
    expect(AppStore.getChat(chat.appChatId)?.threadOwnershipReceipts).toEqual([
      exact(chat.appChatId, 1)
    ])
  })

  it('never trusts evidence the incoming record carries', () => {
    const chat = draft()
    const hydrate = vi.fn()
    AppStore.installThreadOwnershipSavePort(port({ hydrateReceipts: hydrate }))
    const forged = [exact(chat.appChatId, 99)]

    AppStore.saveChat({ ...chat, threadOwnershipReceipts: forged })
    expect(AppStore.getChat(chat.appChatId)).not.toHaveProperty('threadOwnershipReceipts')
    expect(AppStore.getSaveIntentQueue().peek(chat.appChatId)[0].record).not.toHaveProperty(
      'threadOwnershipReceipts'
    )

    // And a later save does not hydrate the forgery back into the store.
    AppStore.saveChat({ ...chat, title: 'Again', threadOwnershipReceipts: forged })
    expect(hydrate).not.toHaveBeenCalled()
  })

  it('leaves the intent pending until Host storage confirms it', async () => {
    const chat = draft()
    AppStore.installThreadOwnershipSavePort(port({ isActive: () => false }))
    AppStore.saveChat(chat)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(AppStore.getSaveIntentQueue().peek(chat.appChatId)).toHaveLength(1)
  })

  it('an owned chat is confirmed by the owned journal, not a Host receipt', async () => {
    const chat = draft()
    const confirmOwnedSave = vi.fn(async () => true)
    AppStore.installThreadOwnershipSavePort(port({ isActive: () => true, confirmOwnedSave }))
    AppStore.saveChat(chat)
    await vi.waitFor(() => expect(AppStore.getSaveIntentQueue().peek(chat.appChatId)).toEqual([]))
    expect(confirmOwnedSave).toHaveBeenCalledWith(chat.appChatId, expect.any(Number))
    expect(AppStore.getSaveIntentQueue().admittedHead(chat.appChatId)?.commandId).toBe('intent-1')
  })

  it.each([
    ['the owned journal does not hold it', { confirmOwnedSave: async () => false }],
    ['no owned-journal confirmation is composed', {}]
  ])('an owned save stays pending when %s', async (_case, extra) => {
    const chat = draft()
    AppStore.installThreadOwnershipSavePort(port({ isActive: () => true, ...extra }))
    AppStore.saveChat(chat)
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Neither a Host receipt nor the owned journal confirmed it: still pending.
    expect(AppStore.getSaveIntentQueue().peek(chat.appChatId)).toHaveLength(1)
  })

  it('a save that throws does not leave its intent pending', () => {
    const chat = draft()
    AppStore.installThreadOwnershipSavePort(port())
    AppStore.saveChat(chat)
    const queue = AppStore.getSaveIntentQueue()
    queue.settle(chat.appChatId, 'intent-1')

    const failing = { ...chat, appChatId: chat.appChatId, summaryOnly: true } as never as ChatRecord
    expect(() => AppStore.saveChat(failing)).toThrow()
    // The intent was admitted (so the throw came after it) and then released.
    expect(queue.admittedHead(chat.appChatId)?.commandId).toBe('intent-2')
    expect(queue.peek(chat.appChatId)).toEqual([])
  })

  it('a failing port never blocks the user save', () => {
    const chat = draft()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    AppStore.installThreadOwnershipSavePort(
      port({
        mintHandle: () => {
          throw new Error('port down')
        }
      })
    )
    expect(() => AppStore.saveChat(chat)).not.toThrow()
    expect(AppStore.getChat(chat.appChatId)?.title).toBe('Thread')
    expect(AppStore.getSaveIntentQueue().peek(chat.appChatId)).toEqual([])
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})
