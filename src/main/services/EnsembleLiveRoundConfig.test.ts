import { describe, expect, it, vi } from 'vitest'
import {
  EnsembleOrchestrator,
  type EnsembleLiveRoundConfigUpdateInput
} from './EnsembleOrchestrator'
import type { AppSettings, ChatRecord } from '../store/types'
import { buildUserEnsembleRosterPresetApplyPlan } from '../EnsembleRosterPresetApply'

function liveChat(): ChatRecord {
  return {
    appChatId: 'ensemble-chat',
    chatKind: 'ensemble',
    scope: 'workspace',
    title: 'Live controls',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ensemble: {
      enabled: true,
      maxParticipants: 2,
      orchestrationMode: 'continuous',
      fanoutPolicy: 'all',
      concurrentModeEnabled: true,
      maxContinuationHops: 12,
      participants: [],
      activeRound: {
        roundId: 'round-1',
        status: 'running',
        prompt: 'Keep working.',
        startedAt: '2026-07-29T00:00:00.000Z',
        orchestrationMode: 'continuous',
        fanoutPolicy: 'all',
        concurrentMode: true,
        continuationHops: 3,
        maxContinuationHops: 12,
        activeParticipantId: 'active-seat',
        participants: [
          {
            participantId: 'active-seat',
            provider: 'codex',
            role: 'Active',
            order: 1,
            status: 'running'
          }
        ]
      }
    }
  }
}

function makeHarness() {
  let chat = liveChat()
  const saveChat = vi.fn((next: ChatRecord) => {
    chat = next
  })
  const cancelRun = vi.fn(async () => true)
  const orchestrator = new EnsembleOrchestrator({
    getChat: () => chat,
    saveChat,
    getSettings: () => ({}) as AppSettings,
    dispatch: async () => ({ dispatched: true, appRunId: 'unused' }),
    cancelRun,
    createRunId: () => 'unused',
    now: () => 42,
    nowIso: () => '2026-07-29T00:00:42.000Z'
  })
  const runtime = {
    roundId: 'round-1',
    cancelled: false,
    orchestrationMode: 'continuous' as const,
    fanoutPolicy: 'all' as const,
    concurrentMode: true,
    maxContinuationHops: 12,
    continuationLimitNotified: true,
    continuationLimitPending: true
  }
  const internals = orchestrator as unknown as {
    roundsByChatId: Map<string, unknown>
    runsByRunId: Map<string, unknown>
  }
  internals.roundsByChatId.set(chat.appChatId, runtime)
  return {
    get chat() {
      return chat
    },
    cancelRun,
    internals,
    orchestrator,
    runtime,
    saveChat
  }
}

describe('EnsembleOrchestrator.updateLiveRoundConfig', () => {
  it('queues an explicit user roster on the live round boundary', () => {
    const harness = makeHarness()
    const participant = {
      id: 'next-boss',
      provider: 'codex' as const,
      enabled: true,
      role: 'Next Boss',
      instructions: '',
      order: 1,
      linkedProviderSessionId: null
    }
    const plan = buildUserEnsembleRosterPresetApplyPlan({
      preset: {
        id: 'next-roster',
        name: 'Next roster',
        createdAt: 1,
        updatedAt: 1,
        orchestrationMode: 'turn_bound',
        maxParticipants: 2,
        participants: [
          {
            provider: 'codex',
            enabled: true,
            role: 'Next Boss',
            instructions: '',
            order: 1,
            isBossman: true
          }
        ]
      },
      participants: [participant],
      bossmanParticipantId: participant.id,
      queuedAt: '2026-07-29T00:00:41.000Z'
    })

    expect(harness.orchestrator.applyOrQueueUserRosterPreset('ensemble-chat', plan)).toEqual({
      ok: true,
      deferred: true
    })
    expect(harness.chat.providerMetadata).toMatchObject({
      pendingEnsembleRosterPresetApply: {
        presetId: 'next-roster',
        authority: 'user'
      }
    })
    expect(harness.chat.ensemble?.activeRosterPresetId).toBeUndefined()
  })

  it('updates the live runtime and durable round without interrupting an active execution', async () => {
    const harness = makeHarness()
    const input: EnsembleLiveRoundConfigUpdateInput = {
      chatId: 'ensemble-chat',
      orchestrationMode: 'turn_bound',
      fanoutPolicy: 'off',
      maxContinuationHops: 1
    }

    expect(harness.orchestrator.updateLiveRoundConfig(input)).toEqual({
      ok: true,
      orchestrationMode: 'turn_bound',
      fanoutPolicy: 'off',
      maxContinuationHops: 1,
      activeRoundUpdated: true
    })
    expect(harness.runtime).toMatchObject({
      orchestrationMode: 'turn_bound',
      fanoutPolicy: 'off',
      concurrentMode: undefined,
      maxContinuationHops: 1,
      continuationLimitNotified: false,
      continuationLimitPending: false
    })
    expect(harness.chat.ensemble).toMatchObject({
      orchestrationMode: 'turn_bound',
      fanoutPolicy: 'off',
      concurrentModeEnabled: false,
      maxContinuationHops: 1
    })
    expect(harness.chat.ensemble?.activeRound).toMatchObject({
      roundId: 'round-1',
      orchestrationMode: 'turn_bound',
      fanoutPolicy: 'off',
      concurrentMode: undefined,
      maxContinuationHops: 1
    })
    expect(harness.chat.messages).toEqual([
      expect.objectContaining({
        role: 'system',
        content: 'User changed max handoff turns from 12 to 1.',
        metadata: {
          kind: 'ensembleContinuationHopsChange',
          ensembleRoundId: 'round-1',
          continuationHopsChange: {
            before: 12,
            after: 1,
            actor: 'user',
            changedAt: '2026-07-29T00:00:42.000Z'
          }
        }
      })
    ])
    expect(harness.saveChat).toHaveBeenCalledTimes(1)
    expect(harness.cancelRun).not.toHaveBeenCalled()

    // The next fan-out tool admission observes the runtime mutation. The
    // existing caller is still active, but no new peer lane is admitted.
    harness.internals.runsByRunId.set('caller-run', {
      chatId: 'ensemble-chat',
      roundId: 'round-1',
      runId: 'caller-run',
      participant: {
        id: 'caller',
        provider: 'codex',
        enabled: true,
        role: 'Caller',
        instructions: '',
        order: 1,
        permissionPresetId: 'workspace_write'
      },
      status: 'running'
    })
    await expect(
      harness.orchestrator.fanoutForRun('caller-run', {
        mode: 'read_only',
        prompt: 'Inspect the current state.'
      })
    ).resolves.toMatchObject({ ok: false, error: 'not_authorized' })
  })

  it('persists a running round update for recovery even when no runtime is resident', () => {
    const harness = makeHarness()
    harness.internals.roundsByChatId.clear()

    expect(
      harness.orchestrator.updateLiveRoundConfig({
        chatId: 'ensemble-chat',
        fanoutPolicy: 'read_only'
      })
    ).toMatchObject({ ok: true, fanoutPolicy: 'read_only', activeRoundUpdated: true })
    expect(harness.chat.ensemble?.activeRound).toMatchObject({
      fanoutPolicy: 'read_only',
      concurrentMode: true
    })
  })

  it('uses the renderer before-value when its optimistic save wins the IPC race', () => {
    const harness = makeHarness()
    harness.chat.ensemble!.maxContinuationHops = 76
    harness.chat.ensemble!.activeRound!.maxContinuationHops = 76

    expect(
      harness.orchestrator.updateLiveRoundConfig({
        chatId: 'ensemble-chat',
        maxContinuationHops: 76,
        previousMaxContinuationHops: 12
      })
    ).toMatchObject({ ok: true, maxContinuationHops: 76 })
    expect(harness.chat.messages.at(-1)?.metadata).toMatchObject({
      kind: 'ensembleContinuationHopsChange',
      ensembleRoundId: 'round-1',
      continuationHopsChange: {
        before: 12,
        after: 76,
        actor: 'user'
      }
    })
  })

  it('persists an idle user change without assigning it to a completed round', () => {
    const harness = makeHarness()
    delete harness.chat.ensemble!.activeRound
    harness.internals.roundsByChatId.clear()

    expect(
      harness.orchestrator.updateLiveRoundConfig({
        chatId: 'ensemble-chat',
        maxContinuationHops: 76,
        previousMaxContinuationHops: 12
      })
    ).toMatchObject({
      ok: true,
      maxContinuationHops: 76,
      activeRoundUpdated: false
    })
    expect(harness.chat.messages.at(-1)?.metadata).toMatchObject({
      kind: 'ensembleContinuationHopsChange',
      continuationHopsChange: {
        before: 12,
        after: 76,
        actor: 'user'
      }
    })
    expect(harness.chat.messages.at(-1)?.metadata).not.toHaveProperty('ensembleRoundId')
    expect(harness.saveChat).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed values without changing the chat or runtime', () => {
    const harness = makeHarness()

    expect(
      harness.orchestrator.updateLiveRoundConfig({
        chatId: 'ensemble-chat',
        fanoutPolicy: 'not-a-policy' as never
      })
    ).toMatchObject({ ok: false, error: 'invalid_config' })
    expect(harness.runtime.fanoutPolicy).toBe('all')
    expect(harness.chat.ensemble?.fanoutPolicy).toBe('all')
    expect(harness.saveChat).not.toHaveBeenCalled()
  })
})
