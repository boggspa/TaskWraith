import { describe, expect, it, vi } from 'vitest'
import { EnsembleOrchestrator } from './EnsembleOrchestrator'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { AppSettings, ChatRecord, EnsembleParticipant } from '../store/types'

/*
 * Round completion vs detached fan-out lanes — regression coverage for the
 * "serial queue drains while an ensemble_fanout lane is still working" hole.
 *
 * `ensemble_fanout` returns after dispatch (waitForCompletion: false) so the
 * calling participant does not time out while its lanes work. That means the
 * serial loop can fully drain — every serial participant terminal — while a
 * detached lane is still streaming. Closing the round at that instant stamps
 * `endedAt`, derives the blackboard, and flips the renderer to "round
 * finished" while lane output is still landing in the transcript.
 *
 * Expected semantics:
 *   - an active (non-terminal) lane defers round completion; the last lane
 *     terminal closes the round through the same drain tail (queued-prompt
 *     chaining included);
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
 * Drive a round to the "serial queue drained, one detached lane still
 * running" state shared by both tests: the Lead fans out to the Reviewer
 * (detached), the serial loop advances past the fanned-out Reviewer to the
 * Researcher, and both serial participants complete while the Reviewer lane
 * keeps streaming. Returns with dispatched = [lead, reviewerLane, researcher].
 */
async function drainSerialQueueWithActiveLane(harness: Harness): Promise<void> {
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

  // Serial loop skips the fanned-out Reviewer and advances to the Researcher.
  await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
  expect(harness.dispatched[2].provider).toBe('gemini')
  stream(harness, 2, 'RESEARCHER-NOTE.')

  // The last serial participant completes — the queue is drained while the
  // Reviewer lane (index 1) is still running.
  complete(harness, 2)
  await sleep(FLUSH_MS)
}

describe('round completion vs detached fan-out lanes', () => {
  it(
    'defers round completion while a detached fan-out lane is still active',
    { timeout: 20_000 },
    async () => {
      const harness = makeHarness([
        participant('codex', 'codex', 'Lead', 1, 'workspace_write'),
        participant('claude', 'claude', 'Reviewer', 2, 'read_only'),
        participant('gemini', 'gemini', 'Researcher', 3, 'workspace_write')
      ])
      await drainSerialQueueWithActiveLane(harness)

      // The Reviewer lane is still non-terminal: the round must stay open.
      const roundWhileLaneActive = harness.chat.ensemble!.activeRound!
      expect(roundWhileLaneActive.status).toBe('running')
      expect(roundWhileLaneActive.endedAt).toBeUndefined()

      // The lane keeps producing output after the serial drain; it must
      // still land in the transcript of the open round.
      stream(harness, 1, ' LANE-LATE-FINDING.')
      await sleep(FLUSH_MS)
      expect(rowIndex(harness, 'LANE-LATE-FINDING.')).toBeGreaterThanOrEqual(0)
      expect(harness.chat.ensemble!.activeRound!.status).toBe('running')

      // The last lane terminal closes the round.
      complete(harness, 1)
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
      await drainSerialQueueWithActiveLane(harness)

      // Deferred-drain state: round open, lane active.
      expect(harness.chat.ensemble!.activeRound!.status).toBe('running')

      // Stop must NOT wait for the lane — cancelled rounds finish now.
      const cancelled = await harness.orchestrator.cancelRound('ensemble-chat')
      expect(cancelled).toBe(true)
      expect(harness.chat.ensemble!.activeRound!.status).toBe('cancelled')
      const lanes = Object.values(harness.chat.ensemble!.activeRound!.lanes || {})
      expect(lanes).toHaveLength(1)
      expect(lanes[0].status).toBe('cancelled')
    }
  )
})
