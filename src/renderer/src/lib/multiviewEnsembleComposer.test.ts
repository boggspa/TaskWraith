import { describe, expect, it } from 'vitest'
import type {
  ActiveGoalStatus,
  ChatRecord,
  EnsembleConfig,
  EnsembleParticipant,
  EnsembleRoundState,
  ProviderId
} from '../../../main/store/types'
import { PI_MODEL_LABELS, PI_UPSTREAM_BRANDS } from '../../../shared/piBrandTable'
import {
  buildEnsembleProviderBlendStyle,
  buildMultiviewEnsembleComposerProjection,
  buildMultiviewEnsembleSelectionPruneSnapshot,
  isMultiviewEnsembleParticipantSelectionValid,
  mergeEnsembleQueuedPromptMutationResult,
  pruneMultiviewEnsembleSelectionOwnership,
  resolveMultiviewEnsembleParticipantSelection
} from './multiviewEnsembleComposer'
import { reconcileChatRefMap } from './reconcileChatRefMap'

describe('buildMultiviewEnsembleComposerProjection', () => {
  it('keeps composer state disjoint for chats that reuse participant ids', () => {
    const firstParticipants = makeParticipants([
      ['shared-boss', 'codex', 3, true],
      ['shared-disabled', 'grok', 1, false],
      ['shared-reviewer', 'claude', 2, true],
      ['shared-scout', 'cursor', 0, true]
    ])
    const secondParticipants = makeParticipants([
      ['shared-boss', 'claude', 1, true],
      ['shared-disabled', 'cursor', 3, false],
      ['shared-reviewer', 'grok', 0, true],
      ['shared-scout', 'codex', 2, true]
    ])
    const firstChat = makeEnsembleChat({
      id: 'first-chat',
      participants: firstParticipants,
      selectedParticipantId: 'shared-boss',
      orchestrationMode: 'continuous',
      fanoutPolicy: 'all',
      maxContinuationHops: 12,
      activeGoalStatus: 'blocked',
      activeRound: makeLiveRound({
        id: 'first-round',
        participants: firstParticipants,
        activeParticipantId: 'shared-reviewer',
        orchestrationMode: 'turn_bound',
        fanoutPolicy: 'off',
        continuationHops: 2,
        maxContinuationHops: 5
      })
    })
    const secondChat = makeEnsembleChat({
      id: 'second-chat',
      participants: secondParticipants,
      selectedParticipantId: 'shared-reviewer',
      orchestrationMode: 'turn_bound',
      fanoutPolicy: 'off',
      activeGoalStatus: 'active',
      activeRound: makeLiveRound({
        id: 'second-round',
        participants: secondParticipants,
        activeParticipantId: 'shared-boss',
        orchestrationMode: 'continuous',
        fanoutPolicy: 'locked_writers_with_boss',
        continuationHops: 7,
        maxContinuationHops: 9
      })
    })

    const first = buildMultiviewEnsembleComposerProjection(firstChat)
    const second = buildMultiviewEnsembleComposerProjection(secondChat)
    const firstActiveSpeaker = buildMultiviewEnsembleComposerProjection(
      firstChat,
      'shared-reviewer'
    )

    expect(first.participants.map((participant) => participant.id)).toEqual([
      'shared-scout',
      'shared-disabled',
      'shared-reviewer',
      'shared-boss'
    ])
    expect(second.participants.map((participant) => participant.id)).toEqual([
      'shared-reviewer',
      'shared-boss',
      'shared-scout',
      'shared-disabled'
    ])
    expect(first.enabledParticipants.map((participant) => participant.id)).toEqual([
      'shared-scout',
      'shared-reviewer',
      'shared-boss'
    ])
    expect(second.enabledParticipants.map((participant) => participant.id)).toEqual([
      'shared-reviewer',
      'shared-boss',
      'shared-scout'
    ])
    expect(first.selectedParticipant?.id).toBe('shared-boss')
    expect(second.selectedParticipant?.id).toBe('shared-reviewer')
    expect(firstActiveSpeaker.selectedParticipant?.id).toBe('shared-reviewer')
    expect(first.liveRound?.roundId).toBe('first-round')
    expect(second.liveRound?.roundId).toBe('second-round')
    expect(first.currentFanoutPolicy).toBe('all')
    expect(first.activeFanoutPolicy).toBe('off')
    expect(second.currentFanoutPolicy).toBe('off')
    // On/Off collapse: the round's stored locked_writers level projects as 'all'.
    expect(second.activeFanoutPolicy).toBe('all')
    expect(first.continuationHops).toBe(2)
    expect(first.maxContinuationHops).toBe(12)
    expect(second.continuationHops).toBe(7)
    expect(second.maxContinuationHops).toBe(9)
    expect(first.isRoundRunning).toBe(true)
    expect(second.isRoundRunning).toBe(true)
    expect(first.roundStatus).toBe('running')
    expect(second.roundStatus).toBe('running')
    expect(first.activeGoalStatus).toBe('blocked')
    expect(second.activeGoalStatus).toBe('active')
    expect(first.providerBlendStyle).toEqual({
      '--ensemble-provider-1': 'var(--provider-cursor-color)',
      '--ensemble-provider-2': 'var(--provider-claude-color)',
      '--ensemble-provider-3': 'var(--provider-codex-color)'
    })
    expect(second.providerBlendStyle).toEqual({
      '--ensemble-provider-1': 'var(--provider-grok-color)',
      '--ensemble-provider-2': 'var(--provider-claude-color)',
      '--ensemble-provider-3': 'var(--provider-codex-color)'
    })

    expect(firstParticipants.map((participant) => participant.id)).toEqual([
      'shared-boss',
      'shared-disabled',
      'shared-reviewer',
      'shared-scout'
    ])
    expect(secondParticipants.map((participant) => participant.id)).toEqual([
      'shared-boss',
      'shared-disabled',
      'shared-reviewer',
      'shared-scout'
    ])
  })

  it('projects a pending active-seat selection without mutating the stored roster', () => {
    const participants = makeParticipants([
      ['active-seat', 'codex', 0, true],
      ['idle-seat', 'claude', 1, true]
    ])
    const chat = makeEnsembleChat({
      id: 'pending-chat',
      participants,
      selectedParticipantId: 'active-seat',
      orchestrationMode: 'continuous',
      fanoutPolicy: 'off',
      activeGoalStatus: 'active',
      activeRound: makeLiveRound({
        id: 'pending-round',
        participants,
        activeParticipantId: 'active-seat',
        orchestrationMode: 'continuous',
        fanoutPolicy: 'off',
        continuationHops: 1,
        maxContinuationHops: 6
      })
    })
    const pendingParticipant: EnsembleParticipant = {
      ...participants[0],
      provider: 'kimi',
      model: 'kimi-k2.7-code',
      reasoningEffort: 'high',
      permissionPresetId: 'workspace_write'
    }

    const projection = buildMultiviewEnsembleComposerProjection(chat, 'active-seat', {
      'active-seat': pendingParticipant
    })

    expect(projection.selectedParticipant).toEqual(pendingParticipant)
    expect(projection.participants[0]).toEqual(pendingParticipant)
    expect(chat.ensemble?.participants[0]).toEqual({
      id: 'active-seat',
      provider: 'codex',
      role: 'active-seat',
      instructions: '',
      order: 0,
      enabled: true,
      permissionPresetId: 'read_only'
    })
  })

  it('ignores a terminal round when deriving live composer state', () => {
    const participants = makeParticipants([
      ['shared-boss', 'codex', 0, true],
      ['shared-reviewer', 'claude', 1, true]
    ])
    const terminalRound = makeLiveRound({
      id: 'completed-round',
      participants,
      activeParticipantId: 'shared-boss',
      orchestrationMode: 'continuous',
      fanoutPolicy: 'all',
      continuationHops: 5,
      maxContinuationHops: 10
    })
    terminalRound.status = 'completed'
    terminalRound.participants = terminalRound.participants.map((participant) => ({
      ...participant,
      status: 'answered'
    }))
    const chat = makeEnsembleChat({
      id: 'completed-chat',
      participants,
      selectedParticipantId: 'shared-reviewer',
      orchestrationMode: 'turn_bound',
      fanoutPolicy: 'read_only',
      maxContinuationHops: 4,
      activeGoalStatus: 'completed',
      activeRound: terminalRound
    })

    const projection = buildMultiviewEnsembleComposerProjection(chat)

    expect(projection.liveRound).toBeUndefined()
    expect(projection.activeFanoutPolicy).toBe('all')
    expect(projection.continuationHops).toBe(0)
    expect(projection.maxContinuationHops).toBe(4)
    expect(projection.isRoundRunning).toBe(false)
    expect(projection.roundStatus).toBeUndefined()
  })

  it('prunes deleted participants and terminal round overrides across resting chats', () => {
    const firstParticipants = makeParticipants([
      ['first-boss', 'codex', 0, true],
      ['first-scout', 'cursor', 1, true]
    ])
    const secondParticipants = makeParticipants([
      ['second-boss', 'grok', 0, true],
      ['second-scout', 'claude', 1, true]
    ])
    const firstChat = makeEnsembleChat({
      id: 'first-chat',
      participants: firstParticipants,
      selectedParticipantId: 'first-boss',
      orchestrationMode: 'continuous',
      fanoutPolicy: 'off',
      activeGoalStatus: 'active',
      activeRound: makeLiveRound({
        id: 'first-live',
        participants: firstParticipants,
        activeParticipantId: 'first-boss',
        orchestrationMode: 'continuous',
        fanoutPolicy: 'off',
        continuationHops: 1,
        maxContinuationHops: 6
      })
    })
    const secondChat = makeEnsembleChat({
      id: 'second-chat',
      participants: secondParticipants,
      selectedParticipantId: 'second-boss',
      orchestrationMode: 'turn_bound',
      fanoutPolicy: 'off',
      activeGoalStatus: 'active',
      activeRound: makeLiveRound({
        id: 'second-terminal',
        participants: secondParticipants,
        activeParticipantId: 'second-boss',
        orchestrationMode: 'turn_bound',
        fanoutPolicy: 'off',
        continuationHops: 0,
        maxContinuationHops: 6
      })
    })
    secondChat.ensemble!.activeRound!.status = 'completed'
    const selected = {
      'first-chat': 'first-scout',
      'second-chat': 'removed-participant',
      'deleted-chat': 'deleted-participant'
    }
    const overrides = new Set([
      'first-chat:first-live',
      'first-chat:old-round',
      'second-chat:second-terminal',
      'deleted-chat:deleted-round'
    ])

    const pruned = pruneMultiviewEnsembleSelectionOwnership(
      [firstChat, secondChat],
      selected,
      overrides
    )

    expect(pruned.selectedParticipantIdByChatId).toEqual({
      'first-chat': 'first-scout'
    })
    expect([...pruned.userOverrodeSelectionRoundKeys]).toEqual(['first-chat:first-live'])
    expect(pruned.selectedParticipantIdByChatId).not.toBe(selected)
    expect(pruned.userOverrodeSelectionRoundKeys).not.toBe(overrides)

    const stable = pruneMultiviewEnsembleSelectionOwnership(
      [firstChat],
      pruned.selectedParticipantIdByChatId,
      pruned.userOverrodeSelectionRoundKeys
    )
    expect(stable.selectedParticipantIdByChatId).toBe(pruned.selectedParticipantIdByChatId)
    expect(stable.userOverrodeSelectionRoundKeys).toBe(
      pruned.userOverrodeSelectionRoundKeys
    )
  })

  it('converges across unstable summary snapshots while hydrated panes remain live', () => {
    const participants = makeParticipants([
      ['pane-boss', 'codex', 0, true],
      ['pane-worker', 'cursor', 1, true]
    ])
    const hydratedPane = makeEnsembleChat({
      id: 'pane-chat',
      participants,
      selectedParticipantId: 'pane-boss',
      orchestrationMode: 'continuous',
      fanoutPolicy: 'off',
      activeGoalStatus: 'active',
      activeRound: makeLiveRound({
        id: 'pane-live-round',
        participants,
        activeParticipantId: 'pane-worker',
        orchestrationMode: 'continuous',
        fanoutPolicy: 'off',
        continuationHops: 1,
        maxContinuationHops: 6
      })
    })
    const summary = {
      ...hydratedPane,
      summaryOnly: true as const,
      messageCount: 1,
      runCount: 1,
      messages: [],
      runs: [],
      // Reproduce the stale list projection that triggered the loop: its
      // ensemble payload temporarily lacks the live worker and round.
      ensemble: {
        ...hydratedPane.ensemble!,
        participants: [participants[0]],
        activeRound: undefined
      }
    }
    const hydrated = new Map([[hydratedPane.appChatId, hydratedPane]])
    const selected = { 'pane-chat': 'pane-worker' }
    const overrides = new Set(['pane-chat:pane-live-round'])

    const firstAuthority = reconcileChatRefMap({
      chats: [{ ...summary }],
      currentChat: null,
      prev: hydrated,
      activeRunChatId: hydratedPane.appChatId,
      activeRunChatIds: new Set([hydratedPane.appChatId]),
      recentlyCompleted: new Map(),
      now: 1
    })
    const firstSnapshot = buildMultiviewEnsembleSelectionPruneSnapshot(
      firstAuthority.values()
    )
    const firstPrune = pruneMultiviewEnsembleSelectionOwnership(
      firstSnapshot.chats,
      selected,
      overrides
    )
    expect(firstSnapshot.chats[0]).toBe(hydratedPane)
    expect(
      isMultiviewEnsembleParticipantSelectionValid(hydratedPane, 'pane-worker')
    ).toBe(true)
    expect(firstPrune.selectedParticipantIdByChatId).toBe(selected)
    expect(firstPrune.userOverrodeSelectionRoundKeys).toBe(overrides)

    // Fresh arrays and summary objects model whole-chat broadcast churn. The
    // effect revision stays stable and cleanup itself is a reference no-op.
    const repeatedAuthority = reconcileChatRefMap({
      chats: [{ ...summary }],
      currentChat: null,
      prev: firstAuthority,
      activeRunChatId: hydratedPane.appChatId,
      activeRunChatIds: new Set([hydratedPane.appChatId]),
      recentlyCompleted: new Map(),
      now: 2
    })
    const repeatedSnapshot = buildMultiviewEnsembleSelectionPruneSnapshot(
      repeatedAuthority.values()
    )
    const repeatedPrune = pruneMultiviewEnsembleSelectionOwnership(
      repeatedSnapshot.chats,
      firstPrune.selectedParticipantIdByChatId,
      firstPrune.userOverrodeSelectionRoundKeys
    )
    expect(repeatedSnapshot.ownershipKey).toBe(firstSnapshot.ownershipKey)
    expect(repeatedPrune.selectedParticipantIdByChatId).toBe(
      firstPrune.selectedParticipantIdByChatId
    )
    expect(repeatedPrune.userOverrodeSelectionRoundKeys).toBe(
      firstPrune.userOverrodeSelectionRoundKeys
    )

    // Participant removal and terminal-round cleanup still follow the
    // hydrated authority once it records those transitions.
    const removedWorker = {
      ...hydratedPane,
      ensemble: {
        ...hydratedPane.ensemble!,
        participants: [participants[0]],
        activeRound: {
          ...hydratedPane.ensemble!.activeRound!,
          status: 'completed' as const
        }
      }
    }
    const terminalSnapshot = buildMultiviewEnsembleSelectionPruneSnapshot([
      removedWorker
    ])
    const terminalPrune = pruneMultiviewEnsembleSelectionOwnership(
      terminalSnapshot.chats,
      selected,
      overrides
    )
    expect(terminalSnapshot.ownershipKey).not.toBe(firstSnapshot.ownershipKey)
    expect(
      isMultiviewEnsembleParticipantSelectionValid(removedWorker, 'pane-worker')
    ).toBe(false)
    expect(terminalPrune.selectedParticipantIdByChatId).toEqual({})
    expect(terminalPrune.userOverrodeSelectionRoundKeys.size).toBe(0)

    // The durable list remains the deletion authority even if the hydrated map
    // has not yet discarded an old pane record.
    const deletedAuthority = reconcileChatRefMap({
      chats: [],
      currentChat: null,
      prev: hydrated,
      activeRunChatId: null,
      activeRunChatIds: new Set(),
      recentlyCompleted: new Map(),
      now: 3
    })
    const deletedSnapshot = buildMultiviewEnsembleSelectionPruneSnapshot(
      deletedAuthority.values()
    )
    const deletedPrune = pruneMultiviewEnsembleSelectionOwnership(
      deletedSnapshot.chats,
      selected,
      overrides
    )
    expect(deletedPrune.selectedParticipantIdByChatId).toEqual({})
    expect(deletedPrune.userOverrodeSelectionRoundKeys.size).toBe(0)
  })

  it('derives live speakers without overwriting the resting user selection', () => {
    const participants = makeParticipants([
      ['speaker-a', 'codex', 0, true],
      ['manual-b', 'cursor', 1, true],
      ['speaker-c', 'grok', 2, true]
    ])
    const liveA = makeEnsembleChat({
      id: 'speaker-chat',
      participants,
      selectedParticipantId: 'manual-b',
      orchestrationMode: 'continuous',
      fanoutPolicy: 'off',
      activeGoalStatus: 'active',
      activeRound: makeLiveRound({
        id: 'speaker-round',
        participants,
        activeParticipantId: 'speaker-a',
        orchestrationMode: 'continuous',
        fanoutPolicy: 'off',
        continuationHops: 1,
        maxContinuationHops: 6
      })
    })
    const liveC: ChatRecord = {
      ...liveA,
      ensemble: {
        ...liveA.ensemble!,
        activeRound: {
          ...liveA.ensemble!.activeRound!,
          activeParticipantId: 'speaker-c'
        }
      }
    }
    const terminalC: ChatRecord = {
      ...liveC,
      ensemble: {
        ...liveC.ensemble!,
        activeRound: {
          ...liveC.ensemble!.activeRound!,
          status: 'completed'
        }
      }
    }
    const removedManualB: ChatRecord = {
      ...liveC,
      ensemble: {
        ...liveC.ensemble!,
        participants: participants.filter((participant) => participant.id !== 'manual-b')
      }
    }
    const removedManualBTerminal: ChatRecord = {
      ...removedManualB,
      ensemble: {
        ...removedManualB.ensemble!,
        activeRound: {
          ...removedManualB.ensemble!.activeRound!,
          status: 'completed'
        }
      }
    }
    const noOverrides = new Set<string>()
    const manualOverride = new Set(['speaker-chat:speaker-round'])

    // Focused and resting panes now share this projection. Switching focus
    // therefore cannot write A/C into the user-owned resting choice B.
    expect(
      resolveMultiviewEnsembleParticipantSelection(liveA, 'manual-b', noOverrides)
    ).toBe('speaker-a')
    expect(
      resolveMultiviewEnsembleParticipantSelection(liveC, 'manual-b', noOverrides)
    ).toBe('speaker-c')
    expect(
      resolveMultiviewEnsembleParticipantSelection(liveC, 'manual-b', manualOverride)
    ).toBe('manual-b')
    expect(
      resolveMultiviewEnsembleParticipantSelection(terminalC, 'manual-b', noOverrides)
    ).toBe('manual-b')
    expect(
      resolveMultiviewEnsembleParticipantSelection(
        removedManualB,
        'manual-b',
        manualOverride
      )
    ).toBe('speaker-c')
    expect(
      resolveMultiviewEnsembleParticipantSelection(
        removedManualBTerminal,
        'manual-b',
        manualOverride
      )
    ).toBeNull()

    // Active-speaker churn is projection-only and must not retrigger cleanup;
    // live → terminal remains a structural ownership transition.
    const liveARevision = buildMultiviewEnsembleSelectionPruneSnapshot([liveA])
    const liveCRevision = buildMultiviewEnsembleSelectionPruneSnapshot([liveC])
    const terminalRevision = buildMultiviewEnsembleSelectionPruneSnapshot([terminalC])
    expect(liveCRevision.ownershipKey).toBe(liveARevision.ownershipKey)
    expect(terminalRevision.ownershipKey).not.toBe(liveARevision.ownershipKey)
  })

  it('merges a queue removal without dropping concurrent appends', () => {
    expect(
      mergeEnsembleQueuedPromptMutationResult(
        ['first', 'second'],
        ['second'],
        ['first', 'second', 'appended']
      )
    ).toEqual(['second', 'appended'])
    expect(
      mergeEnsembleQueuedPromptMutationResult(
        ['same', 'same'],
        ['same'],
        ['same', 'same', 'appended']
      )
    ).toEqual(['same', 'appended'])

    const alreadyApplied = ['second', 'appended']
    expect(
      mergeEnsembleQueuedPromptMutationResult(
        ['first', 'second'],
        ['second'],
        alreadyApplied
      )
    ).toBe(alreadyApplied)

    const divergentLatest = ['replacement-round-prompt']
    expect(
      mergeEnsembleQueuedPromptMutationResult(
        ['first', 'second'],
        ['second'],
        divergentLatest
      )
    ).toBe(divergentLatest)
  })
})

describe('buildEnsembleProviderBlendStyle', () => {
  it('uses every Pi upstream hue and preserves Ollama spoofing', () => {
    for (const [upstream, brand] of Object.entries(PI_UPSTREAM_BRANDS)) {
      const model = Object.keys(PI_MODEL_LABELS).find((id) => id.startsWith(`${upstream}/`))
      expect(model, `missing representative Pi model for ${upstream}`).toBeTruthy()
      expect(
        buildEnsembleProviderBlendStyle([{ provider: 'pi', model }])
      ).toEqual({
        '--ensemble-provider-1': `var(--provider-${brand.hueClass}-color)`
      })
    }

    expect(
      buildEnsembleProviderBlendStyle([
        { provider: 'ollama', model: 'qwen3.5:9b' },
        { provider: 'codex', model: 'gpt-5.5' }
      ])
    ).toEqual({
      '--ensemble-provider-1': 'var(--provider-alibaba-color)',
      '--ensemble-provider-2': 'var(--provider-codex-color)'
    })
  })
})

type ParticipantInput = [id: string, provider: ProviderId, order: number, enabled: boolean]

function makeParticipants(inputs: ParticipantInput[]): EnsembleParticipant[] {
  return inputs.map(([id, provider, order, enabled]) => ({
    id,
    provider,
    role: id,
    instructions: '',
    order,
    enabled,
    permissionPresetId: 'read_only'
  }))
}

function makeLiveRound({
  id,
  participants,
  activeParticipantId,
  orchestrationMode,
  fanoutPolicy,
  continuationHops,
  maxContinuationHops
}: {
  id: string
  participants: EnsembleParticipant[]
  activeParticipantId: string
  orchestrationMode: NonNullable<EnsembleConfig['orchestrationMode']>
  fanoutPolicy: NonNullable<EnsembleConfig['fanoutPolicy']>
  continuationHops: number
  maxContinuationHops: number
}): EnsembleRoundState {
  return {
    roundId: id,
    status: 'running',
    prompt: 'test prompt',
    startedAt: '2026-07-13T00:00:00.000Z',
    activeParticipantId,
    orchestrationMode,
    fanoutPolicy,
    continuationHops,
    maxContinuationHops,
    participants: participants.map((participant) => ({
      participantId: participant.id,
      provider: participant.provider,
      role: participant.role,
      order: participant.order,
      status: participant.id === activeParticipantId ? 'running' : 'idle'
    }))
  }
}

function makeEnsembleChat({
  id,
  participants,
  selectedParticipantId,
  orchestrationMode,
  fanoutPolicy,
  maxContinuationHops,
  activeGoalStatus,
  activeRound
}: {
  id: string
  participants: EnsembleParticipant[]
  selectedParticipantId: string
  orchestrationMode: NonNullable<EnsembleConfig['orchestrationMode']>
  fanoutPolicy: NonNullable<EnsembleConfig['fanoutPolicy']>
  maxContinuationHops?: number
  activeGoalStatus: ActiveGoalStatus
  activeRound: EnsembleRoundState
}): ChatRecord {
  return {
    appChatId: id,
    title: id,
    chatKind: 'ensemble',
    provider: 'codex',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    providerMetadata: {
      sideChatSelectedParticipantId: selectedParticipantId
    },
    activeGoal: {
      id: `${id}-goal`,
      objective: 'Keep this chat isolated.',
      status: activeGoalStatus,
      mode: 'taskwraith_steered',
      provider: 'codex',
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z'
    },
    ensemble: {
      enabled: true,
      maxParticipants: 20,
      participants,
      orchestrationMode,
      fanoutPolicy,
      maxContinuationHops,
      activeRound
    },
    messages: [],
    runs: []
  }
}
