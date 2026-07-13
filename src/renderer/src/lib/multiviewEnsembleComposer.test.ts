import { describe, expect, it } from 'vitest'
import type {
  ActiveGoalStatus,
  ChatRecord,
  EnsembleConfig,
  EnsembleParticipant,
  EnsembleRoundState,
  ProviderId
} from '../../../main/store/types'
import {
  buildMultiviewEnsembleComposerProjection,
  mergeEnsembleQueuedPromptMutationResult,
  pruneMultiviewEnsembleSelectionOwnership
} from './multiviewEnsembleComposer'

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
      [],
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
    expect(first.currentOrchestrationMode).toBe('continuous')
    expect(first.activeOrchestrationMode).toBe('turn_bound')
    expect(second.currentOrchestrationMode).toBe('turn_bound')
    expect(second.activeOrchestrationMode).toBe('continuous')
    expect(first.currentFanoutPolicy).toBe('all')
    expect(first.activeFanoutPolicy).toBe('off')
    expect(second.currentFanoutPolicy).toBe('off')
    expect(second.activeFanoutPolicy).toBe('locked_writers_with_boss')
    expect(first.currentConcurrentMode).toBe(true)
    expect(first.activeConcurrentMode).toBe(false)
    expect(second.currentConcurrentMode).toBe(false)
    expect(second.activeConcurrentMode).toBe(true)
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
    expect(projection.activeOrchestrationMode).toBe('turn_bound')
    expect(projection.activeFanoutPolicy).toBe('read_only')
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
