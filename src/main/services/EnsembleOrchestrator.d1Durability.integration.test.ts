/**
 * D1 scheduled saves through the real orchestrator, store and journal.
 *
 * Structural proof for the Independent Threads Programme D1 path. Public
 * `startRound` admits each round, and the injected dispatch receives the run
 * the orchestrator registered. Public `handleProviderOutput` streams
 * deterministic content and tool events; the orchestrator's own 250 ms chat
 * flush saves them through an isolated Host-owned AppStore into the real
 * incremental journal. `AppStore.awaitChatRecordDispatchDurable`, which is the
 * production `persistChatBarrier`, is awaited only once the save carrying a
 * marker exists: that save's revision is the watermark. Deferred journal
 * fsyncs settle at a controlled edge through the journal's existing
 * `scheduleFsync` seam, and a read-only journal reopen replays what the
 * barrier certified. The Host compatibility port is a stub that records calls
 * and acknowledges drains. Once the round-start checkpoint is confirmed
 * through the public full barrier, a D1 save must neither enqueue nor drain a
 * Host record, while the strict terminal boundary does enqueue one.
 *
 * Not covered: the composition-root save wrapper in index.ts (media
 * normalization, broadcasts, scheduled-occurrence heartbeat), provider
 * transports, the perf replay adapter (it still approximates D1 through
 * saveChat and reports integratedOrchestratorTick as unsupported), and machine
 * power-loss durability. Nothing here qualifies an M1 capture.
 */
import { fsyncSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import type { HostThreadRecordPersistPort } from '../host/HostThreadRecordPersistCommand'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { IncrementalChatJournalOptions } from '../store/IncrementalChatJournal'
import type { ChatMessage, ChatRecord, EnsembleParticipant } from '../store/types'

// This file proves D1 saves certified by the journal's own deferred fsyncs:
// the path the store takes with barrier durability off. Barrier durability is
// on by default and the store reads its switch once, at load, so it is pinned
// off here with the exact token `0` before anything imports the store. The
// barrier path's dispatch barriers are proven in
// store/ThreadBarrierDurability.integration.test.ts.
vi.hoisted(() => {
  vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '0')
})
afterAll(() => {
  vi.unstubAllEnvs()
})

type PendingFsync = {
  chatId: string | null
  fd: number
  done: (error?: NodeJS.ErrnoException | null) => void
}

type ObservedAppend = {
  chatId: string
  revision: number
  requested: 'immediate' | 'deferred'
  deferred: boolean
  operations: string[]
  body: string
}

type SaveObservation = { chatId: string; revision: number; atMs: number; messages: string }

type TailObservation = {
  chatId: string
  atMs: number
  messages: string
  saves: number
  appends: number
}

const WAIT = { timeout: 10_000 }

const journalFsyncs = vi.hoisted(() => [] as PendingFsync[])
const journalAppends = vi.hoisted(() => [] as ObservedAppend[])

// Keep the real journal writes, replay and durability waiters. The journal's
// own scheduleFsync seam lets a test settle or fail each deferred fsync at a
// controlled edge; the append wrapper only records the durability class each
// real batch requested and actually received.
vi.mock('../store/IncrementalChatJournal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/IncrementalChatJournal')>()
  return {
    ...actual,
    createIncrementalChatJournal: (
      directory: string,
      options: IncrementalChatJournalOptions = {}
    ) => {
      const journal = actual.createIncrementalChatJournal(directory, {
        ...options,
        scheduleFsync: (fd, done) => {
          journalFsyncs.push({ chatId: null, fd, done })
        }
      })
      const append = journal.append.bind(journal)
      journal.append = (batch, appendOptions) => {
        const pendingBefore = journalFsyncs.length
        append(batch, appendOptions)
        const deferred = journalFsyncs.length > pendingBefore
        const scheduled = journalFsyncs.at(-1)
        if (deferred && scheduled) scheduled.chatId = batch.chatId
        journalAppends.push({
          chatId: batch.chatId,
          revision: batch.revision,
          requested: appendOptions?.durability ?? 'immediate',
          deferred,
          operations: batch.operations.map((operation) => operation.type),
          body: JSON.stringify(batch.operations)
        })
      }
      return journal
    }
  }
})

const profiles: string[] = []
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  for (const entry of journalFsyncs.splice(0)) {
    fsyncSync(entry.fd)
    entry.done(null)
  }
  journalAppends.length = 0
  vi.restoreAllMocks()
  while (profiles.length > 0) rmSync(profiles.pop()!, { recursive: true, force: true })
})

function pendingFsyncs(chatId: string): number {
  return journalFsyncs.filter((entry) => entry.chatId === chatId).length
}

function takeJournalFsync(chatId: string, position: 'oldest' | 'newest'): PendingFsync {
  const matching = journalFsyncs.filter((entry) => entry.chatId === chatId)
  const entry = position === 'oldest' ? matching[0] : matching.at(-1)
  if (!entry) throw new Error(`No deferred journal fsync is pending for ${chatId}`)
  journalFsyncs.splice(journalFsyncs.indexOf(entry), 1)
  return entry
}

/** Really sync one captured handle, then acknowledge it to the journal. */
function acknowledgeJournalFsync(chatId: string, position: 'oldest' | 'newest' = 'oldest'): void {
  const entry = takeJournalFsync(chatId, position)
  fsyncSync(entry.fd)
  entry.done(null)
}

function acknowledgeJournalFsyncs(chatId: string): void {
  while (pendingFsyncs(chatId) > 0) acknowledgeJournalFsync(chatId)
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** Whether a promise settles within a bounded number of macrotask turns. */
async function settlesWithin(promise: Promise<unknown>, turns = 20): Promise<boolean> {
  let settled = false
  const observe = (): void => {
    settled = true
  }
  void promise.then(observe, observe)
  for (let turn = 0; turn < turns && !settled; turn += 1) await nextTurn()
  return settled
}

function rowContaining(
  messages: readonly ChatMessage[] | undefined,
  marker: string
): ChatMessage | undefined {
  return messages?.find((message) => message.content.includes(marker))
}

function seat(
  id: string,
  order: number,
  stageRole: 'worker' | 'scout' = 'worker'
): EnsembleParticipant {
  return {
    id,
    provider: 'codex',
    enabled: true,
    role: id,
    instructions: `${id}.`,
    order,
    model: 'codex-model',
    permissionPresetId: stageRole === 'scout' ? 'read_only' : 'workspace_write',
    stageRole
  }
}

/** Run transitions and user rows are D2: never deferred, whatever rides with them. */
function expectStrictBoundariesImmediate(chatId: string): void {
  const strict = journalAppends.filter(
    (append) =>
      append.chatId === chatId &&
      (append.operations.includes('runs_splice') ||
        append.operations.includes('run_put') ||
        append.body.includes('"role":"user"'))
  )
  expect(strict.length).toBeGreaterThan(0)
  for (const append of strict) expect(append.deferred, `revision ${append.revision}`).toBe(false)
}

async function openHarness() {
  const profilePath = mkdtempSync(join(tmpdir(), 'taskwraith-d1-durability-'))
  profiles.push(profilePath)
  vi.resetModules()
  const { configureHostStoreRuntime, resetHostStoreRuntimeForTests } =
    await import('../../host-runtime/HostStoreRuntime')
  resetHostStoreRuntimeForTests()
  configureHostStoreRuntime({
    profilePath,
    secureStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(`node:${plain}`, 'utf8'),
      decryptString: (encrypted) => encrypted.toString('utf8').replace(/^node:/, '')
    }
  })
  const { AppStore } = await import('../store/index')
  AppStore.updateSettings({ storeLocalChatHistory: true })
  const { legacyStoreWriterGate } = await import('../store/LegacyStoreWriterGate')
  expect(legacyStoreWriterGate.beginDrain()).toBe(true)
  expect(
    legacyStoreWriterGate.markHostOwned({
      hostId: 'test-host',
      generation: 1,
      cutoverId: 'test-cutover'
    })
  ).toBe(true)
  // `drain` acknowledges so settleHostCompatibility can confirm the round-start
  // lineage; each D1 phase then proves by count that nothing more drains.
  const persistPort = {
    persist: vi.fn<HostThreadRecordPersistPort['persist']>(),
    enqueue: vi.fn<HostThreadRecordPersistPort['enqueue']>(),
    drain: vi.fn<HostThreadRecordPersistPort['drain']>(async () => undefined),
    drainAll: vi.fn<HostThreadRecordPersistPort['drainAll']>(async () => {
      throw new Error('A D1 dispatch barrier must not drain every Host write')
    }),
    pending: vi.fn(() => 0)
  } satisfies HostThreadRecordPersistPort
  AppStore.setHostThreadRecordPersistPortForTests(persistPort)
  const dispatchBarrier = vi.spyOn(AppStore, 'awaitChatRecordDispatchDurable')
  const fullPersistBarrier = vi.spyOn(AppStore, 'awaitChatRecordPersisted')
  const { createIncrementalChatJournal } = await import('../store/IncrementalChatJournal')
  // Loaded after the store is configured, so nothing it reaches can bind to an
  // unconfigured profile.
  const { EnsembleOrchestrator } = await import('./EnsembleOrchestrator')

  const saves: SaveObservation[] = []
  const tails: TailObservation[] = []
  const dispatched: AgentRunPayload[] = []
  const barrierCallsAtDispatch: number[] = []
  let sequence = 0
  const orchestrator = new EnsembleOrchestrator({
    getChat: (chatId) => AppStore.getChat(chatId),
    saveChat: (chat, options) => {
      const saved = AppStore.saveChat(chat, options)
      saves.push({
        chatId: saved.appChatId,
        revision: saved.persistenceRevision ?? -1,
        atMs: performance.now(),
        messages: JSON.stringify(saved.messages)
      })
    },
    // The broadcast-only tail lane: record what it carried and how much had
    // been saved and appended at that instant.
    broadcastTranscriptTail: (chat) => {
      tails.push({
        chatId: chat.appChatId,
        atMs: performance.now(),
        messages: JSON.stringify(chat.messages),
        saves: saves.length,
        appends: journalAppends.length
      })
    },
    persistChatBarrier: (chatId) => AppStore.awaitChatRecordDispatchDurable(chatId),
    getSettings: () => AppStore.getSettings(),
    dispatch: async (payload, _event, observer) => {
      barrierCallsAtDispatch.push(dispatchBarrier.mock.calls.length)
      dispatched.push(payload)
      observer?.onAdapterInvoked?.({ provider: payload.provider, appRunId: payload.appRunId || '' })
      return { dispatched: true, appRunId: payload.appRunId || '' }
    },
    cancelRun: async () => true,
    createRunId: (provider) => `${provider}-d1-run-${++sequence}`,
    now: () => Date.now(),
    nowIso: () => new Date().toISOString()
  })

  return {
    AppStore,
    persistPort,
    dispatchBarrier,
    fullPersistBarrier,
    saves,
    tails,
    dispatched,
    barrierCallsAtDispatch,
    seed: (
      chatId: string,
      participants: EnsembleParticipant[],
      fanoutPolicy: 'off' | 'read_only' = 'off'
    ): void => {
      const chat = {
        appChatId: chatId,
        chatKind: 'ensemble',
        scope: 'global',
        provider: 'codex',
        title: chatId,
        createdAt: 1,
        updatedAt: 1,
        persistenceRevision: 1,
        archived: false,
        messages: [],
        runs: [],
        ensemble: {
          enabled: true,
          maxParticipants: participants.length,
          maxContinuationHops: 0,
          fanoutPolicy,
          participants
        }
      } as ChatRecord
      const chatsDir = join(profilePath, 'chats')
      mkdirSync(chatsDir, { recursive: true, mode: 0o700 })
      writeFileSync(join(chatsDir, `${chatId}.json`), JSON.stringify(chat), { mode: 0o600 })
    },
    start: (chatId: string, prompt: string) => {
      const result = orchestrator.startRound({
        chatId,
        prompt,
        event: { sender: {} as Electron.WebContents }
      })
      cleanups.push(async () => {
        await orchestrator.cancelRound(chatId, 'D1 durability test cleanup')
      })
      return result
    },
    payloadFor: (participantId: string): AgentRunPayload => {
      const payload = dispatched.find((entry) => entry.ensembleRun?.participantId === participantId)
      if (!payload) throw new Error(`No dispatch reached ${participantId}`)
      return payload
    },
    stream: (payload: AgentRunPayload, event: Record<string, unknown>): boolean =>
      orchestrator.handleProviderOutput(
        payload.provider,
        { appRunId: payload.appRunId, appChatId: payload.appChatId },
        event
      ),
    replay: (chatId: string) =>
      createIncrementalChatJournal(join(profilePath, 'chat-journal-v2'), {
        canWrite: () => false,
        canRepairOnRead: () => false
      }).replay(chatId),
    firstSave: (chatId: string, marker: string): SaveObservation | undefined =>
      saves.find((save) => save.chatId === chatId && save.messages.includes(marker)),
    runStatus: (chatId: string, runId: string | undefined) =>
      AppStore.getChat(chatId)?.runs.find((run) => run.runId === runId)?.status,
    // The round-start Host checkpoint is otherwise never acknowledged, and an
    // unconfirmed checkpoint latches every later materialization: that would hide
    // an unintended D1 Host transfer from the enqueue count.
    settleHostCompatibility: async (chatId: string) => {
      await AppStore.awaitChatRecordPersisted(chatId)
      return {
        enqueued: persistPort.enqueue.mock.calls.length,
        drains: persistPort.drain.mock.calls.length,
        fullBarriers: fullPersistBarrier.mock.calls.length
      }
    }
  }
}

describe('D1 scheduled saves through the real orchestrator and journal', () => {
  it(
    'certifies streamed content and tool rows only after their scheduled save and deferred fsync',
    { timeout: 30_000 },
    async () => {
      const h = await openHarness()
      const chatId = 'd1-serial'
      h.seed(chatId, [seat('writer', 1)])
      const round = h.start(chatId, 'Stream D1 output.')
      expect(round.status).toBe('started')
      await vi.waitFor(() => expect(h.dispatched).toHaveLength(1), WAIT)
      const payload = h.payloadFor('writer')
      // Public admission handed the injected dispatch the run the orchestrator
      // registered, after the production round-start durability barrier.
      expect(payload.ensembleRun).toMatchObject({ roundId: round.roundId, participantId: 'writer' })
      expect(h.dispatchBarrier).toHaveBeenCalledWith(chatId)
      expect(h.barrierCallsAtDispatch[0]).toBeGreaterThan(0)
      await vi.waitFor(() => expect(h.runStatus(chatId, payload.appRunId)).toBe('running'), WAIT)
      expect(pendingFsyncs(chatId)).toBe(0)
      const host = await h.settleHostCompatibility(chatId)
      // A fresh loop turn keeps the flush timer's clock and streamedAt aligned.
      await nextTurn()

      const savesBefore = h.saves.length
      const appendsBefore = journalAppends.length
      const streamedAt = performance.now()
      expect(h.stream(payload, { type: 'content', text: 'D1-ALPHA' })).toBe(true)
      expect(
        h.stream(payload, {
          type: 'tool_use',
          tool_id: 'd1-tool',
          tool_name: 'read_file',
          parameters: { path: 'README.md' }
        })
      ).toBe(true)
      expect(
        h.stream(payload, { type: 'tool_result', tool_id: 'd1-tool', content: 'D1-TOOL-OUTPUT' })
      ).toBe(true)
      expect(h.stream(payload, { type: 'content', text: 'D1-OMEGA' })).toBe(true)
      // Provider output only schedules work: nothing is saved or journaled yet.
      expect(h.saves).toHaveLength(savesBefore)
      expect(journalAppends).toHaveLength(appendsBefore)

      // A barrier taken before the chat flush fires resolves without covering
      // the streamed rows; only a watermark after the scheduled save can.
      await h.AppStore.awaitChatRecordDispatchDurable(chatId)
      expect(rowContaining(h.replay(chatId).record?.messages, 'D1-ALPHA')).toBeUndefined()
      expect(h.saves).toHaveLength(savesBefore)

      await vi.waitFor(() => expect(h.firstSave(chatId, 'D1-ALPHA')).toBeDefined(), WAIT)
      const watermark = h.firstSave(chatId, 'D1-ALPHA')!
      expect(watermark.messages).toContain('D1-OMEGA')
      expect(watermark.messages).toContain('D1-TOOL-OUTPUT')
      // The save came from the 250 ms chat debounce, not the 40 ms tail timer.
      expect(watermark.atMs - streamedAt).toBeGreaterThanOrEqual(200)
      // The 40 ms tail lane painted the rows before any save or append had them.
      const tail = h.tails.find(
        (frame) => frame.chatId === chatId && frame.messages.includes('D1-ALPHA')
      )
      expect(tail).toBeDefined()
      expect(tail!.atMs).toBeLessThan(watermark.atMs)
      const savedBeforeTail = h.saves.slice(0, tail!.saves)
      const appendedBeforeTail = journalAppends.slice(0, tail!.appends)
      expect(savedBeforeTail.some((save) => save.messages.includes('D1-ALPHA'))).toBe(false)
      expect(appendedBeforeTail.some((append) => append.body.includes('D1-ALPHA'))).toBe(false)

      const d1 = journalAppends.filter(
        (append) => append.chatId === chatId && append.body.includes('D1-ALPHA')
      )
      expect(d1).toHaveLength(1)
      expect(d1[0]).toMatchObject({
        revision: watermark.revision,
        requested: 'deferred',
        deferred: true
      })
      expect(d1[0]!.operations).not.toContain('run_put')
      expect(d1[0]!.operations).not.toContain('runs_splice')
      expect(pendingFsyncs(chatId)).toBe(1)

      const barrier = h.AppStore.awaitChatRecordDispatchDurable(chatId)
      expect(await settlesWithin(barrier)).toBe(false)
      // Readable journal bytes are not the witness: they replay before the fsync.
      expect(rowContaining(h.replay(chatId).record?.messages, 'D1-OMEGA')).toBeDefined()
      acknowledgeJournalFsyncs(chatId)
      await barrier

      const replayed = h.replay(chatId)
      expect(replayed.revision).toBeGreaterThanOrEqual(watermark.revision)
      const messages = replayed.record?.messages ?? []
      const alpha = rowContaining(messages, 'D1-ALPHA')
      const omega = rowContaining(messages, 'D1-OMEGA')
      const tool = messages.find(
        (message) => message.role === 'tool' && message.runId === payload.appRunId
      )
      expect(alpha).toMatchObject({
        role: 'assistant',
        runId: payload.appRunId,
        metadata: expect.objectContaining({
          kind: 'ensembleParticipant',
          ensembleRoundId: round.roundId,
          ensembleParticipantId: 'writer'
        })
      })
      expect(omega?.runId).toBe(payload.appRunId)
      expect(tool?.toolActivities?.[0]).toMatchObject({ id: 'd1-tool', status: 'success' })
      const indexes = [alpha, tool, omega].map((row) => (row ? messages.indexOf(row) : -1))
      expect(indexes.every((index, position) => index > (indexes[position - 1] ?? -1))).toBe(true)
      // Neither the D1 save nor its barrier moved a Host compatibility record.
      expect(h.persistPort.enqueue).toHaveBeenCalledTimes(host.enqueued)
      expect(h.persistPort.drain).toHaveBeenCalledTimes(host.drains)
      expect(h.persistPort.drainAll).not.toHaveBeenCalled()
      expect(h.fullPersistBarrier).toHaveBeenCalledTimes(host.fullBarriers)

      // The terminal result is strict: every later append syncs before return.
      expect(h.stream(payload, { type: 'result', status: 'success' })).toBe(true)
      await vi.waitFor(() => expect(h.runStatus(chatId, payload.appRunId)).toBe('success'), WAIT)
      const terminal = journalAppends.filter(
        (append) => append.chatId === chatId && append.revision > watermark.revision
      )
      expect(terminal.length).toBeGreaterThan(0)
      expect(terminal.every((append) => !append.deferred)).toBe(true)
      expect(pendingFsyncs(chatId)).toBe(0)
      // Positive control: the same port sees the terminal boundary materialize the
      // record, so the D1 silence above is not an artefact of the harness.
      expect(h.persistPort.enqueue.mock.calls.length).toBeGreaterThan(host.enqueued)
      expect(
        h.replay(chatId).record?.runs.find((run) => run.runId === payload.appRunId)?.status
      ).toBe('success')
      expectStrictBoundariesImmediate(chatId)
    }
  )

  it(
    'coalesces two dirty lanes of one chat into one scheduled save and one deferred append',
    { timeout: 30_000 },
    async () => {
      const h = await openHarness()
      const chatId = 'd1-lanes'
      h.seed(chatId, [seat('scout-a', 1, 'scout'), seat('scout-b', 2, 'scout')], 'read_only')
      expect(h.start(chatId, 'Two scouts stream at once.').status).toBe('started')
      await vi.waitFor(() => expect(h.dispatched).toHaveLength(2), WAIT)
      const laneA = h.payloadFor('scout-a')
      const laneB = h.payloadFor('scout-b')
      await vi.waitFor(() => {
        expect(h.runStatus(chatId, laneA.appRunId)).toBe('running')
        expect(h.runStatus(chatId, laneB.appRunId)).toBe('running')
      }, WAIT)
      expect(pendingFsyncs(chatId)).toBe(0)
      const host = await h.settleHostCompatibility(chatId)

      const savesBefore = h.saves.length
      const appendsBefore = journalAppends.length
      expect(h.stream(laneA, { type: 'content', text: 'D1-LANE-A' })).toBe(true)
      expect(h.stream(laneB, { type: 'content', text: 'D1-LANE-B' })).toBe(true)
      const carriesLane = (text: string): boolean =>
        text.includes('D1-LANE-A') || text.includes('D1-LANE-B')
      await vi.waitFor(
        () =>
          expect(h.saves.slice(savesBefore).some((save) => carriesLane(save.messages))).toBe(true),
        WAIT
      )
      const coalesced = h.saves.slice(savesBefore).find((save) => carriesLane(save.messages))!
      expect(coalesced.messages).toContain('D1-LANE-A')
      expect(coalesced.messages).toContain('D1-LANE-B')
      const laneAppends = journalAppends
        .slice(appendsBefore)
        .filter((append) => carriesLane(append.body))
      expect(laneAppends).toHaveLength(1)
      expect(laneAppends[0]).toMatchObject({
        chatId,
        revision: coalesced.revision,
        requested: 'deferred',
        deferred: true
      })
      expect(laneAppends[0]!.body).toContain('D1-LANE-A')
      expect(laneAppends[0]!.body).toContain('D1-LANE-B')
      expect(pendingFsyncs(chatId)).toBe(1)

      const barrier = h.AppStore.awaitChatRecordDispatchDurable(chatId)
      expect(await settlesWithin(barrier)).toBe(false)
      acknowledgeJournalFsyncs(chatId)
      await barrier
      const messages = h.replay(chatId).record?.messages
      expect(rowContaining(messages, 'D1-LANE-A')).toMatchObject({
        runId: laneA.appRunId,
        metadata: expect.objectContaining({ ensembleParticipantId: 'scout-a' })
      })
      expect(rowContaining(messages, 'D1-LANE-B')).toMatchObject({
        runId: laneB.appRunId,
        metadata: expect.objectContaining({ ensembleParticipantId: 'scout-b' })
      })
      expect(h.persistPort.enqueue).toHaveBeenCalledTimes(host.enqueued)
      expect(h.persistPort.drain).toHaveBeenCalledTimes(host.drains)
      expectStrictBoundariesImmediate(chatId)
    }
  )

  it(
    'keeps independent chats on separate saves, journal appends and barriers',
    { timeout: 30_000 },
    async () => {
      const h = await openHarness()
      h.seed('d1-left', [seat('left', 1)])
      h.seed('d1-right', [seat('right', 1)])
      h.start('d1-left', 'Left streams.')
      h.start('d1-right', 'Right streams.')
      await vi.waitFor(() => expect(h.dispatched).toHaveLength(2), WAIT)
      const left = h.payloadFor('left')
      const right = h.payloadFor('right')
      await vi.waitFor(() => {
        expect(h.runStatus('d1-left', left.appRunId)).toBe('running')
        expect(h.runStatus('d1-right', right.appRunId)).toBe('running')
      }, WAIT)

      expect(h.stream(left, { type: 'content', text: 'D1-LEFT' })).toBe(true)
      expect(h.stream(right, { type: 'content', text: 'D1-RIGHT' })).toBe(true)
      await vi.waitFor(() => {
        expect(h.firstSave('d1-left', 'D1-LEFT')).toBeDefined()
        expect(h.firstSave('d1-right', 'D1-RIGHT')).toBeDefined()
      }, WAIT)
      expect(h.firstSave('d1-left', 'D1-LEFT')!.messages).not.toContain('D1-RIGHT')
      expect(h.firstSave('d1-right', 'D1-RIGHT')!.messages).not.toContain('D1-LEFT')
      expect(pendingFsyncs('d1-left')).toBe(1)
      expect(pendingFsyncs('d1-right')).toBe(1)

      const leftBarrier = h.AppStore.awaitChatRecordDispatchDurable('d1-left')
      const rightBarrier = h.AppStore.awaitChatRecordDispatchDurable('d1-right')
      acknowledgeJournalFsyncs('d1-right')
      // The right barrier needs only its own chat's fsync, and that fsync does
      // not certify the left chat's journal.
      expect(await settlesWithin(rightBarrier)).toBe(true)
      await rightBarrier
      expect(await settlesWithin(leftBarrier)).toBe(false)
      acknowledgeJournalFsyncs('d1-left')
      await leftBarrier
      const leftRows = h.replay('d1-left').record?.messages
      const rightRows = h.replay('d1-right').record?.messages
      expect(rowContaining(leftRows, 'D1-LEFT')?.runId).toBe(left.appRunId)
      expect(rowContaining(leftRows, 'D1-RIGHT')).toBeUndefined()
      expect(rowContaining(rightRows, 'D1-RIGHT')?.runId).toBe(right.appRunId)
      expect(rowContaining(rightRows, 'D1-LEFT')).toBeUndefined()
    }
  )

  it(
    'holds the barrier for every issued deferred fsync, however late or out of order',
    { timeout: 30_000 },
    async () => {
      const h = await openHarness()
      const chatId = 'd1-delayed'
      h.seed(chatId, [seat('writer', 1)])
      h.start(chatId, 'Stream across two flush windows.')
      await vi.waitFor(() => expect(h.dispatched).toHaveLength(1), WAIT)
      const payload = h.payloadFor('writer')
      await vi.waitFor(() => expect(h.runStatus(chatId, payload.appRunId)).toBe('running'), WAIT)

      expect(h.stream(payload, { type: 'content', text: 'D1-FIRST' })).toBe(true)
      await vi.waitFor(() => expect(h.firstSave(chatId, 'D1-FIRST')).toBeDefined(), WAIT)
      expect(h.stream(payload, { type: 'content', text: ' D1-SECOND' })).toBe(true)
      await vi.waitFor(() => expect(h.firstSave(chatId, 'D1-SECOND')).toBeDefined(), WAIT)
      const newest = h.firstSave(chatId, 'D1-SECOND')!
      expect(newest.revision).toBeGreaterThan(h.firstSave(chatId, 'D1-FIRST')!.revision)
      expect(pendingFsyncs(chatId)).toBe(2)

      const barrier = h.AppStore.awaitChatRecordDispatchDurable(chatId)
      // No clock releases the barrier while an fsync is outstanding.
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(await settlesWithin(barrier)).toBe(false)
      acknowledgeJournalFsync(chatId, 'newest')
      expect(await settlesWithin(barrier)).toBe(false)
      acknowledgeJournalFsync(chatId, 'oldest')
      await barrier
      const replayed = h.replay(chatId)
      expect(replayed.revision).toBeGreaterThanOrEqual(newest.revision)
      expect(rowContaining(replayed.record?.messages, 'D1-SECOND')?.content).toContain('D1-FIRST')
    }
  )

  it(
    'fails the barrier closed on a deferred fsync error until a sync append re-establishes durability',
    { timeout: 30_000 },
    async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      const h = await openHarness()
      const chatId = 'd1-fsync-error'
      h.seed(chatId, [seat('writer', 1)])
      h.start(chatId, 'Stream through an fsync failure.')
      await vi.waitFor(() => expect(h.dispatched).toHaveLength(1), WAIT)
      const payload = h.payloadFor('writer')
      await vi.waitFor(() => expect(h.runStatus(chatId, payload.appRunId)).toBe('running'), WAIT)

      expect(h.stream(payload, { type: 'content', text: 'D1-UNACKNOWLEDGED' })).toBe(true)
      await vi.waitFor(() => expect(h.firstSave(chatId, 'D1-UNACKNOWLEDGED')).toBeDefined(), WAIT)
      expect(pendingFsyncs(chatId)).toBe(1)
      const pending = h.AppStore.awaitChatRecordDispatchDurable(chatId)
      const failure: NodeJS.ErrnoException = Object.assign(
        new Error('EIO: injected deferred journal fsync failure'),
        { code: 'EIO' }
      )
      takeJournalFsync(chatId, 'oldest').done(failure)
      await expect(pending).rejects.toBe(failure)
      // The failure is sticky, although the unacknowledged bytes still replay.
      await expect(h.AppStore.awaitChatRecordDispatchDurable(chatId)).rejects.toBe(failure)
      expect(rowContaining(h.replay(chatId).record?.messages, 'D1-UNACKNOWLEDGED')).toBeDefined()
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('deferred journal fsync failed'),
        failure
      )

      expect(h.stream(payload, { type: 'content', text: ' D1-RECOVERED' })).toBe(true)
      await vi.waitFor(() => expect(h.firstSave(chatId, 'D1-RECOVERED')).toBeDefined(), WAIT)
      // The scheduled save still asks for D1; the journal escalates this one
      // append to a synchronous fsync, which re-establishes durable ground.
      expect(
        journalAppends.find(
          (append) => append.chatId === chatId && append.body.includes('D1-RECOVERED')
        )
      ).toMatchObject({ requested: 'deferred', deferred: false })
      expect(pendingFsyncs(chatId)).toBe(0)
      await expect(h.AppStore.awaitChatRecordDispatchDurable(chatId)).resolves.toBeUndefined()
      const recovered = rowContaining(h.replay(chatId).record?.messages, 'D1-RECOVERED')
      expect(recovered?.content).toContain('D1-UNACKNOWLEDGED')
      expectStrictBoundariesImmediate(chatId)
    }
  )
})
