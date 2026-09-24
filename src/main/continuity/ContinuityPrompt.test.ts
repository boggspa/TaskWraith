import { describe, expect, it } from 'vitest'
import { composeRunPrompt, type ComposeRunPromptInput } from '../PromptComposition'
import {
  buildEnsembleParticipantPrompt,
  buildEnsembleParticipantPromptProjection
} from '../EnsemblePrompt'
import { createActiveGoal } from '../GoalState'
import type { ChatRecord, EnsembleParticipant } from '../store/types'
import { updateSeatCheckpoint, CONTINUITY_BLOCK_MAX_CHARS } from '../../shared/threadContinuity'
import { buildDelegatedContinuityPrompts, planPromptContinuity } from './ContinuityPrompt'

function fixture(): ChatRecord {
  const chat = {
    appChatId: 'chat',
    provider: 'codex',
    chatKind: 'single',
    title: 'Task',
    messages: [
      { id: 'm', role: 'user', content: 'Fix replay ordering.', timestamp: '2026-09-05T12:00:00Z' }
    ],
    runs: []
  } as unknown as ChatRecord
  return {
    ...chat,
    continuityCheckpoints: updateSeatCheckpoint(chat, {
      seatId: '__solo__',
      expectedRevision: 0,
      text: 'CHECKPOINT: inspect replay ordering next.',
      references: [{ messageId: 'm' }],
      author: { provider: 'codex', runId: 'author', providerSessionId: 'session' },
      now: '2026-09-05T12:01:00Z'
    })
  }
}
function input(chat: ChatRecord): ComposeRunPromptInput {
  return {
    provider: 'codex',
    continuityChat: chat,
    finalPrompt: 'Continue.',
    messages: chat.messages,
    chatContextTurns: 8,
    resumeSessionId: 'session',
    lastCompletedCodexModel: null,
    nextModel: 'gpt-6-astra',
    codexHandoffsApplied: [],
    isGlobalRun: true,
    approvalMode: 'default',
    providerLabel: 'Codex',
    instructionContext: null,
    taskWraithMcpProfileId: 'taskwraith-gateway-solo-v4'
  }
}

describe('checkpoint prompt integration', () => {
  it('adds one bounded block and diagnostic layer, then suppresses a delivered native checkpoint', () => {
    const chat = fixture()
    const baseline = composeRunPrompt({ ...input(chat), continuityChat: undefined })
    const composed = composeRunPrompt(input(chat))
    expect(composed.contextualPrompt).toContain('CHECKPOINT: inspect replay ordering next.')
    expect(composed.contextualPrompt.length - baseline.contextualPrompt.length).toBeLessThanOrEqual(
      CONTINUITY_BLOCK_MAX_CHARS + 2
    )
    expect(composed.envelopeLayers[0]).toMatchObject({
      id: 'continuity_checkpoint',
      state: 'applied'
    })
    const plan = planPromptContinuity({ chat, provider: 'codex', providerSessionId: 'session' })
    if (plan.action !== 'deliver') throw new Error('Expected recovery')
    chat.runs.push({
      runId: 'delivered',
      provider: 'codex',
      providerThreadId: 'session',
      startedAt: '2026-09-05T12:02:00Z',
      endedAt: '2026-09-05T12:03:00Z',
      status: 'success',
      continuityCheckpointDelivery: plan.delivery
    })
    expect(composeRunPrompt(input(chat)).contextualPrompt).not.toContain('CHECKPOINT:')
    chat.messages.push({
      id: 'compact',
      role: 'system',
      content: 'Context compacted',
      timestamp: '2026-09-05T12:04:00Z',
      metadata: {
        kind: 'contextCompaction',
        contextCompaction: { kind: 'completed', telemetry: { provider: 'codex' } }
      }
    })
    expect(composeRunPrompt(input(chat)).contextualPrompt).toContain('CHECKPOINT:')
  })
  it('does not contaminate slash commands or context-isolated prompts', () => {
    const chat = fixture()
    expect(
      composeRunPrompt({ ...input(chat), verbatimPrompt: true, finalPrompt: '/compact' })
        .contextualPrompt
    ).toBe('/compact')
    expect(
      composeRunPrompt({ ...input(chat), continuityIsolated: true }).contextualPrompt
    ).not.toContain('CHECKPOINT:')
  })
  it.each(['codex', 'claude'] as const)(
    'prepares checkpoint recovery if a delegated %s native session is discarded',
    (provider) => {
      const chat = fixture()
      const plan = planPromptContinuity({ chat, provider, providerSessionId: 'session' })
      if (plan.action !== 'deliver') throw new Error('Expected recovery')
      chat.runs.push({
        runId: 'delivered',
        provider,
        providerThreadId: 'session',
        startedAt: '2026-09-05T12:02:00Z',
        endedAt: '2026-09-05T12:03:00Z',
        status: 'success',
        continuityCheckpointDelivery: plan.delivery
      })
      const args = { provider, subThread: chat, prompt: 'Continue.', resumeSessionId: 'session' }
      const prompts = buildDelegatedContinuityPrompts(args)
      expect(prompts.prompt).toBe('Continue.')
      expect(prompts.resumeFallbackPrompt).toContain('CHECKPOINT: inspect replay ordering next.')
      expect(buildDelegatedContinuityPrompts({ ...args, prompt: '/compact' })).toEqual({
        prompt: '/compact'
      })
    }
  )
  it('keeps archived tool output outside host-fed prompts', () => {
    const chat = fixture()
    chat.messages.push({
      id: 'tool-row',
      role: 'assistant',
      timestamp: '2026-09-05T12:02:00Z',
      content: 'The test command completed.',
      toolActivities: [
        {
          id: 'tool',
          toolName: 'run_shell_command',
          displayName: 'Test',
          category: 'shell',
          status: 'success',
          rawResultEvent: 'RAW_TOOL_SENTINEL'.repeat(10000)
        }
      ]
    })
    const composed = composeRunPrompt({
      ...input(chat),
      provider: 'mistral',
      providerLabel: 'Mistral',
      resumeSessionId: undefined
    })
    expect(composed.contextualPrompt).toContain('CHECKPOINT:')
    expect(composed.contextualPrompt).toContain('The test command completed.')
    expect(composed.contextualPrompt).not.toContain('RAW_TOOL_SENTINEL')
  })
  it('restores only the current Ensemble seat’s private note', () => {
    const chat = fixture()
    const participant: EnsembleParticipant = {
      id: 'seat',
      provider: 'codex',
      role: 'Worker',
      enabled: true,
      order: 1,
      instructions: '',
      permissionPresetId: 'read_only'
    }
    chat.chatKind = 'ensemble'
    chat.ensemble = { enabled: true, maxParticipants: 2, participants: [participant] }
    chat.continuityCheckpoints = updateSeatCheckpoint(chat, {
      seatId: 'seat',
      expectedRevision: 0,
      text: 'SEAT_PRIVATE_NOTE',
      references: [],
      author: { provider: 'codex', runId: 'seat-author' },
      now: '2026-09-05T12:02:00Z'
    })
    const prompt = buildEnsembleParticipantPrompt({
      chat,
      config: chat.ensemble,
      participant,
      roundId: 'round',
      currentPrompt: 'Continue.'
    })
    expect(prompt).toContain('SEAT_PRIVATE_NOTE')
    expect(prompt).not.toContain('CHECKPOINT:')
  })
  it.each(['ollama', 'antigravity'] as const)(
    'retains the current goal and exact checkpoint inside a crowded %s capsule',
    (provider) => {
      const chat = fixture()
      const participant: EnsembleParticipant = {
        id: 'seat',
        provider,
        role: 'Worker',
        enabled: true,
        order: 1,
        instructions: 'Follow the current assignment.',
        permissionPresetId: 'read_only'
      }
      chat.chatKind = 'ensemble'
      chat.ensemble = { enabled: true, maxParticipants: 2, participants: [participant] }
      chat.activeGoal = createActiveGoal(provider, 'NEW_USER_GOAL', {
        now: new Date('2026-09-05T12:00:00Z'),
        allowProviderNative: false
      })
      const note = `OLDER_CHECKPOINT_GOAL ${'evidence '.repeat(160)}END_CONSTRAINT`
      chat.continuityCheckpoints = updateSeatCheckpoint(chat, {
        seatId: 'seat',
        expectedRevision: 0,
        text: note,
        references: [],
        author: { provider, runId: 'seat-author' },
        now: '2026-09-05T12:02:00Z'
      })
      chat.messages.push({
        id: 'old-history',
        role: 'assistant',
        content: 'OPTIONAL_HISTORY '.repeat(1000),
        timestamp: '2026-09-05T12:03:00Z'
      })
      const projection = buildEnsembleParticipantPromptProjection({
        chat,
        config: chat.ensemble,
        participant,
        roundId: 'round',
        currentPrompt: 'Continue the current assignment.',
        dynamicStateSnapshot: { version: 'crowded', block: 'OPTIONAL_STATE '.repeat(1000) }
      })
      expect(projection.prompt).toContain('NEW_USER_GOAL')
      expect(projection.prompt).toContain(note)
      expect(projection.prompt.length).toBeLessThanOrEqual(provider === 'ollama' ? 8000 : 20000)
      expect(projection.transcriptAttribution.continuityCheckpoint).toBe('included')
      expect(JSON.stringify(projection.transcriptAttribution)).not.toContain(
        'OLDER_CHECKPOINT_GOAL'
      )
    }
  )
})
