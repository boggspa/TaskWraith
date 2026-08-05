import { describe, expect, it, vi } from 'vitest'
import {
  clampAwaitTimeoutSeconds,
  DEFAULT_OWNED_FANOUT_SETTLEMENT_TIMEOUT_MS,
  EnsembleOrchestrator
} from './EnsembleOrchestrator'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { AppSettings, ChatRecord, EnsembleParticipant } from '../store/types'

/*
 * Option B enforcement — force-persisted Boss/Captain fan-out turn.
 *
 * Covers the three hardening changes layered on top of the existing
 * owned-fan-out settlement hold:
 *
 *   - Timeout guard on waitForOwnedFanoutSettlements.
 *   - Mandatory synthesis marker when a non-terminal caller produces no
 *     post-fan-out timeline content.
 *   - Terminal callers without synthesis get a status note and release
 *     cleanly instead of pinning the queue.
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
    title: 'Fan-out Option B',
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

function makeHarness(
  participants: EnsembleParticipant[],
  options: { ownedFanoutSettlementTimeoutMs?: number } = {}
) {
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
    nowIso: () => `2026-05-24T00:00:0${counter}.000Z`,
    ownedFanoutSettlementTimeoutMs: options.ownedFanoutSettlementTimeoutMs
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

describe('Option B — force-persisted Boss/Captain fan-out turn', () => {
  it(
    'times out waiting for owned lanes and proceeds with partial results',
    { timeout: 20_000 },
    async () => {
      const harness = makeHarness(
        [
          participant('codex', 'codex', 'Lead', 1, 'workspace_write'),
          participant('claude', 'claude', 'Reviewer', 2, 'read_only'),
          participant('gemini', 'gemini', 'Researcher', 3, 'workspace_write')
        ],
        { ownedFanoutSettlementTimeoutMs: 50 }
      )
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Lead fans out and waits longer than the timeout.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

      const fanout = await harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
        targets: ['Reviewer'],
        prompt: 'Never complete before the timeout.'
      })
      expect(fanout.ok).toBe(true)
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

      // The lane starts but never completes within the 50ms timeout window.
      stream(harness, 1, 'LANE-WORKING.')
      await sleep(FLUSH_MS)

      // The Lead finishes its turn while the lane is still running.
      complete(harness, 0)

      // Wait for the timeout to fire and the serial queue to advance.
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3), { timeout: 5_000 })
      expect(harness.dispatched[2].provider).toBe('gemini')

      expect(
        harness.chat.messages.some(
          (message) =>
            typeof message.content === 'string' &&
            message.content.includes('did not settle within 0.05s')
        )
      ).toBe(true)

      // Late lane output after the timeout must not crash or reorder into the
      // next serial participant's turn.
      stream(harness, 1, ' LATE-LANE-FINDING.')
      complete(harness, 1)
      await sleep(FLUSH_MS)

      complete(harness, 2)
      await vi.waitFor(() => expect(harness.chat.ensemble!.activeRound!.status).toBe('completed'))
    }
  )

  it(
    'holds transcript release until an active caller synthesizes after lanes settle',
    { timeout: 20_000 },
    async () => {
      const harness = makeHarness([
        participant('codex', 'codex', 'Lead', 1, 'workspace_write'),
        participant('claude', 'claude', 'Reviewer', 2, 'read_only'),
        participant('gemini', 'gemini', 'Researcher', 3, 'workspace_write')
      ])
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Lead fans out and synthesizes after lanes settle.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

      const fanout = await harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
        targets: ['Reviewer'],
        prompt: 'Return quickly.'
      })
      expect(fanout.ok).toBe(true)
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

      // Lane completes while the Lead is still active and has no post-fan-out
      // content yet. The hold must stay in place until the Lead synthesizes.
      stream(harness, 1, 'LANE-FINDING.')
      complete(harness, 1)
      await sleep(FLUSH_MS)
      expect(rowIndex(harness, 'LANE-FINDING.')).toBeGreaterThanOrEqual(0)

      // The Lead now emits its synthesis; this should release the hold.
      stream(harness, 0, 'BOSS-SYNTHESIS.')
      await sleep(FLUSH_MS)
      expect(rowIndex(harness, 'BOSS-SYNTHESIS.')).toBeGreaterThanOrEqual(0)

      // Both the lane report and the owner synthesis must be visible.
      expect(rowIndex(harness, 'LANE-FINDING.')).toBeGreaterThanOrEqual(0)
      expect(rowIndex(harness, 'BOSS-SYNTHESIS.')).toBeGreaterThanOrEqual(0)

      complete(harness, 0)
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
      expect(harness.dispatched[2].provider).toBe('gemini')
      complete(harness, 2)
      await vi.waitFor(() => expect(harness.chat.ensemble!.activeRound!.status).toBe('completed'))
    }
  )

  it(
    'releases a terminal caller that never synthesizes fan-out results',
    { timeout: 20_000 },
    async () => {
      const harness = makeHarness([
        participant('codex', 'codex', 'Lead', 1, 'workspace_write'),
        participant('claude', 'claude', 'Reviewer', 2, 'read_only'),
        participant('gemini', 'gemini', 'Researcher', 3, 'workspace_write')
      ])
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Lead fans out and ends turn silently.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

      const fanout = await harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
        targets: ['Reviewer'],
        prompt: 'Return quickly.'
      })
      expect(fanout.ok).toBe(true)
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

      // The Lead completes without any post-fan-out prose.
      complete(harness, 0)

      // Lane returns after the owner is already terminal.
      stream(harness, 1, 'LANE-FINDING.')
      complete(harness, 1)
      await sleep(FLUSH_MS)

      // A status note records the missing synthesis, and the queue advances.
      expect(
        harness.chat.messages.some(
          (message) =>
            typeof message.content === 'string' &&
            message.content.includes('ended the turn without synthesizing fan-out results')
        )
      ).toBe(true)

      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
      expect(harness.dispatched[2].provider).toBe('gemini')
      complete(harness, 2)
      await vi.waitFor(() => expect(harness.chat.ensemble!.activeRound!.status).toBe('completed'))
    }
  )

  /*
   * Lockstep guard. The foreground handoff window is a LIVENESS BACKSTOP, not
   * the effective cap on a lane — the same doctrine MCP_BROKER_LONG_POLL_TIMEOUT_MS
   * follows for ensemble_await's transport kill.
   *
   * When this window sits BELOW the await ceiling, a lane doing nothing more
   * exotic than one maximal ensemble_await outlives its owner's wait. The owner
   * is handed off with fanoutTimedOut, the round closes, and the late settlement
   * reaches releaseOwnedFanoutHold to find a dead round — latching
   * permanentSuppress and DISCARDING the owner's held post-fan-out synthesis
   * forever. That presents as the Boss being truncated mid-dispatch.
   */
  it('does not let the owned fan-out handoff window sit below the ensemble_await ceiling', () => {
    const awaitCeilingMs = clampAwaitTimeoutSeconds(1e9) * 1000

    expect(awaitCeilingMs).toBe(600_000)
    expect(DEFAULT_OWNED_FANOUT_SETTLEMENT_TIMEOUT_MS).toBeGreaterThanOrEqual(awaitCeilingMs)
  })
})
