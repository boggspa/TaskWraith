import { describe, expect, it } from 'vitest'
import { composeRunPrompt, type ComposeRunPromptInput } from '../PromptComposition'
import { buildEnsembleParticipantPrompt } from '../EnsemblePrompt'
import type { ChatRecord, EnsembleParticipant } from '../store/types'
import { updateSeatCheckpoint, CONTINUITY_BLOCK_MAX_CHARS } from '../../shared/threadContinuity'
import { planPromptContinuity } from './ContinuityPrompt'

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
  it('keeps archived tool output outside host-fed prompts', () => {
    const chat = fixture()
    chat.messages.push({
      id: 'tool-row',
      role: 'tool',
      timestamp: '2026-09-05T12:02:00Z',
      content: 'RAW_TOOL_SENTINEL',
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
})
