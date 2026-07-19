import { describe, expect, it, vi } from 'vitest'
import { EnsembleOrchestrator } from './EnsembleOrchestrator'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { AppSettings, ChatRecord, EnsembleParticipant } from '../store/types'

/*
 * Fan-out transcript ordering — regression coverage for the "fan-out
 * completion shoves the lane viewports above the live speaker" race.
 *
 * The transcript is materialised main-side by flushRun; a run's rows are
 * anchored where its FIRST flush landed (ccf5a7f0d). Two first-flush
 * placements could still invert the reading order against a concurrently
 * streaming serial participant:
 *
 *   M1 — a sourcing Boss tries to publish a summary before its requested
 *        lanes return. The owner must remain visibly working and its post-
 *        fan-out output must stay buffered until the requested evidence is
 *        terminal, then materialise AFTER the lane reports.
 *
 *   M2 — a lane whose first output arrives late must remain grouped with the
 *        serial participant that sourced its wave. That participant retains
 *        foreground ownership until its lanes settle, so the next serial
 *        speaker cannot start between partial and late fan-out reports.
 *
 * These tests drive the real orchestrator with real (250ms debounced)
 * flush timers, so each step sleeps past the debounce before asserting.
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
    title: 'Fan-out order',
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
  options: { beforeSaveChat?: (chat: ChatRecord) => void } = {}
) {
  let chat = makeChat(participants)
  let counter = 0
  const dispatched: AgentRunPayload[] = []
  const orchestrator = new EnsembleOrchestrator({
    getChat: () => chat,
    saveChat: (next) => {
      options.beforeSaveChat?.(next)
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

function complete(harness: Harness, index: number, stats?: Record<string, number>): void {
  const payload = harness.dispatched[index]
  harness.orchestrator.handleProviderOutput(
    payload.provider,
    { appRunId: payload.appRunId, appChatId: 'ensemble-chat' },
    { type: 'result', status: 'success', ...(stats ? { stats } : {}) }
  )
}

function rowIndex(harness: Harness, text: string): number {
  return harness.chat.messages.findIndex(
    (message) => typeof message.content === 'string' && message.content.includes(text)
  )
}

function orderedMarkers(harness: Harness, markers: string[]): string[] {
  return markers
    .map((marker) => ({ marker, index: rowIndex(harness, marker) }))
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.marker)
}

describe('fan-out transcript ordering vs a live serial speaker', () => {
  it(
    'M1: withholds the sourcing Boss summary until its owned lane returns',
    { timeout: 20_000 },
    async () => {
      const harness = makeHarness([
        participant('codex', 'codex', 'Lead', 1, 'workspace_write'),
        participant('claude', 'claude', 'Reviewer', 2, 'read_only'),
        participant('gemini', 'gemini', 'Researcher', 3, 'workspace_write')
      ])
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Lead fans out silently, the lane speaks first.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
      expect(harness.dispatched[0].provider).toBe('codex')

      // The Boss produces NO visible output yet — its first action is the
      // fan-out call.
      const fanout = await harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
        targets: ['Reviewer'],
        prompt: 'Inspect while I keep working.'
      })
      expect(fanout.ok).toBe(true)
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

      // The lane flushes before the Boss says anything.
      stream(harness, 1, 'LANE-CLAUDE-NOTE.')
      await sleep(FLUSH_MS)
      expect(rowIndex(harness, 'LANE-CLAUDE-NOTE.')).toBeGreaterThanOrEqual(0)

      // The Boss tries to publish a synthesis and ends its provider turn while
      // the requested lane is still running. The transcript and durable run
      // state must keep that output pending: ownership has not returned yet.
      stream(harness, 0, 'BOSS-PREMATURE-SUMMARY.')
      complete(harness, 0)
      await sleep(FLUSH_MS)
      expect(rowIndex(harness, 'BOSS-PREMATURE-SUMMARY.')).toBe(-1)
      expect(harness.chat.runs.find((run) => run.runId === harness.dispatched[0].appRunId)?.status).toBe(
        'running'
      )
      expect(
        harness.chat.ensemble?.activeRound?.participants.find(
          (entry) => entry.participantId === 'codex'
        )?.status
      ).toBe('running')

      // Once the lane terminally returns, its final report lands first and only
      // then may the Boss summary become durable/visible.
      stream(harness, 1, ' Claude lane final report.')
      complete(harness, 1)
      await sleep(FLUSH_MS)
      expect(orderedMarkers(harness, ['BOSS-PREMATURE-SUMMARY.', 'LANE-CLAUDE-NOTE.'])).toEqual([
        'LANE-CLAUDE-NOTE.',
        'BOSS-PREMATURE-SUMMARY.'
      ])
      expect(harness.chat.runs.find((run) => run.runId === harness.dispatched[0].appRunId)?.status).toBe(
        'success'
      )
      expect(
        harness.chat.ensemble?.activeRound?.participants.find(
          (entry) => entry.participantId === 'codex'
        )?.status
      ).toBe('answered')

      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
      complete(harness, 2)
    }
  )

  it(
    'M1b: freezes a visible preamble entry so post-fanout prose cannot merge across the hold',
    { timeout: 20_000 },
    async () => {
      const harness = makeHarness([
        participant('codex', 'codex', 'Lead', 1, 'workspace_write'),
        participant('claude', 'claude', 'Reviewer', 2, 'read_only'),
        participant('gemini', 'gemini', 'Researcher', 3, 'workspace_write')
      ])
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Lead speaks, fans out without a tool timeline row, then tries to summarize.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

      stream(harness, 0, 'BOSS-PREAMBLE.')
      await sleep(FLUSH_MS)
      expect(rowIndex(harness, 'BOSS-PREAMBLE.')).toBeGreaterThanOrEqual(0)

      const fanout = await harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
        targets: ['Reviewer'],
        prompt: 'Inspect after my visible preamble.'
      })
      expect(fanout.ok).toBe(true)
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))

      stream(harness, 1, 'LANE-REPORT.')
      stream(harness, 0, ' BOSS-PREMATURE-SUMMARY.')
      complete(harness, 0)
      await sleep(FLUSH_MS)

      expect(rowIndex(harness, 'BOSS-PREAMBLE.')).toBeGreaterThanOrEqual(0)
      expect(rowIndex(harness, 'BOSS-PREMATURE-SUMMARY.')).toBe(-1)

      complete(harness, 1)
      await sleep(FLUSH_MS)
      expect(orderedMarkers(harness, ['LANE-REPORT.', 'BOSS-PREMATURE-SUMMARY.'])).toEqual([
        'LANE-REPORT.',
        'BOSS-PREMATURE-SUMMARY.'
      ])

      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
      complete(harness, 2)
    }
  )

  it(
    'M1c: keeps fast lane reports before owner prose emitted only after settlement',
    { timeout: 20_000 },
    async () => {
      const harness = makeHarness([
        participant('codex', 'codex', 'Lead', 1, 'workspace_write'),
        participant('claude', 'claude', 'Reviewer', 2, 'read_only'),
        participant('gemini', 'gemini', 'Researcher', 3, 'workspace_write')
      ])
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'The lane returns before the owner writes its synthesis.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
      stream(harness, 0, 'BOSS-PREAMBLE.')
      await sleep(FLUSH_MS)

      const fanout = await harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
        targets: ['Reviewer'],
        prompt: 'Return as quickly as possible.'
      })
      expect(fanout.ok).toBe(true)
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
      stream(harness, 1, 'FAST-LANE-REPORT.')
      complete(harness, 1)
      await sleep(FLUSH_MS)

      // Ownership has returned, but the owner has not emitted any post-fanout
      // timeline entry yet.
      stream(harness, 0, ' BOSS-AFTER-SETTLEMENT.')
      complete(harness, 0)
      await sleep(FLUSH_MS)

      const preamble = harness.chat.messages.find(
        (message) =>
          typeof message.content === 'string' && message.content.includes('BOSS-PREAMBLE.')
      )
      expect(preamble?.content).not.toContain('BOSS-AFTER-SETTLEMENT.')
      expect(orderedMarkers(harness, ['FAST-LANE-REPORT.', 'BOSS-AFTER-SETTLEMENT.'])).toEqual([
        'FAST-LANE-REPORT.',
        'BOSS-AFTER-SETTLEMENT.'
      ])

      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
      complete(harness, 2)
    }
  )

  it(
    'M1d: materializes an unflushed preamble before a synchronously fast lane',
    { timeout: 20_000 },
    async () => {
      const harness = makeHarness([
        participant('codex', 'codex', 'Lead', 1, 'workspace_write'),
        participant('claude', 'claude', 'Reviewer', 2, 'read_only'),
        participant('gemini', 'gemini', 'Researcher', 3, 'workspace_write')
      ])
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Fan out before the owner preamble debounce fires.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))

      stream(harness, 0, 'UNFLUSHED-BOSS-PREAMBLE.')
      const fanout = await harness.orchestrator.fanoutForRun(harness.dispatched[0].appRunId, {
        targets: ['Reviewer'],
        prompt: 'Return synchronously.'
      })
      expect(fanout.ok).toBe(true)
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
      stream(harness, 1, 'SYNCHRONOUS-LANE-REPORT.')
      complete(harness, 1)

      stream(harness, 0, ' BOSS-POST-FANOUT.')
      complete(harness, 0)
      await sleep(FLUSH_MS)

      expect(
        orderedMarkers(harness, [
          'UNFLUSHED-BOSS-PREAMBLE.',
          'SYNCHRONOUS-LANE-REPORT.',
          'BOSS-POST-FANOUT.'
        ])
      ).toEqual([
        'UNFLUSHED-BOSS-PREAMBLE.',
        'SYNCHRONOUS-LANE-REPORT.',
        'BOSS-POST-FANOUT.'
      ])

      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
      complete(harness, 2)
    }
  )

  it(
    'M1e: restores failed preflush and status boundaries before a successful retry',
    { timeout: 20_000 },
    async () => {
      let rejectedSave: 'preamble' | 'status' | null = null
      const harness = makeHarness(
        [
          participant('codex', 'codex', 'Lead', 1, 'workspace_write'),
          participant('claude', 'claude', 'Reviewer', 2, 'read_only'),
          participant('gemini', 'gemini', 'Researcher', 3, 'workspace_write')
        ],
        {
          beforeSaveChat: (next) => {
            const lastMessage = next.messages.at(-1)
            if (
              rejectedSave === 'preamble' &&
              lastMessage?.metadata?.kind === 'ensembleParticipant' &&
              lastMessage.content.includes('RETRY-BOSS-PREAMBLE.')
            ) {
              rejectedSave = null
              throw new Error('injected pre-boundary save failure')
            }
            if (
              rejectedSave === 'status' &&
              lastMessage?.metadata?.kind === 'ensembleRoundStatus' &&
              lastMessage.content.includes('requested')
            ) {
              rejectedSave = null
              throw new Error('injected fanout status save failure')
            }
          }
        }
      )
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Retry fanout after the first boundary save fails.',
        event: { sender: {} as Electron.WebContents }
      })
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(1))
      const ownerRunId = harness.dispatched[0].appRunId!

      stream(harness, 0, 'RETRY-BOSS-PREAMBLE.')
      rejectedSave = 'preamble'
      await expect(
        harness.orchestrator.fanoutForRun(ownerRunId, {
          targets: ['Reviewer'],
          prompt: 'This first dispatch must not start.'
        })
      ).resolves.toMatchObject({ ok: false, error: 'dispatch_failed' })
      expect(harness.dispatched).toHaveLength(1)

      const failedOwner = (
        harness.orchestrator as unknown as {
          runsByRunId: Map<
            string,
            { ownedFanoutTranscriptBoundary?: number; forceNextTimelineContentEntry?: boolean }
          >
        }
      ).runsByRunId.get(ownerRunId)
      expect(failedOwner?.ownedFanoutTranscriptBoundary).toBeUndefined()
      expect(failedOwner?.forceNextTimelineContentEntry).toBe(false)

      rejectedSave = 'status'
      await expect(
        harness.orchestrator.fanoutForRun(ownerRunId, {
          targets: ['Reviewer'],
          prompt: 'The status save for this attempt must fail.'
        })
      ).resolves.toMatchObject({ ok: false, error: 'dispatch_failed' })
      expect(harness.dispatched).toHaveLength(1)
      expect(failedOwner?.ownedFanoutTranscriptBoundary).toBeUndefined()
      expect(failedOwner?.forceNextTimelineContentEntry).toBe(false)

      const retry = await harness.orchestrator.fanoutForRun(ownerRunId, {
        targets: ['Reviewer'],
        prompt: 'The retry may dispatch.'
      })
      expect(retry.ok).toBe(true)
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
      stream(harness, 1, 'RETRY-LANE-REPORT.')
      complete(harness, 1)
      stream(harness, 0, ' RETRY-BOSS-POST-FANOUT.')
      complete(harness, 0)
      await sleep(FLUSH_MS)

      expect(
        orderedMarkers(harness, [
          'RETRY-BOSS-PREAMBLE.',
          'RETRY-LANE-REPORT.',
          'RETRY-BOSS-POST-FANOUT.'
        ])
      ).toEqual([
        'RETRY-BOSS-PREAMBLE.',
        'RETRY-LANE-REPORT.',
        'RETRY-BOSS-POST-FANOUT.'
      ])

      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
      complete(harness, 2)
    }
  )

  it('merges held owner token totals exactly once at effective terminal release', async () => {
    const roster = () => [
      participant('codex', 'codex', 'Lead', 1, 'workspace_write'),
      participant('claude', 'claude', 'Reviewer', 2, 'read_only'),
      participant('gemini', 'gemini', 'Researcher', 3, 'workspace_write')
    ]
    const stats = {
      input_tokens: 20,
      output_tokens: 5,
      total_tokens: 25,
      duration_ms: 100
    }

    const ordinary = makeHarness(roster())
    ordinary.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Ordinary accounting baseline.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(ordinary.dispatched).toHaveLength(1))
    stream(ordinary, 0, 'ORDINARY-OWNER-SUMMARY.')
    complete(ordinary, 0, stats)
    const ordinaryTotals = ordinary.chat.ensemble?.participants.find(
      (entry) => entry.id === 'codex'
    )?.tokenTotals
    expect(ordinaryTotals).toMatchObject(stats)

    const held = makeHarness(roster())
    held.orchestrator.startRound({
      chatId: 'ensemble-chat',
      prompt: 'Hold the same accounting behind a lane.',
      event: { sender: {} as Electron.WebContents }
    })
    await vi.waitFor(() => expect(held.dispatched).toHaveLength(1))
    const fanout = await held.orchestrator.fanoutForRun(held.dispatched[0].appRunId, {
      targets: ['Reviewer'],
      prompt: 'Hold the owner terminal until I return.'
    })
    expect(fanout.ok).toBe(true)
    await vi.waitFor(() => expect(held.dispatched).toHaveLength(2))
    const heldOwner = (
      held.orchestrator as unknown as {
        runsByRunId: Map<
          string,
          {
            ownedFanoutSettlements?: Set<Promise<void>>
            ownedFanoutTranscriptBoundary?: number
            terminalTokenTotalsApplied?: boolean
          }
        >
      }
    ).runsByRunId.get(held.dispatched[0].appRunId!)
    expect(heldOwner?.ownedFanoutSettlements?.size).toBe(1)
    expect(heldOwner?.ownedFanoutTranscriptBoundary).toBe(0)
    expect(heldOwner?.terminalTokenTotalsApplied).not.toBe(true)
    expect(
      held.chat.ensemble?.participants.find((entry) => entry.id === 'codex')?.tokenTotals
    ).toBeUndefined()
    stream(held, 0, 'HELD-OWNER-SUMMARY.')
    complete(held, 0, stats)
    expect(heldOwner?.ownedFanoutSettlements?.size).toBe(1)
    expect(heldOwner?.ownedFanoutTranscriptBoundary).toBe(0)
    expect(heldOwner?.terminalTokenTotalsApplied).not.toBe(true)
    expect(
      held.chat.ensemble?.participants.find((entry) => entry.id === 'codex')?.tokenTotals
    ).toBeUndefined()

    complete(held, 1)
    await vi.waitFor(() =>
      expect(
        held.chat.ensemble?.participants.find((entry) => entry.id === 'codex')?.tokenTotals
      ).toEqual(ordinaryTotals)
    )
  })

  it(
    "M2: holds the next serial speaker until the sourcing Lead's wave-2 lanes settle",
    { timeout: 20_000 },
    async () => {
      const harness = makeHarness([
        participant('codex', 'codex', 'Lead', 1, 'workspace_write'),
        participant('claude', 'claude', 'Reviewer', 2, 'read_only'),
        participant('grok', 'grok', 'Researcher', 3, 'read_only'),
        participant('ollama', 'ollama', 'Builder', 4, 'workspace_write')
      ])
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Recon wave, then Lead fans out again mid-turn.',
        event: { sender: {} as Electron.WebContents }
      })
      // Round-start read-only recon wave dispatches both readers first.
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
      expect(harness.dispatched.map((p) => p.provider)).toEqual(['claude', 'grok'])

      stream(harness, 0, 'W1-CLAUDE-RECON.')
      stream(harness, 1, 'W1-GROK-RECON.')
      await sleep(FLUSH_MS)
      complete(harness, 0)
      complete(harness, 1)

      // Recon settled → the serial loop dispatches the Lead.
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(3))
      expect(harness.dispatched[2].provider).toBe('codex')

      stream(harness, 2, 'BOSS-INTRO.')
      await sleep(FLUSH_MS)

      // Lead fans out again mid-turn to both readers (wave 2).
      const fanout = await harness.orchestrator.fanoutForRun(harness.dispatched[2].appRunId, {
        targets: ['Reviewer', 'Researcher'],
        prompt: 'Verify the recon while the round continues.'
      })
      expect(fanout.ok).toBe(true)
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(5))

      // Only the Researcher lane produces output before the Lead yields;
      // the Reviewer lane stays silent.
      stream(harness, 4, 'W2-GROK-NOTE.')
      await sleep(FLUSH_MS)
      expect(rowIndex(harness, 'W2-GROK-NOTE.')).toBeGreaterThan(rowIndex(harness, 'BOSS-INTRO.'))

      // Lead finishes its serial turn, but retains foreground ownership while
      // both wave-2 lanes are still running. Builder must not overlap the
      // unresolved fan-out return lifecycle.
      complete(harness, 2)
      expect(harness.dispatched).toHaveLength(5)
      expect(harness.chat.ensemble?.activeRound?.status).toBe('running')

      // The silent Reviewer lane now completes: its whole report is its first
      // flush. Same-wave lanes retain deterministic participant ordering, but
      // both stay after their sourcing Lead and before the next serial speaker.
      stream(harness, 3, 'W2-CLAUDE-LATE-REPORT.')
      complete(harness, 3)
      complete(harness, 4)
      await sleep(FLUSH_MS)

      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(6))
      expect(harness.dispatched[5].provider).toBe('ollama')

      stream(harness, 5, 'BUILDER-LIVE-MESSAGE.')
      await sleep(FLUSH_MS)

      const builderIndex = rowIndex(harness, 'BUILDER-LIVE-MESSAGE.')
      const lateLaneIndex = rowIndex(harness, 'W2-CLAUDE-LATE-REPORT.')
      expect(builderIndex).toBeGreaterThanOrEqual(0)
      expect(lateLaneIndex).toBeGreaterThanOrEqual(0)
      expect(lateLaneIndex).toBeGreaterThan(rowIndex(harness, 'BOSS-INTRO.'))
      expect(lateLaneIndex).toBeLessThan(builderIndex)

      // The Builder keeps streaming after the fan-out completed; nothing
      // may re-shuffle.
      stream(harness, 5, ' BUILDER-WRAP-UP.')
      await sleep(FLUSH_MS)
      complete(harness, 5)
      await sleep(FLUSH_MS)
      expect(rowIndex(harness, 'W2-CLAUDE-LATE-REPORT.')).toBeLessThan(
        rowIndex(harness, 'BUILDER-LIVE-MESSAGE.')
      )
      expect(
        orderedMarkers(harness, [
          'W1-CLAUDE-RECON.',
          'W1-GROK-RECON.',
          'BOSS-INTRO.',
          'W2-CLAUDE-LATE-REPORT.',
          'W2-GROK-NOTE.',
          'BUILDER-LIVE-MESSAGE.'
        ])
      ).toEqual([
        'W1-CLAUDE-RECON.',
        'W1-GROK-RECON.',
        'BOSS-INTRO.',
        'W2-CLAUDE-LATE-REPORT.',
        'W2-GROK-NOTE.',
        'BUILDER-LIVE-MESSAGE.'
      ])
    }
  )
})
