import { describe, expect, it, vi } from 'vitest'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { AppSettings, ChatRecord, EnsembleParticipant } from '../store/types'
import { EnsembleOrchestrator } from './EnsembleOrchestrator'

const CHAT_ID = 'ensemble-rewind-chat'

function participant(
  id: string,
  provider: EnsembleParticipant['provider'],
  order: number,
  patch: Partial<EnsembleParticipant> = {}
): EnsembleParticipant {
  return {
    id,
    provider,
    enabled: true,
    role: 'Worker',
    instructions: 'Answer the user.',
    order,
    model: `${provider}-model`,
    permissionPresetId: 'workspace_write',
    ...patch
  }
}

function makeChat(): ChatRecord {
  const roster = [
    participant('codex-seat', 'codex', 1),
    participant('claude-seat', 'claude', 2),
    participant('mistral-seat', 'mistral', 3)
  ]
  return {
    appChatId: CHAT_ID,
    chatKind: 'ensemble',
    scope: 'workspace',
    provider: 'codex',
    title: 'Rewind resume',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ensemble: {
      enabled: true,
      maxParticipants: roster.length,
      participants: roster
    }
  }
}

function makeHarness() {
  let chat = makeChat()
  let counter = 0
  const dispatched: AgentRunPayload[] = []
  const cancelRun = vi.fn(async () => true)
  const probeParticipant = vi.fn(async () => ({ reachable: true }))
  const orchestrator = new EnsembleOrchestrator({
    getChat: () => chat,
    saveChat: (next) => {
      chat = next
    },
    getSettings: () =>
      ({
        storeLocalChatHistory: true,
        storeRawEvents: false,
        ensembleModeEnabled: true,
        chatContextTurns: 8
      }) as AppSettings,
    dispatch: vi.fn(async (payload: AgentRunPayload) => {
      dispatched.push(payload)
      return { dispatched: true, appRunId: payload.appRunId || '' }
    }),
    cancelRun,
    probeParticipant,
    createRunId: (provider) => `${provider}-run-${++counter}`,
    now: () => counter,
    nowIso: () => `2026-09-03T03:00:0${counter}.000Z`
  })
  return {
    get chat() {
      return chat
    },
    cancelRun,
    dispatched,
    orchestrator,
    probeParticipant
  }
}

type Harness = ReturnType<typeof makeHarness>

// Continuous-only rounds auto-continue after the roster drains; a completed
// goal is the established kill-switch that lets a drained round complete
// (same device as EnsembleOrchestrator.test.ts / .midRunSteering.test.ts).
function seedCompletedGoal(harness: Harness): void {
  harness.chat.activeGoal = {
    id: 'goal-rewind-complete',
    objective: 'Already satisfied — the round may close when the roster drains.',
    status: 'completed',
    mode: 'taskwraith_steered',
    provider: 'codex',
    createdAt: '2026-09-03T03:00:00.000Z',
    updatedAt: '2026-09-03T03:00:00.000Z'
  }
}

function complete(harness: Harness, index: number): void {
  const payload = harness.dispatched[index]
  harness.orchestrator.handleProviderOutput(
    payload.provider,
    { appRunId: payload.appRunId, appChatId: CHAT_ID },
    { type: 'result', status: 'success' }
  )
}

function userMessageCount(harness: Harness): number {
  return harness.chat.messages.filter((message) => message.role === 'user').length
}

describe('EnsembleOrchestrator rewind-from-message restart', () => {
  it('resumes at the captured seat, skips the preamble, and does not echo the edited prompt', async () => {
    const harness = makeHarness()
    seedCompletedGoal(harness)
    const started = harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Initial ensemble prompt.',
      event: { sender: {} as Electron.WebContents }
    })
    expect(started.status).toBe('started')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('codex-seat')
    // The NORMAL opening round runs the preamble: every seat was probed.
    expect(harness.probeParticipant).toHaveBeenCalledTimes(3)
    expect(userMessageCount(harness)).toBe(1)

    // codex-seat finishes; claude-seat becomes the active seat.
    complete(harness, 0)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    expect(harness.dispatched[1].ensembleRun?.participantId).toBe('claude-seat')
    // The renderer's rewind capture reads exactly this persisted field BEFORE
    // cancelling (cancel destroys it).
    expect(harness.chat.ensemble?.activeRound?.activeParticipantId).toBe('claude-seat')

    // Rewind flow: cancel, then re-dispatch the edited steer with the
    // captured resume seat and echo suppression.
    await harness.orchestrator.cancelRound(CHAT_ID, 'edit & resend from here')
    const rewound = harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Edited steer text.',
      event: { sender: {} as Electron.WebContents },
      mode: 'steer',
      rewind: { resumeFromParticipantId: 'claude-seat', suppressPromptEcho: true }
    })
    expect(rewound.status).toBe('started')
    expect(rewound.roundId).toBeTruthy()
    expect(rewound.roundId).not.toBe(started.roundId)

    // No prompt echo: the anchor row was rewritten in place by the transcript
    // mutation, so the replacement round must not append a second user row.
    expect(userMessageCount(harness)).toBe(1)
    // No preamble on the replacement round: no seat is probed again.
    expect(harness.probeParticipant).toHaveBeenCalledTimes(3)

    // Rotation resumes AT the captured seat, then continues with the seats
    // that were still waiting — codex-seat already spoke and must not re-run.
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
    expect(harness.dispatched[2].ensembleRun?.participantId).toBe('claude-seat')
    expect(harness.dispatched[2].ensembleRun?.roundId).toBe(rewound.roundId)
    complete(harness, 2)
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4))
    expect(harness.dispatched[3].ensembleRun?.participantId).toBe('mistral-seat')
    complete(harness, 3)
    await vi.waitFor(() => {
      expect(harness.chat.ensemble?.activeRound?.status).toBe('completed')
    })
    expect(
      harness.dispatched.filter((payload) => payload.ensembleRun?.roundId === rewound.roundId)
    ).toHaveLength(2)
  })

  it('fails soft to the full roster order when the captured seat is gone', async () => {
    const harness = makeHarness()
    seedCompletedGoal(harness)
    const started = harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Initial ensemble prompt.',
      event: { sender: {} as Electron.WebContents }
    })
    expect(started.status).toBe('started')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    await harness.orchestrator.cancelRound(CHAT_ID, 'edit & resend from here')

    const rewound = harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Edited steer text.',
      event: { sender: {} as Electron.WebContents },
      mode: 'steer',
      rewind: { resumeFromParticipantId: 'ghost-seat', suppressPromptEcho: true }
    })
    expect(rewound.status).toBe('started')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
    // Unknown id: a wider resume from the roster top beats a thrown error
    // mid-gesture.
    expect(harness.dispatched[1].ensembleRun?.participantId).toBe('codex-seat')
    // Echo suppression is independent of the resume anchor.
    expect(userMessageCount(harness)).toBe(1)
    expect(harness.probeParticipant).toHaveBeenCalledTimes(3)
  })

  it('ignores rewind hints on a normal send', async () => {
    const harness = makeHarness()
    seedCompletedGoal(harness)
    const started = harness.orchestrator.startRound({
      chatId: CHAT_ID,
      prompt: 'Fresh normal prompt.',
      event: { sender: {} as Electron.WebContents },
      // A normal mode must never carry rewind hints; even a forged one is
      // dropped so the round keeps its preamble and prompt row.
      rewind: { resumeFromParticipantId: 'claude-seat', suppressPromptEcho: true }
    })
    expect(started.status).toBe('started')
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
    expect(harness.dispatched[0].ensembleRun?.participantId).toBe('codex-seat')
    expect(harness.probeParticipant).toHaveBeenCalledTimes(3)
    expect(userMessageCount(harness)).toBe(1)
  })
})
