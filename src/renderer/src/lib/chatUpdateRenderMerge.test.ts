import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord } from '../../../main/store/types'
import { coalescePendingChatUpdateRender, mergeChatUpdatedForRender } from './chatUpdateRenderMerge'

function message(id: string, content: string): ChatMessage {
  return { id, role: 'assistant', content, timestamp: '1' }
}

function chat(messages: ChatMessage[]): ChatRecord {
  return {
    appChatId: 'chat-merge',
    title: 'Merge test',
    archived: false,
    messages,
    runs: [],
    createdAt: 1,
    updatedAt: 1
  } as ChatRecord
}

describe('mergeChatUpdatedForRender', () => {
  it('reuses the live transcript for metadata-only updates', () => {
    const incomingMessages = [message('a', 'incoming')]
    const liveMessages = [message('a', 'live'), message('b', 'synthetic')]
    const merged = mergeChatUpdatedForRender(chat(incomingMessages), {
      liveChat: chat(liveMessages),
      messagesChanged: false,
      hasActiveRun: true,
      hadRecentRun: false
    })

    expect(merged.messages).toBe(liveMessages)
  })

  it('keeps longer live assistant content when the incoming transcript changed', () => {
    const incomingMessages = [message('a', 'short')]
    const liveMessages = [message('a', 'longer live answer')]
    const merged = mergeChatUpdatedForRender(chat(incomingMessages), {
      liveChat: chat(liveMessages),
      messagesChanged: true,
      hasActiveRun: true,
      hadRecentRun: false
    })

    expect(merged.messages).toHaveLength(1)
    expect(merged.messages[0].content).toBe('longer live answer')
  })

  it('preserves a renderer-authored user follow-up message when the incoming transcript changed', () => {
    const incomingMessages = [message('a', 'assistant answer')]
    const liveMessages = [
      message('a', 'assistant answer'),
      { id: 'u1', role: 'user', content: 'follow-up', timestamp: '2' } as ChatMessage
    ]
    const merged = mergeChatUpdatedForRender(chat(incomingMessages), {
      liveChat: chat(liveMessages),
      messagesChanged: true,
      hasActiveRun: true,
      hadRecentRun: false
    })

    expect(merged.messages).toHaveLength(2)
    expect(merged.messages[1].role).toBe('user')
    expect(merged.messages[1].content).toBe('follow-up')
  })

  it('preserves a renderer-authored closeout outside the recent-run window', () => {
    const incoming = chat([message('a', 'answer')])
    const closeout: ChatMessage = {
      id: 'closeout',
      role: 'system',
      content: '',
      timestamp: '2',
      metadata: { kind: 'taskWraithCloseout' }
    }
    const live = chat([...incoming.messages, closeout])
    const merged = mergeChatUpdatedForRender(incoming, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })

    expect(merged.messages.map((entry) => entry.id)).toEqual(['a', 'closeout'])
  })

  // 1.0.5-UI2 — renderer-authored goal/roster edits must survive a stale
  // main refresh (the "Set Goal sets then unsets" / "Add Participant adds
  // then removes" reports).
  function makeGoal(updatedAt: string, objective = 'Ship the fix'): ActiveGoal {
    return {
      id: 'goal-1',
      objective,
      status: 'active',
      mode: 'taskwraith_steered',
      provider: 'codex',
      createdAt: updatedAt,
      updatedAt
    } as ActiveGoal
  }

  function makeEnsemble(
    participants: Array<Pick<EnsembleParticipant, 'id' | 'role'>>,
    ensembleUpdatedAt: string
  ): ChatRecord['ensemble'] {
    return {
      enabled: true,
      maxParticipants: Math.max(6, participants.length),
      participants: participants.map((participant, index) => ({
        id: participant.id,
        provider: 'codex',
        enabled: true,
        role: participant.role,
        instructions: '',
        order: index + 1,
        model: 'gpt-5.4'
      })) as EnsembleParticipant[],
      updatedAt: ensembleUpdatedAt
    } as ChatRecord['ensemble']
  }

  it('preserves a just-set live goal against a staler delivery that lacks it', () => {
    const deliveredAt = chat([message('a', 'stream frame')])
    deliveredAt.updatedAt = Date.parse('2026-09-01T00:00:00.500Z')
    const live = { ...chat([message('a', 'stream frame')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    live.activeGoal = makeGoal('2026-09-01T00:00:02.000Z')
    const merged = mergeChatUpdatedForRender(deliveredAt, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: true,
      hadRecentRun: false
    })
    expect(merged.activeGoal?.id).toBe('goal-1')
  })

  it('keeps a deliberate live goal clear instead of resurrecting a stale delivery goal', () => {
    const delivered = { ...chat([message('a', 'stale frame')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:00.500Z')
    delivered.activeGoal = makeGoal('2026-09-01T00:00:00.400Z')
    const live = chat([message('a', 'stale frame')])
    live.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged.activeGoal).toBeUndefined()
  })

  it('lets a newer main-side goal win over the older live copy', () => {
    const delivered = { ...chat([message('a', 'sync')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:03.000Z')
    delivered.activeGoal = makeGoal('2026-09-01T00:00:03.000Z', 'Main-synced objective')
    const live = { ...chat([message('a', 'sync')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:01.000Z')
    live.activeGoal = makeGoal('2026-09-01T00:00:01.000Z', 'Locally set objective')
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged.activeGoal?.objective).toBe('Main-synced objective')
  })

  it('keeps an identical delivered goal without rewriting the record', () => {
    const goal = makeGoal('2026-09-01T00:00:01.000Z')
    const delivered = { ...chat([message('a', 'echo')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    delivered.activeGoal = JSON.parse(JSON.stringify(goal))
    const live = { ...chat([message('a', 'echo')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    live.activeGoal = goal
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged).toBe(delivered)
  })

  it('preserves a just-added live participant against a staler delivery roster', () => {
    const delivered = { ...chat([message('a', 'run frame')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:00.500Z')
    delivered.ensemble = makeEnsemble(
      [{ id: 'seat-1', role: 'Worker' }],
      '2026-09-01T00:00:00.500Z'
    )
    const live = { ...chat([message('a', 'run frame')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:00.500Z')
    live.ensemble = makeEnsemble(
      [
        { id: 'seat-1', role: 'Worker' },
        { id: 'seat-2', role: 'Reviewer' }
      ],
      '2026-09-01T00:00:02.000Z'
    )
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: true,
      hadRecentRun: false
    })
    expect(merged.ensemble?.participants.map((participant) => participant.id)).toEqual([
      'seat-1',
      'seat-2'
    ])
  })

  it('lets a newer delivered roster change replace the stale live roster', () => {
    const delivered = { ...chat([message('a', 'remote edit')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:04.000Z')
    delivered.ensemble = makeEnsemble(
      [
        { id: 'seat-1', role: 'Worker' },
        { id: 'seat-3', role: 'Remote seat' }
      ],
      '2026-09-01T00:00:04.000Z'
    )
    const live = { ...chat([message('a', 'remote edit')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:01.000Z')
    live.ensemble = makeEnsemble([{ id: 'seat-1', role: 'Worker' }], '2026-09-01T00:00:01.000Z')
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged.ensemble?.participants.map((participant) => participant.id)).toEqual([
      'seat-1',
      'seat-3'
    ])
  })

  it('leaves the record untouched when live and delivered rosters agree', () => {
    const delivered = { ...chat([message('a', 'frame')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:01.000Z')
    delivered.ensemble = makeEnsemble([{ id: 'seat-1', role: 'Worker' }], '2026-09-01T00:00:01.000Z')
    const live = { ...chat([message('a', 'frame')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:01.000Z')
    live.ensemble = makeEnsemble([{ id: 'seat-1', role: 'Worker' }], '2026-09-01T00:00:01.000Z')
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged).toBe(delivered)
  })
})

describe('coalescePendingChatUpdateRender', () => {
  it('keeps transcript dirt sticky when metadata arrives before the frame flush', () => {
    const live = chat([message('a', 'old')])
    const closeout: ChatMessage = {
      id: 'closeout',
      role: 'system',
      content: '',
      timestamp: '2',
      metadata: { kind: 'taskWraithCloseout' }
    }
    const transcriptMessages = [message('a', 'old'), closeout]
    const transcriptDelivery = chat(transcriptMessages)
    const metadataDelivery = {
      ...chat(transcriptMessages),
      title: 'Newest metadata'
    }

    const first = coalescePendingChatUpdateRender(undefined, {
      chat: transcriptDelivery,
      messagesChanged: true,
      hasActiveRun: true,
      hadRecentRun: false
    })
    const pending = coalescePendingChatUpdateRender(first, {
      chat: metadataDelivery,
      messagesChanged: false,
      hasActiveRun: true,
      hadRecentRun: false
    })
    const merged = mergeChatUpdatedForRender(pending.chat, {
      liveChat: live,
      messagesChanged: pending.messagesChanged,
      hasActiveRun: pending.hasActiveRun,
      hadRecentRun: pending.hadRecentRun
    })

    expect(pending.chat).toBe(metadataDelivery)
    expect(pending.messagesChanged).toBe(true)
    expect(merged.title).toBe('Newest metadata')
    expect(merged.messages.map((entry) => entry.id)).toEqual(['a', 'closeout'])
  })

  it('retains only the newest non-gating render receipt for a coalesced chat', () => {
    const first = coalescePendingChatUpdateRender(undefined, {
      chat: chat([message('a', 'one')]),
      messagesChanged: true,
      hasActiveRun: true,
      hadRecentRun: false,
      renderReceipt: {
        chatId: 'chat-merge',
        deliveryId: 'delivery-1',
        revision: 1,
        rendererEpoch: 'renderer-a'
      }
    })
    const pending = coalescePendingChatUpdateRender(first, {
      chat: chat([message('a', 'two')]),
      messagesChanged: true,
      hasActiveRun: true,
      hadRecentRun: false,
      renderReceipt: {
        chatId: 'chat-merge',
        deliveryId: 'delivery-2',
        revision: 2,
        rendererEpoch: 'renderer-a'
      }
    })

    expect(pending.renderReceipt?.deliveryId).toBe('delivery-2')
  })
})
