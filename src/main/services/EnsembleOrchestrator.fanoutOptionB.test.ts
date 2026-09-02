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
      // Continuous-only (2026-09-01): the round no longer closes at the pass
      // boundary — it auto-continues until the hop budget exhausts. One hop
      // keeps the tail rideable: pass 1 → authority auto-continue → pass 2 →
      // round completes.
      harness.chat.ensemble!.orchestrationMode = 'continuous'
      harness.chat.ensemble!.maxContinuationHops = 1
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
      // Continuous-only: the pass boundary no longer closes the round. The
      // authority auto-continue re-dispatches the fan-out target once more;
      // ride that final pass so the 1-hop budget exhausts and the round
      // completes cleanly instead of wedging 'running'.
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4))
      expect(harness.dispatched[3].provider).toBe('claude')
      complete(harness, 3)
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
      // Continuous-only (2026-09-01): ride one auto-continue hop so the
      // round's terminal state is reachable (see the first test).
      harness.chat.ensemble!.orchestrationMode = 'continuous'
      harness.chat.ensemble!.maxContinuationHops = 1
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
      // Continuous-only: ride the authority auto-continue pass (the fan-out
      // target) so the 1-hop budget exhausts and the round completes.
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4))
      expect(harness.dispatched[3].provider).toBe('claude')
      complete(harness, 3)
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
      // Continuous-only (2026-09-01): ride one auto-continue hop so the
      // round's terminal state is reachable (see the first test).
      harness.chat.ensemble!.orchestrationMode = 'continuous'
      harness.chat.ensemble!.maxContinuationHops = 1
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
      // Continuous-only: ride the authority auto-continue pass (the fan-out
      // target) so the 1-hop budget exhausts and the round completes.
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(4))
      expect(harness.dispatched[3].provider).toBe('claude')
      complete(harness, 3)
      await vi.waitFor(() => expect(harness.chat.ensemble!.activeRound!.status).toBe('completed'))
    }
  )

  it(
    'releases a late owner continuation before the deferred drain auto-continues',
    { timeout: 20_000 },
    async () => {
      const harness = makeHarness(
        [
          participant('codex', 'codex', 'Lead', 1, 'workspace_write'),
          participant('claude', 'claude', 'Reviewer', 2, 'read_only')
        ],
        { ownedFanoutSettlementTimeoutMs: 50 }
      )
      harness.chat.ensemble!.orchestrationMode = 'continuous'
      harness.chat.ensemble!.maxContinuationHops = 1
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Keep the late synthesis and continue the round.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

      const fanout = await harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
        targets: ['Reviewer'],
        prompt: 'Return after the owner handoff window.'
      })
      expect(fanout.ok).toBe(true)
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

      // The owner writes while its lane is still outstanding. The synthesis is
      // intentionally held until the lane settlement has completed.
      stream(harness, 0, 'LATE-OWNER-SYNTHESIS.')
      await sleep(FLUSH_MS)
      expect(rowIndex(harness, 'LATE-OWNER-SYNTHESIS.')).toBe(-1)
      complete(harness, 0)

      // The short test timeout forces the serial drain into its deferred-lane
      // path while the lane remains live. A terminal lane status must not let
      // that path close the round before the owner settlement releases prose.
      await sleep(FLUSH_MS)
      expect(harness.chat.ensemble!.activeRound!.status).toBe('running')
      expect(harness.dispatched).toHaveLength(2)

      complete(harness, 1)
      await vi.waitFor(() => {
        expect(harness.dispatched).toHaveLength(3)
        expect(rowIndex(harness, 'LATE-OWNER-SYNTHESIS.')).toBeGreaterThanOrEqual(0)
      })
      // Authority-only Continuous auto-continue admits the fan-out target
      // (Reviewer/claude), not the answered prior speaker alone (Lead/codex).
      expect(harness.dispatched[2].provider).toBe('claude')
      expect(
        harness.chat.messages.some(
          (message) =>
            typeof message.content === 'string' &&
            message.content.includes('auto-continuing for pass 2')
        )
      ).toBe(true)

      complete(harness, 2)
      await vi.waitFor(() => expect(harness.chat.ensemble!.activeRound!.status).toBe('completed'))
      expect(
        harness.chat.messages.some(
          (message) =>
            typeof message.content === 'string' &&
            message.content.includes('written after it fanned out was discarded')
        )
      ).toBe(false)
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

  /*
   * The other half of the same defect. Raising the handoff window made
   * permanent suppression RARER; it did not make it visible. When it does
   * latch, `releaseOwnedFanoutHold` sets two flags and returns — the owner's
   * held post-fan-out prose is dropped with nothing said, so the transcript
   * simply stops at the `ensemble_fanout` call.
   *
   * That is indistinguishable from provider truncation, and it has cost real
   * diagnostic time: sessions have gone looking for max_tokens and context
   * walls for a reply the orchestrator itself discarded. Losing the tail when
   * the round is already gone is defensible; losing it SILENTLY is not.
   */
  it(
    'says so when a stopped round discards the owner held post-fan-out synthesis',
    { timeout: 20_000 },
    async () => {
      const harness = makeHarness([
        participant('codex', 'codex', 'Lead', 1, 'workspace_write'),
        participant('claude', 'claude', 'Reviewer', 2, 'read_only')
      ])
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Lead fans out, synthesizes, then the round is stopped.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

      const fanout = await harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
        targets: ['Reviewer'],
        prompt: 'Take longer than the round survives.'
      })
      expect(fanout.ok).toBe(true)
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

      // The Lead writes its synthesis while the lane is still outstanding, so
      // the hold keeps it back rather than releasing it.
      stream(harness, 0, 'BOSS-SYNTHESIS-AT-RISK.')
      await sleep(FLUSH_MS)
      expect(rowIndex(harness, 'BOSS-SYNTHESIS-AT-RISK.')).toBe(-1)

      // Round is stopped before the lane lands.
      await harness.orchestrator.cancelRound('ensemble-chat', 'user')
      await sleep(FLUSH_MS)

      // The lane settles late and finds a dead round: permanentSuppress.
      complete(harness, 1)
      await sleep(FLUSH_MS)

      // The held prose is genuinely gone — this test does not assert it comes
      // back, only that its loss is declared.
      expect(rowIndex(harness, 'BOSS-SYNTHESIS-AT-RISK.')).toBe(-1)

      const notice = harness.chat.messages.find(
        (message) =>
          typeof message.content === 'string' &&
          message.content.includes('written after it fanned out was discarded')
      )
      expect(
        notice,
        'discarding held synthesis must leave a user-facing note, not read as truncation'
      ).toBeDefined()
      expect(notice?.metadata?.kind).toBe('ensembleRoundStatus')

      // Assert the whole sentence a human actually reads, not a fragment: it
      // has to name the seat AND say the round was STOPPED. Reading the cause
      // off the runtime instead of the round silently degrades this to the
      // generic "already ended" wording, which a substring check would miss.
      expect(notice?.content).toBe(
        "Lead's continuation written after it fanned out was discarded: " +
          'the round was stopped before its fan-out lane(s) returned.'
      )

      // One note, however many settlements arrive afterwards.
      const noticeCount = harness.chat.messages.filter(
        (message) =>
          typeof message.content === 'string' &&
          message.content.includes('written after it fanned out was discarded')
      ).length
      expect(noticeCount).toBe(1)
    }
  )
})
