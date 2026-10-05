/**
 * A save that removes transcript rows, through the real store with barrier
 * durability switched on, on both of the store's save paths: it takes a
 * destructive ticket only when its caller says the user asked for the rows to
 * go, and then on the urgent barrier of the thread's own debt.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  chatRecord,
  disposeHostOwnedStores,
  importHostOwnedStore
} from './hostOwnedErasure.testutil'
import type { ChatMessage } from './types'

afterEach(async () => {
  await disposeHostOwnedStores()
  vi.unstubAllEnvs()
})

const CHAT = 'chat-removals'

function row(id: string, role: ChatMessage['role'], content: string): ChatMessage {
  return { id, role, content, timestamp: '2026-10-05T00:00:00.000Z' }
}

describe("a save's removal, through the real store", () => {
  it.each([
    ['the Host owns the store', false],
    ['the admitted path, before the Host owned it', true]
  ])(
    'takes a destructive ticket only when the user asked for it, while %s',
    async (_path, gateOpen) => {
      vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '1')
      const { AppStore } = await importHostOwnedStore([], undefined, { gateOpen })
      AppStore.updateSettings({ storeLocalChatHistory: true })
      const created = chatRecord(CHAT, 0, {
        messages: [
          row('user-1', 'user', 'First question'),
          row('reply-1', 'assistant', 'An answer'),
          row('reply-2', 'assistant', 'More of it')
        ]
      })
      AppStore.saveChat(created)
      const destructive = () =>
        AppStore.getThreadBarrierDurabilityPerf().tickets?.moments.destructive.noted
      const barriers = () => AppStore.getThreadBarrierDurabilityPerf().debt!.barriers
      const raisedBefore = barriers()

      const first = AppStore.getChat(CHAT)!
      AppStore.saveChat({ ...first, messages: first.messages.slice(0, 2) })
      expect(AppStore.getChat(CHAT)!.messages).toHaveLength(2)
      expect(destructive()).toBe(0)
      expect(barriers()).toMatchObject({ raised: raisedBefore.raised })

      const second = AppStore.getChat(CHAT)!
      AppStore.saveChat(
        { ...second, messages: second.messages.slice(0, 1) },
        { removalAskedByUser: true }
      )
      expect(AppStore.getChat(CHAT)!.messages).toHaveLength(1)
      expect(destructive()).toBe(1)
      expect(barriers()).toMatchObject({
        raised: raisedBefore.raised + 1,
        urgent: raisedBefore.urgent + 1,
        threadOnly: raisedBefore.threadOnly + 1,
        scoped: raisedBefore.scoped
      })
    }
  )
})
