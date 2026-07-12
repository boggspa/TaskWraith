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
 *   M1 — a fan-out lane out-races its SOURCING serial run's first flush
 *        (the Boss calls ensemble_fanout before producing visible
 *        output). The Boss's block then appended at the tail — BELOW the
 *        lane it dispatched — and every lane flush (most visibly the
 *        completion batch) piled in above the Boss's live message.
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

function orderedMarkers(harness: Harness, markers: string[]): string[] {
  return markers
    .map((marker) => ({ marker, index: rowIndex(harness, marker) }))
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.marker)
}

describe('fan-out transcript ordering vs a live serial speaker', () => {
  it(
    'M1: anchors the sourcing Boss block above a lane that out-races its first flush',
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

      // Now the Boss speaks while the lane is still running.
      stream(harness, 0, 'BOSS-LIVE-MESSAGE.')
      await sleep(FLUSH_MS)

      // The lane completes before the Boss finishes its turn.
      stream(harness, 1, ' Claude lane final report.')
      complete(harness, 1)
      await sleep(FLUSH_MS)

      stream(harness, 0, ' BOSS-WRAP-UP.')
      await sleep(FLUSH_MS)

      // The Boss sourced the fan-out: its turn began before the lane was
      // dispatched, so its block must read ABOVE the lane block — and must
      // not be shoved down when the lane completes mid-turn.
      expect(orderedMarkers(harness, ['BOSS-LIVE-MESSAGE.', 'LANE-CLAUDE-NOTE.'])).toEqual([
        'BOSS-LIVE-MESSAGE.',
        'LANE-CLAUDE-NOTE.'
      ])

      complete(harness, 0)
      await sleep(FLUSH_MS)
      expect(orderedMarkers(harness, ['BOSS-LIVE-MESSAGE.', 'LANE-CLAUDE-NOTE.'])).toEqual([
        'BOSS-LIVE-MESSAGE.',
        'LANE-CLAUDE-NOTE.'
      ])
    }
  )

  it(
    "M2: holds the next serial speaker until the sourcing Lead's wave-2 lanes settle",
    { timeout: 20_000 },
    async () => {
      const harness = makeHarness([
        participant('codex', 'codex', 'Lead', 1, 'workspace_write'),
        participant('claude', 'claude', 'Reviewer', 2, 'read_only'),
        participant('gemini', 'gemini', 'Researcher', 3, 'read_only'),
        participant('kimi', 'kimi', 'Builder', 4, 'workspace_write')
      ])
      harness.orchestrator.startRound({
        chatId: 'ensemble-chat',
        prompt: 'Recon wave, then Lead fans out again mid-turn.',
        event: { sender: {} as Electron.WebContents }
      })
      // Round-start read-only recon wave dispatches both readers first.
      await vi.waitFor(() => expect(harness.dispatched).toHaveLength(2))
      expect(harness.dispatched.map((p) => p.provider)).toEqual(['claude', 'gemini'])

      stream(harness, 0, 'W1-CLAUDE-RECON.')
      stream(harness, 1, 'W1-GEMINI-RECON.')
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
      stream(harness, 4, 'W2-GEMINI-NOTE.')
      await sleep(FLUSH_MS)
      expect(rowIndex(harness, 'W2-GEMINI-NOTE.')).toBeGreaterThan(rowIndex(harness, 'BOSS-INTRO.'))

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
      expect(harness.dispatched[5].provider).toBe('kimi')

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
          'W1-GEMINI-RECON.',
          'BOSS-INTRO.',
          'W2-CLAUDE-LATE-REPORT.',
          'W2-GEMINI-NOTE.',
          'BUILDER-LIVE-MESSAGE.'
        ])
      ).toEqual([
        'W1-CLAUDE-RECON.',
        'W1-GEMINI-RECON.',
        'BOSS-INTRO.',
        'W2-CLAUDE-LATE-REPORT.',
        'W2-GEMINI-NOTE.',
        'BUILDER-LIVE-MESSAGE.'
      ])
    }
  )
})
