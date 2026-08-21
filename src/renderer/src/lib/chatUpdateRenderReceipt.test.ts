import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../../main/store/types'
import type { ChatUpdateBaseline, ChatUpdateDelivery } from '../../../shared/chatUpdateTransport'
import {
  buildChatUpdateRenderedAck,
  createChatUpdateRenderReceipt,
  createRendererChatUpdateEpoch
} from './chatUpdateRenderReceipt'

const chat: ChatRecord = {
  appChatId: 'chat-1',
  title: 'Receipt test',
  archived: false,
  messages: [],
  runs: [],
  createdAt: 1,
  updatedAt: 2
}

describe('chat update render receipts', () => {
  it('carries the accepted delivery identity without becoming a second transport ACK', () => {
    const delivery: ChatUpdateDelivery = {
      protocolVersion: 2,
      kind: 'snapshot',
      deliveryId: 'delivery-1',
      deliveryEpoch: 7,
      chatId: 'chat-1',
      revision: 4,
      chat
    }
    const baseline: ChatUpdateBaseline = {
      revision: 4,
      chat,
      recordHash: 'record-hash',
      transcriptHash: 'transcript-hash'
    }

    const receipt = createChatUpdateRenderReceipt(delivery, baseline, 'renderer-epoch')
    expect(buildChatUpdateRenderedAck(receipt)).toEqual({
      deliveryId: 'delivery-1',
      applied: true,
      phase: 'rendered',
      chatId: 'chat-1',
      revision: 4,
      rendererEpoch: 'renderer-epoch',
      deliveryEpoch: 7,
      recordHash: 'record-hash',
      transcriptHash: 'transcript-hash'
    })
  })

  it('creates a non-empty document-scoped renderer epoch', () => {
    expect(createRendererChatUpdateEpoch()).toMatch(/\S/)
  })
})
