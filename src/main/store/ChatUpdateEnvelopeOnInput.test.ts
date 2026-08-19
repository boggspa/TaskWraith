import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { AppStore } from './index'
import type { ChatRecord } from './types'
import {
  CHAT_UPDATE_PROTOCOL_V2,
  buildChatUpdateDelivery,
  chatUpdateProducerEnvelopeFor,
  computeChatSubRevisions
} from '../../shared/chatUpdateTransport'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-envelope-input-test-${process.pid}`)

vi.hoisted(() => {
  process.env.TASKWRAITH_SAVE_COALESCE_MS = '-1'
})

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

function chatWithMessages(contents: string[]): ChatRecord {
  return {
    appChatId: 'chat-envelope-input',
    title: 'Envelope on input',
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    messages: contents.map((content, index) => ({
      id: `message-${index + 1}`,
      role: 'assistant',
      content,
      timestamp: '2026-08-19T00:00:00.000Z'
    })),
    runs: []
  } as unknown as ChatRecord
}

// The delivery coordinator resolves the producer envelope from the exact chat
// object it is handed. Nearly every main-side call site follows
// `AppStore.saveChat(updated); broadcastChatUpdated(updated)` — broadcasting
// the INPUT object, not the save's return value. If the envelope rides only
// the returned record, all of those broadcasts are envelope-less, every
// delivery degrades to a full-record snapshot, and a multi-MB chat is cloned
// over IPC per delivery (measured 2026-08-19: 3,202 snapshots, 0 patches,
// renderer RSS 5.25 GB at abort).
describe('producer envelope on the saveChat input object', () => {
  beforeEach(() => {
    AppStore.resetTransientDeletionGuardsForTests()
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(join(userDataPath, 'chats'), { recursive: true })
  })

  it('stamps the same envelope on the caller-held object so input-object broadcasts stay patch-capable', () => {
    AppStore.saveChat(chatWithMessages(['hello']))
    const baselineChat = AppStore.getChat('chat-envelope-input')!

    const input = {
      ...baselineChat,
      messages: [
        ...baselineChat.messages,
        {
          id: 'message-2',
          role: 'assistant' as const,
          content: 'streamed row',
          timestamp: '2026-08-19T00:00:01.000Z'
        }
      ]
    }
    const returned = AppStore.saveChat(input)

    const returnedEnvelope = chatUpdateProducerEnvelopeFor(returned)
    expect(returnedEnvelope?.delta).toBeTruthy()

    const inputEnvelope = chatUpdateProducerEnvelopeFor(input)
    expect(inputEnvelope).toBe(returnedEnvelope)

    // Outcome-level proof: the exact build the coordinator performs for the
    // broadcast object must produce a patch, not a snapshot.
    const baselineSub = computeChatSubRevisions(baselineChat)
    const delivery = buildChatUpdateDelivery({
      deliveryId: 'delivery-1',
      revision: 1,
      chat: input,
      baseline: {
        revision: 0,
        chat: baselineChat,
        ensembleRevision: baselineSub.ensembleRevision,
        runsRevision: baselineSub.runsRevision,
        recordHash: baselineSub.recordHash
      },
      producerState: inputEnvelope?.state,
      producerDelta: inputEnvelope?.delta ?? undefined,
      protocolVersion: CHAT_UPDATE_PROTOCOL_V2
    })
    expect(delivery.kind).toBe('patch')
  })
})
