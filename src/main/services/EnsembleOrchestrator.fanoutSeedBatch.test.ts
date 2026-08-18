/**
 * Perf-epic T3a remainder: dispatching an N-lane wave must not persist N
 * separate full saves at seed time. Every lane's ChatRun + lane record ride
 * ONE composed save through the same in-memory overlay the per-chat flush
 * scheduler already uses — the fan-out seed was the last per-lane multiplier
 * on the save path.
 */
import { describe, expect, it, vi } from 'vitest'
import { EnsembleOrchestrator } from './EnsembleOrchestrator'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { AppSettings, ChatRecord, EnsembleParticipant } from '../store/types'

function participant(
  id: string,
  provider: EnsembleParticipant['provider'],
  role: string,
  order: number,
  permissionPresetId: EnsembleParticipant['permissionPresetId']
): EnsembleParticipant {
  return {
    id,
    provider,
    enabled: true,
    role,
    instructions: `${role}.`,
    order,
    model: `${provider}-model`,
    permissionPresetId
  }
}

function makeChat(participants: EnsembleParticipant[]): ChatRecord {
  return {
    appChatId: 'ensemble-chat',
    chatKind: 'ensemble',
    scope: 'workspace',
    provider: 'claude',
    title: 'Fan-out seed batching',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ensemble: {
      enabled: true,
      maxParticipants: participants.length,
      fanoutPolicy: 'read_only',
      participants
    }
  } as unknown as ChatRecord
}

function makeSettings(): AppSettings {
  return {
    storeLocalChatHistory: true,
    storeRawEvents: false,
    ensembleModeEnabled: true,
    chatContextTurns: 8
  } as unknown as AppSettings
}

describe('fan-out seed save batching', () => {
  it('lands every lane of a wave in one composed save instead of one save per lane', async () => {
    let chat = makeChat([
      participant('codex', 'codex', 'Lead', 1, 'workspace_write'),
      participant('claude', 'claude', 'Reviewer', 2, 'workspace_write'),
      participant('grok', 'grok', 'Researcher', 3, 'workspace_write'),
      participant('kimi', 'kimi', 'Auditor', 4, 'workspace_write')
    ])
    let counter = 0
    const dispatched: AgentRunPayload[] = []
    // How many NEW lane runs each save persisted. Per-lane seeding shows
    // [1, 1, 1]; the batched wave shows [3].
    let previousLaneRunCount = 0
    const laneRunGrowths: number[] = []
    const orchestrator = new EnsembleOrchestrator({
      getChat: () => chat,
      saveChat: (next: ChatRecord) => {
        chat = next
        const laneRunCount = (next.runs || []).filter((run) => run.ensembleLaneId).length
        if (laneRunCount > previousLaneRunCount) {
          laneRunGrowths.push(laneRunCount - previousLaneRunCount)
        }
        previousLaneRunCount = laneRunCount
      },
      getSettings: makeSettings,
      dispatch: vi.fn(async (payload: AgentRunPayload) => {
        dispatched.push(payload)
        return { dispatched: true, appRunId: payload.appRunId || '' }
      }),
      cancelRun: vi.fn(async () => true),
      createRunId: (provider) => `${provider}-run-${++counter}`,
      now: () => counter,
      nowIso: () => `2026-08-18T00:00:0${counter % 10}.000Z`
    } as unknown as ConstructorParameters<typeof EnsembleOrchestrator>[0])

    orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Lead dispatches one three-lane wave.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(dispatched).toHaveLength(1))
    const boss = dispatched[0].appRunId

    const wave = await orchestrator.fanoutForRun(boss, {
      targets: ['Reviewer', 'Researcher', 'Auditor'],
      prompt: 'One wave, three lanes.'
    })
    expect(wave.ok).toBe(true)
    await vi.waitFor(() => expect(dispatched).toHaveLength(4))

    // Every lane is durably present…
    expect(chat.runs.filter((run) => run.ensembleLaneId)).toHaveLength(3)
    expect(Object.keys(chat.ensemble?.activeRound?.lanes || {})).toHaveLength(3)
    // …and they arrived in one composed save.
    expect(laneRunGrowths).toEqual([3])
  })
})
