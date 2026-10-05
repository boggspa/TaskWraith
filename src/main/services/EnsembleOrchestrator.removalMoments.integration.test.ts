/**
 * What a round of several seats removes from its transcript, through the real
 * orchestrator and the real store with barrier durability switched on.
 *
 * Public `startRound` dispatches three read-only lanes at once and public
 * `handleProviderOutput` streams each one's speech and tools; the
 * orchestrator's own flushes save them through a Host-owned AppStore. Every
 * save is observed as the barrier layer classifies it: the rows it removed,
 * the moments it took and the barriers it raised. Two lanes do what makes a
 * flush remove a row of its own run: one ends its turn on a "[System]
 * Yielding" line, which the transcript strips, and one produces media before
 * any speech, whose empty carrier row moves when its next tool lands. Nobody
 * asked for those rows to go, and nobody is told they went.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { ChatSaveMoment } from '../store/ChatSaveMoments'
import type { ThreadBarrierDurability } from '../store/ThreadBarrierDurability'
import {
  chatRecord,
  disposeHostOwnedStores,
  importHostOwnedStore
} from '../store/hostOwnedErasure.testutil'
import type { EnsembleParticipant, TranscriptMediaRef } from '../store/types'

const WAIT = { timeout: 10_000 }

/** Each save the barrier layer classified: what it removed, took and raised. */
const observed = vi.hoisted(() => ({
  saves: [] as Array<{ removed: string[]; moments: ChatSaveMoment[]; barriers: number }>
}))

vi.mock('../store/ThreadBarrierDurability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/ThreadBarrierDurability')>()
  return {
    ...actual,
    createThreadBarrierDurability: (
      options?: import('../store/ThreadBarrierDurability').ThreadBarrierDurabilityOptions
    ): ThreadBarrierDurability => {
      const layer = actual.createThreadBarrierDurability(options)
      const noteSave = layer.noteSave
      layer.noteSave = (previous, next, persisted, flushReason, removalAskedByUser) => {
        const raised = layer.debt.snapshot().barriers.raised
        const moments = noteSave(previous, next, persisted, flushReason, removalAskedByUser)
        const kept = new Set(next.messages.map((row) => row.id))
        observed.saves.push({
          removed: (previous?.messages ?? [])
            .filter((row) => !kept.has(row.id))
            .map((row) => row.id),
          moments,
          barriers: layer.debt.snapshot().barriers.raised - raised
        })
        return moments
      }
      return layer
    }
  }
})

const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  await disposeHostOwnedStores()
  vi.unstubAllEnvs()
  observed.saves.length = 0
})

function scout(id: string, order: number): EnsembleParticipant {
  return {
    id,
    provider: 'codex',
    enabled: true,
    role: id,
    instructions: `${id}.`,
    order,
    model: 'codex-model',
    permissionPresetId: 'read_only',
    stageRole: 'scout'
  }
}

const CHAT = 'removal-round'

async function openRound() {
  vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '1')
  const seed = chatRecord(CHAT, 1, {
    chatKind: 'ensemble',
    messages: [],
    ensemble: {
      enabled: true,
      maxParticipants: 3,
      maxContinuationHops: 0,
      fanoutPolicy: 'read_only',
      participants: [scout('scout-a', 1), scout('scout-b', 2), scout('scout-c', 3)]
    }
  })
  const { AppStore } = await importHostOwnedStore([seed])
  AppStore.updateSettings({ storeLocalChatHistory: true })
  // Loaded after the store, so it binds to the store this test configured.
  const { EnsembleOrchestrator } = await import('./EnsembleOrchestrator')

  const saved: string[] = []
  const dispatched: AgentRunPayload[] = []
  let sequence = 0
  const orchestrator = new EnsembleOrchestrator({
    getChat: (chatId) => AppStore.getChat(chatId),
    saveChat: (chat, options) => {
      saved.push(JSON.stringify(AppStore.saveChat(chat, options).messages))
    },
    persistChatBarrier: (chatId) => AppStore.awaitChatRecordDispatchDurable(chatId),
    getSettings: () => AppStore.getSettings(),
    dispatch: async (payload, _event, observer) => {
      dispatched.push(payload)
      observer?.onAdapterInvoked?.({ provider: payload.provider, appRunId: payload.appRunId || '' })
      return { dispatched: true, appRunId: payload.appRunId || '' }
    },
    cancelRun: async () => true,
    createRunId: (provider) => `${provider}-removal-run-${++sequence}`,
    now: () => Date.now(),
    nowIso: () => new Date().toISOString()
  })
  expect(
    orchestrator.startRound({
      chatId: CHAT,
      prompt: 'Look around and report.',
      event: { sender: {} as Electron.WebContents }
    }).status
  ).toBe('started')
  cleanups.push(() => orchestrator.cancelRound(CHAT, 'removal round test cleanup'))
  await vi.waitFor(() => expect(dispatched).toHaveLength(3), WAIT)

  const lane = (participantId: string): AgentRunPayload =>
    dispatched.find((payload) => payload.ensembleRun?.participantId === participantId)!
  const status = (payload: AgentRunPayload) =>
    AppStore.getChat(CHAT)?.runs.find((run) => run.runId === payload.appRunId)?.status
  for (const id of ['scout-a', 'scout-b', 'scout-c']) {
    await vi.waitFor(() => expect(status(lane(id))).toBe('running'), WAIT)
  }

  return {
    AppStore,
    orchestrator,
    lane,
    status,
    stream: (payload: AgentRunPayload, event: Record<string, unknown>): void => {
      expect(
        orchestrator.handleProviderOutput(
          payload.provider,
          { appRunId: payload.appRunId, appChatId: payload.appChatId },
          event
        )
      ).toBe(true)
    },
    /** Waits for a save after the `after`-th whose messages match. */
    savedAfter: async (after: number, matches: (messages: string) => boolean) => {
      await vi.waitFor(() => expect(saved.slice(after).some(matches)).toBe(true), WAIT)
    },
    saves: () => saved.length
  }
}

describe("rows a round's own flushes remove", () => {
  it(
    'take no ticket and raise no barrier: nobody asked for them to go',
    { timeout: 30_000 },
    async () => {
      const round = await openRound()
      const [a, b, c] = ['scout-a', 'scout-b', 'scout-c'].map(round.lane)
      const tool = (payload: AgentRunPayload, id: string, name: string, output: string) => {
        round.stream(payload, { type: 'tool_use', tool_id: id, tool_name: name, parameters: {} })
        round.stream(payload, { type: 'tool_result', tool_id: id, content: output })
      }

      // Ordinary streaming on every lane: speech, a tool, more speech.
      let mark = round.saves()
      round.stream(a, { type: 'content', text: 'A-READING the layout.' })
      round.stream(c, { type: 'content', text: 'C-READING the tests.' })
      tool(a, 'a-tool-1', 'read_file', 'A-TOOL-OUTPUT')
      tool(c, 'c-tool-1', 'read_file', 'C-TOOL-OUTPUT')
      // Lane B produces a clip before it says anything: the clip rides an empty carrier row.
      tool(b, 'b-tool-1', 'transcode_video', 'B-CLIP')
      const clip: TranscriptMediaRef = {
        id: `${b.appRunId}:produced-video:abc123`,
        kind: 'video',
        format: 'container',
        source: 'generated',
        name: 'clip.mp4',
        mimeType: 'video/mp4',
        sha256: 'abc123',
        status: 'available'
      }
      round.orchestrator.appendTrustedMediaRefs(b.appRunId!, [clip])
      await round.savedAfter(mark, (messages) => messages.includes('C-TOOL-OUTPUT'))

      // Lane A ends its speech on a pseudo system line, in two deltas.
      mark = round.saves()
      round.stream(a, { type: 'content', text: '[System] Yie' })
      await round.savedAfter(mark, (messages) => messages.includes('[System] Yie'))
      mark = round.saves()
      round.stream(a, { type: 'content', text: 'lding to scout-b.' })
      // Lane B's next tool lands after its carrier.
      tool(b, 'b-tool-2', 'read_file', 'B-TOOL-OUTPUT')
      round.stream(c, { type: 'content', text: 'C-DONE with the tests.' })
      await round.savedAfter(
        mark,
        (messages) =>
          messages.includes('B-TOOL-OUTPUT') &&
          messages.includes('C-DONE') &&
          !messages.includes('[System] Yie')
      )
      round.stream(b, { type: 'content', text: 'B-DONE: the clip is rendered.' })
      for (const payload of [a, b, c]) round.stream(payload, { type: 'result', status: 'success' })
      for (const payload of [a, b, c]) {
        await vi.waitFor(() => expect(round.status(payload)).toBe('success'), WAIT)
      }

      const removing = observed.saves.filter((save) => save.removed.length > 0)
      // The stripped line's row and the carrier the clip rode went.
      expect(removing.flatMap((save) => save.removed)).toEqual(
        expect.arrayContaining([
          `ensemble-content-${a.appRunId}-2`,
          `ensemble-content-${b.appRunId}-1`
        ])
      )
      expect(
        removing.map(({ removed, moments, barriers }) => ({ removed, moments, barriers }))
      ).toEqual(removing.map(({ removed }) => ({ removed, moments: [], barriers: 0 })))
      // The layer took tickets all along: each lane's end is its run's final record.
      expect(
        observed.saves.flatMap((save) => save.moments).filter((m) => m.moment === 'run_final')
      ).toHaveLength(3)
      expect(
        round.AppStore.getThreadBarrierDurabilityPerf().tickets?.moments.destructive
      ).toMatchObject({
        noted: 0
      })
    }
  )
})
