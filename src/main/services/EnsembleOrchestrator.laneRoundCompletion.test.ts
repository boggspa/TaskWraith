import { describe, expect, it, vi } from 'vitest'
import { EnsembleOrchestrator } from './EnsembleOrchestrator'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { AppSettings, ChatRecord, EnsembleParticipant } from '../store/types'

/*
 * Foreground ownership vs detached fan-out lanes — regression coverage for the
 * "caller hands off while its ensemble_fanout lane is still working" hole.
 *
 * `ensemble_fanout` returns after dispatch (waitForCompletion: false) so the
 * calling participant does not time out while its lanes work. That means the
 * serial loop used to advance immediately after the caller's terminal response,
 * allowing the next participant to overlap the still-streaming lane. That blurs
 * who owns the handoff and lets a yield/@mention route escape before the fan-out
 * result returns to its caller.
 *
 * Expected semantics:
 *   - the participant that launched a reader/writer fan-out retains foreground
 *     ownership until every lane in that pass settles;
 *   - the serial queue resumes only after the lane result has returned;
 *   - cancellation is NOT deferred — Stop closes the round immediately even
 *     with lanes in flight (they are finalized as cancelled).
 *
 * These tests drive the real orchestrator with real (250ms debounced) flush
 * timers, mirroring the fanoutTranscriptOrder harness, so each step sleeps
 * past the debounce before asserting.
 */

const FLUSH_MS = 320

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function participant(
  id: string,
  provider: EnsembleParticipant['provider'],
  role: string,
  order: number,
  permissionPresetId: 'workspace_write' | 'read_only'
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
    title: 'Lane round completion',
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
  }
}

function makeSettings(): AppSettings {
  return {
    storeLocalChatHistory: true,
    storeRawEvents: false,
    ensembleModeEnabled: true,
    chatContextTurns: 8
  } as unknown as AppSettings
}

function makeHarness(participants: EnsembleParticipant[]) {
  let chat = makeChat(participants)
  let counter = 0
  const dispatched: AgentRunPayload[] = []
  const orchestrator = new EnsembleOrchestrator({
    getChat: () => chat,
    saveChat: (next) => {
      chat = next
    },
    getSettings: makeSettings,
    dispatch: vi.fn(async (payload: AgentRunPayload) => {
      dispatched.push(payload)
      return { dispatched: true, appRunId: payload.appRunId || '' }
    }),
    cancelRun: vi.fn(async () => true),
    createRunId: (provider) => `${provider}-run-${++counter}`,
    now: () => counter,
    nowIso: () => `2026-05-24T00:00:0${counter}.000Z`
  })
  return {
    get chat() {
      return chat
    },
    dispatched,
    orchestrator
  }
}

type Harness = ReturnType<typeof makeHarness>

function stream(harness: Harness, index: number, text: string): void {
  const payload = harness.dispatched[index]
  harness.orchestrator.handleProviderOutput(
    payload.provider,
    { appRunId: payload.appRunId, appChatId: 'ensemble-chat' },
    { type: 'content', text }
  )
}

function complete(harness: Harness, index: number): void {
  const payload = harness.dispatched[index]
  harness.orchestrator.handleProviderOutput(
    payload.provider,
    { appRunId: payload.appRunId, appChatId: 'ensemble-chat' },
    { type: 'result', status: 'success' }
  )
}

function rowIndex(harness: Harness, text: string): number {
  return harness.chat.messages.findIndex(
    (message) => typeof message.content === 'string' && message.content.includes(text)
  )
}

/**
 * Drive a round to the "caller completed, one owned lane still running" state
 * shared by both tests. Returns with dispatched = [lead, reviewerLane]; the
 * Researcher must not start until the Reviewer lane settles.
 */
async function completeCallerWithActiveLane(harness: Harness): Promise<void> {
  harness.orchestrator.startRound({
    chatId: 'ensemble-chat',
    prompt: 'Lead fans out, then the serial queue drains first.',
    event: { sender: {} as Electron.WebContents }
  })
  await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
  expect(harness.dispatched[0].provider).toBe('codex')

  stream(harness, 0, 'BOSS-INTRO.')
  const fanout = await harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
    targets: ['Reviewer'],
    prompt: 'Keep auditing after my turn ends.'
  })
  expect(fanout.ok).toBe(true)
  await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
  expect(harness.dispatched[1].provider).toBe('claude')

  // The lane starts working; the Lead finishes its serial turn.
  stream(harness, 1, 'LANE-WORKING.')
  complete(harness, 0)
  await sleep(FLUSH_MS)
  expect(harness.dispatched).toHaveLength(2)
}

describe('foreground ownership vs detached fan-out lanes', () => {
  it(
    'waits for the caller\'s detached fan-out lane before advancing serial rotation',
    { timeout: 20_000 },
    async () => {
      const harness = makeHarness([
        participant('codex', 'codex', 'Lead', 1, 'workspace_write'),
        participant('claude', 'claude', 'Reviewer', 2, 'read_only'),
        participant('gemini', 'gemini', 'Researcher', 3, 'workspace_write')
      ])
      await completeCallerWithActiveLane(harness)

      // The Reviewer lane is still non-terminal: the round stays open and the
      // Researcher has not started.
      const roundWhileLaneActive = harness.chat.ensemble!.activeRound!
      expect(roundWhileLaneActive.status).toBe('running')
      expect(roundWhileLaneActive.endedAt).toBeUndefined()
      expect(harness.dispatched).toHaveLength(2)

      // The lane keeps producing output after the serial drain; it must
      // still land in the transcript of the open round.
      stream(harness, 1, ' LANE-LATE-FINDING.')
      await sleep(FLUSH_MS)
      expect(rowIndex(harness, 'LANE-LATE-FINDING.')).toBeGreaterThanOrEqual(0)
      expect(harness.chat.ensemble!.activeRound!.status).toBe('running')

      // The lane terminal returns ownership to the caller and only then lets
      // the serial Researcher start.
      complete(harness, 1)
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
      expect(harness.dispatched[2].provider).toBe('gemini')
      stream(harness, 2, 'RESEARCHER-NOTE.')
      await sleep(FLUSH_MS)
      expect(rowIndex(harness, 'RESEARCHER-NOTE.')).toBeGreaterThanOrEqual(0)
      complete(harness, 2)
      await vi.waitFor(() => {
        expect(harness.chat.ensemble!.activeRound!.status).toBe('completed')
      })
      expect(harness.chat.ensemble!.activeRound!.endedAt).toBeTruthy()
      const lanes = Object.values(harness.chat.ensemble!.activeRound!.lanes || {})
      expect(lanes).toHaveLength(1)
      expect(lanes[0].status).toBe('completed')
    }
  )

  it(
    'cancellation still closes the round immediately while a lane is active',
    { timeout: 20_000 },
    async () => {
      const harness = makeHarness([
        participant('codex', 'codex', 'Lead', 1, 'workspace_write'),
        participant('claude', 'claude', 'Reviewer', 2, 'read_only'),
        participant('gemini', 'gemini', 'Researcher', 3, 'workspace_write')
      ])
      await completeCallerWithActiveLane(harness)

      // Held-handoff state: round open, lane active, next foreground seat idle.
      expect(harness.chat.ensemble!.activeRound!.status).toBe('running')
      expect(harness.dispatched).toHaveLength(2)

      // Stop must NOT wait for the lane — cancelled rounds finish now.
      const cancelled = await harness.orchestrator.cancelRound('ensemble-chat')
      expect(cancelled).toBe(true)
      expect(harness.chat.ensemble!.activeRound!.status).toBe('cancelled')
      const lanes = Object.values(harness.chat.ensemble!.activeRound!.lanes || {})
      expect(lanes).toHaveLength(1)
      expect(lanes[0].status).toBe('cancelled')
      expect(harness.dispatched).toHaveLength(2)
    }
  )
})
