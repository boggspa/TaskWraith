import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../../main/store/types'
import type { ChatUpdateBaseline } from '../../../shared/chatUpdateTransport'
import { ChatByteLru } from './chatByteLru'
import type { RawLogEntry } from './rawLogEntry'
import { RendererChatRetention } from './rendererChatRetention'
import { ChatTranscriptStore } from './chatTranscriptStore'

function chat(id: string, content: string): ChatRecord {
  return {
    appChatId: id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [{ id: `${id}-message`, role: 'user', content, timestamp: '1' }],
    runs: []
  }
}

function baseline(record: ChatRecord): ChatUpdateBaseline {
  return { revision: 1, chat: record }
}

describe('RendererChatRetention', () => {
  it('drops every renderer alias when the shared byte LRU demotes a chat', () => {
    const visible = chat('visible', 'focused')
    const cold = chat('cold', 'x'.repeat(8_000))
    const transcriptStore = new ChatTranscriptStore()
    const retention = new RendererChatRetention({
      byteLru: new ChatByteLru({ maxBytes: 1 }),
      transcriptStore
    })
    const baselines = new Map<string, ChatUpdateBaseline>([
      ['visible', baseline(visible)],
      ['cold', baseline(cold)]
    ])
    const rawLogs = new Map<string, RawLogEntry[]>([
      ['visible', [{ type: 'info', content: 'keep' }]],
      ['cold', [{ type: 'stdout', content: 'release' }]]
    ])
    retention.attachTransportBaselines(baselines)
    retention.attachRawLogs(rawLogs)
    retention.pin('visible', 'focused')
    transcriptStore.ingest(visible)
    transcriptStore.ingest(cold)

    const retained = retention.retain([visible, cold])

    expect(retained.evictedIds).toEqual(['cold'])
    expect(transcriptStore.has('visible')).toBe(true)
    expect(transcriptStore.has('cold')).toBe(false)
    expect(baselines.has('visible')).toBe(true)
    expect(baselines.has('cold')).toBe(false)
    expect(rawLogs.has('visible')).toBe(true)
    expect(rawLogs.has('cold')).toBe(false)
  })

  it('pins pane, side-chat and approval surfaces independently of focus', () => {
    const retention = new RendererChatRetention({
      byteLru: new ChatByteLru({ maxBytes: 0 }),
      transcriptStore: new ChatTranscriptStore()
    })
    retention.pin('pane', 'pane')
    retention.pin('side', 'side')
    retention.pin('approval', 'approval')

    const retained = retention.retain([
      chat('pane', 'pane'),
      chat('side', 'side'),
      chat('approval', 'approval')
    ])

    expect(retained.evictedIds).toEqual([])
    expect(retained.stats.hydratedFullChatCount).toBe(3)
  })

  it('clears renderer state while leaving durable history available to rehydrate', () => {
    const durableHistory = new Map([['chat', chat('chat', 'durable transcript')]])
    const transcriptStore = new ChatTranscriptStore()
    const retention = new RendererChatRetention({
      byteLru: new ChatByteLru({ maxBytes: 0 }),
      transcriptStore
    })
    const baselines = new Map([['chat', baseline(durableHistory.get('chat')!)]])
    const rawLogs = new Map<string, RawLogEntry[]>([
      ['chat', [{ type: 'tool', content: 'durable run-event projection' }]]
    ])
    retention.attachTransportBaselines(baselines)
    retention.attachRawLogs(rawLogs)
    transcriptStore.ingest(durableHistory.get('chat')!)
    retention.pin('chat', 'focused')

    retention.clear()

    expect(transcriptStore.has('chat')).toBe(false)
    expect(baselines.size).toBe(0)
    expect(rawLogs.size).toBe(0)
    expect(retention.isPinned('chat')).toBe(false)
    expect(durableHistory.get('chat')?.messages[0]?.content).toBe('durable transcript')

    transcriptStore.ingest(durableHistory.get('chat')!)
    expect(transcriptStore.get('chat')?.messages[0]?.content).toBe('durable transcript')
  })
})
