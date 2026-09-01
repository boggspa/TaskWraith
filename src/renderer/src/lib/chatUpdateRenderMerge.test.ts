import { describe, expect, it } from 'vitest'
import type {
  ActiveGoal,
  ChatMessage,
  ChatRecord,
  EnsembleParticipant
} from '../../../main/store/types'
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

  it('never takes a paged shell’s window as the live transcript', () => {
    // Stage 1b: a paged shell's messages are a bounded presentation page;
    // folding them into a metadata-only delivery would blank the full arrays.
    const incomingMessages = [message('a', 'incoming'), message('b', 'two')]
    const pagedShell = {
      ...chat([message('b', 'two')]),
      summaryOnly: true,
      messageCount: 2,
      runCount: 0,
      transcriptPaged: true
    } as unknown as ChatRecord
    const merged = mergeChatUpdatedForRender(chat(incomingMessages), {
      liveChat: pagedShell,
      messagesChanged: false,
      hasActiveRun: true,
      hadRecentRun: false
    })

    expect(merged.messages).toBe(incomingMessages)
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
    participants: Array<Pick<EnsembleParticipant, 'id' | 'role'> & Partial<EnsembleParticipant>>,
    ensembleUpdatedAt: string
  ): ChatRecord['ensemble'] {
    return {
      enabled: true,
      maxParticipants: Math.max(6, participants.length),
      participants: participants.map((participant, index) => ({
        provider: 'codex',
        enabled: true,
        instructions: '',
        order: index + 1,
        model: 'gpt-5.4',
        ...participant
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

  // Same 1.0.5-UI2 class, mode-state report (2026-08-30): an Ensemble on/off
  // toggle commits optimistically and persists asynchronously. A delivery built
  // BEFORE that save lands reverts chatKind wholesale — the roster helper
  // cannot defend it because a collapsed live record has no ensemble block to
  // compare, and the selection helper never covered mode state.
  it('keeps a just-collapsed single-provider mode against a staler ensemble delivery', () => {
    const delivered = { ...chat([message('a', 'frame')]), chatKind: 'ensemble' as const }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:00.500Z')
    delivered.ensemble = makeEnsemble([{ id: 'seat-1', role: 'Boss' }], '2026-08-31T00:00:00.500Z')
    const live = { ...chat([message('a', 'frame')]), chatKind: 'single' as const }
    live.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    live.providerMetadata = {
      stashedEnsemble: {
        config: makeEnsemble([{ id: 'seat-1', role: 'Boss' }], '2026-08-31T00:00:00.500Z'),
        provider: 'kimi'
      }
    }
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged.chatKind).toBe('single')
    expect(merged.ensemble).toBeUndefined()
    // The stashed roster rides across too, or a later Ensemble-on toggle loses it.
    expect(merged.providerMetadata?.stashedEnsemble).toEqual(
      live.providerMetadata.stashedEnsemble
    )
  })

  it('keeps a just-enabled ensemble mode against a staler single-provider delivery', () => {
    const delivered = { ...chat([message('a', 'frame')]), chatKind: 'single' as const }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:00.500Z')
    const live = { ...chat([message('a', 'frame')]), chatKind: 'ensemble' as const }
    live.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    live.ensemble = makeEnsemble([{ id: 'seat-1', role: 'Boss' }], '2026-09-01T00:00:02.000Z')
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged.chatKind).toBe('ensemble')
    expect(merged.ensemble?.participants.map((participant) => participant.id)).toEqual(['seat-1'])
  })

  it('lets a newer delivered mode change replace the stale live mode', () => {
    // The toggle's own confirmed broadcast — or a remote companion's switch —
    // is newer than the optimistic live copy and must still win.
    const delivered = { ...chat([message('a', 'frame')]), chatKind: 'ensemble' as const }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:04.000Z')
    delivered.ensemble = makeEnsemble([{ id: 'seat-1', role: 'Boss' }], '2026-09-01T00:00:04.000Z')
    const live = { ...chat([message('a', 'frame')]), chatKind: 'single' as const }
    live.updatedAt = Date.parse('2026-09-01T00:00:01.000Z')
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged.chatKind).toBe('ensemble')
    expect(merged.ensemble?.participants).toHaveLength(1)
  })

  it('leaves the record untouched when live and delivered modes agree', () => {
    const delivered = { ...chat([message('a', 'frame')]), chatKind: 'single' as const }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:01.000Z')
    const live = { ...chat([message('a', 'frame')]), chatKind: 'single' as const }
    live.updatedAt = Date.parse('2026-09-01T00:00:01.000Z')
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged).toBe(delivered)
  })

  // Same 1.0.5-UI2 class, third report: a seat's model/reasoning edit (the
  // Provider/Model/Reasoning picker bound to a participant chip, or the Add
  // Participant picker's seat rows) keeps the id sequence identical, so the
  // membership-only roster preservation let a staler delivery revert the
  // fields — "the selection bounces back".
  it('preserves a just-edited seat configuration against a staler delivery with the same seats', () => {
    const delivered = { ...chat([message('a', 'run frame')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:00.500Z')
    delivered.ensemble = makeEnsemble(
      [{ id: 'seat-1', role: 'Worker', model: 'gpt-5.4', reasoningEffort: 'medium' }],
      '2026-09-01T00:00:00.500Z'
    )
    const live = { ...chat([message('a', 'run frame')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    live.ensemble = makeEnsemble(
      [
        {
          id: 'seat-1',
          role: 'Worker',
          model: 'gpt-5.6-codex',
          reasoningEffort: 'xhigh',
          fastModeEnabled: true
        }
      ],
      '2026-09-01T00:00:02.000Z'
    )
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged.ensemble?.participants[0].model).toBe('gpt-5.6-codex')
    expect(merged.ensemble?.participants[0].reasoningEffort).toBe('xhigh')
    expect(merged.ensemble?.participants[0].fastModeEnabled).toBe(true)
  })

  it('keeps delivered seat bookkeeping while restoring the live seat configuration', () => {
    const delivered = { ...chat([message('a', 'run frame')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:00.500Z')
    delivered.ensemble = makeEnsemble(
      [
        {
          id: 'seat-1',
          role: 'Worker',
          model: 'gpt-5.4',
          linkedProviderSessionId: 'session-9',
          promptShellVersion: 'shell-3'
        }
      ],
      '2026-09-01T00:00:00.500Z'
    )
    const live = { ...chat([message('a', 'run frame')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    live.ensemble = makeEnsemble(
      [{ id: 'seat-1', role: 'Worker', model: 'gpt-5.6-codex' }],
      '2026-09-01T00:00:02.000Z'
    )
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged.ensemble?.participants[0].model).toBe('gpt-5.6-codex')
    expect(merged.ensemble?.participants[0].linkedProviderSessionId).toBe('session-9')
    expect(merged.ensemble?.participants[0].promptShellVersion).toBe('shell-3')
  })

  it('lets a newer delivered seat configuration replace the stale live copy', () => {
    const delivered = { ...chat([message('a', 'remote edit')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:04.000Z')
    delivered.ensemble = makeEnsemble(
      [{ id: 'seat-1', role: 'Worker', model: 'gpt-5.7' }],
      '2026-09-01T00:00:04.000Z'
    )
    const live = { ...chat([message('a', 'remote edit')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:01.000Z')
    live.ensemble = makeEnsemble(
      [{ id: 'seat-1', role: 'Worker', model: 'gpt-5.4' }],
      '2026-09-01T00:00:01.000Z'
    )
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged.ensemble?.participants[0].model).toBe('gpt-5.7')
  })

  // Same class again for the solo composer: the Provider/Model/Reasoning
  // picker's chat-level selection (providerMetadata + the queued provider
  // change + workflowMode) had no preservation at all, and main's overlay
  // persistence never broadcasts, so a staler delivery reverted the pick and
  // nothing ever bounced it forward again.
  it('preserves a just-picked composer model selection against a staler delivery', () => {
    const delivered = { ...chat([message('a', 'save echo')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:00.500Z')
    delivered.provider = 'kimi' as ChatRecord['provider']
    delivered.providerMetadata = {
      selectedModelType: 'kimi-k2.7',
      kimiReasoningEffort: 'on',
      agentIdentities: { keep: true }
    }
    const live = { ...chat([message('a', 'save echo')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    live.provider = 'ollama' as ChatRecord['provider']
    live.providerMetadata = {
      selectedModelType: 'ornith-1.0:9b',
      ollamaReasoningEffort: 'on'
    }
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged.provider).toBe('ollama')
    expect(merged.providerMetadata?.selectedModelType).toBe('ornith-1.0:9b')
    expect(merged.providerMetadata?.ollamaReasoningEffort).toBe('on')
    // Selection keys the fresher live record dropped are dropped too…
    expect(merged.providerMetadata?.kimiReasoningEffort).toBeUndefined()
    // …but non-selection metadata stays delivered-authoritative.
    expect(merged.providerMetadata?.agentIdentities).toEqual({ keep: true })
  })

  it('preserves a just-queued pending provider change against a staler delivery', () => {
    const delivered = { ...chat([message('a', 'run frame')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:00.500Z')
    delivered.providerMetadata = { selectedModelType: 'kimi-k2.7' }
    const live = { ...chat([message('a', 'run frame')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    live.providerMetadata = {
      selectedModelType: 'kimi-k2.7',
      pendingProviderChange: {
        provider: 'ollama',
        providerMetadata: { selectedModelType: 'ornith-1.0:9b' },
        queuedAt: '2026-09-01T00:00:02.000Z'
      }
    }
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged.providerMetadata?.pendingProviderChange).toEqual({
      provider: 'ollama',
      providerMetadata: { selectedModelType: 'ornith-1.0:9b' },
      queuedAt: '2026-09-01T00:00:02.000Z'
    })
  })

  it('does not resurrect a pending provider change the fresher live record cleared', () => {
    const delivered = { ...chat([message('a', 'run frame')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:00.500Z')
    delivered.providerMetadata = {
      pendingProviderChange: {
        provider: 'ollama',
        providerMetadata: { selectedModelType: 'ornith-1.0:9b' },
        queuedAt: '2026-09-01T00:00:00.000Z'
      }
    }
    const live = { ...chat([message('a', 'run frame')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    live.providerMetadata = { selectedModelType: 'ornith-1.0:9b' }
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged.providerMetadata?.pendingProviderChange).toBeUndefined()
    expect(merged.providerMetadata?.selectedModelType).toBe('ornith-1.0:9b')
  })

  it('lets a newer delivered composer selection win over the older live copy', () => {
    const delivered = { ...chat([message('a', 'turn-end apply')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:04.000Z')
    delivered.provider = 'ollama' as ChatRecord['provider']
    delivered.providerMetadata = { selectedModelType: 'ornith-1.0:9b' }
    const live = { ...chat([message('a', 'turn-end apply')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:01.000Z')
    live.provider = 'kimi' as ChatRecord['provider']
    live.providerMetadata = { selectedModelType: 'kimi-k2.7' }
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged.provider).toBe('ollama')
    expect(merged.providerMetadata?.selectedModelType).toBe('ornith-1.0:9b')
  })

  it('leaves the record untouched when the composer selections agree', () => {
    const delivered = { ...chat([message('a', 'frame')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:01.000Z')
    delivered.providerMetadata = { selectedModelType: 'kimi-k2.7' }
    const live = { ...chat([message('a', 'frame')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    live.providerMetadata = { selectedModelType: 'kimi-k2.7' }
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
