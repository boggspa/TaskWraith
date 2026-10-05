/**
 * The files of one thread, each written without a sync, reach the disk in
 * whatever order the system writes them out, so after a power loss they can
 * disagree. Each test here leaves two of them disagreeing and reads the
 * thread back through the readers the app has today: the journal's replay,
 * the canonical load the app and the history worker share, the tool-detail
 * reader, the run-event reader and the catalogue's. It pins, as current
 * behaviour, whether the record loads, what stands in for the part that is
 * missing, and that nothing the staging made durable or a resolved barrier
 * covered is lost. Tool detail reaches a record only through the staging,
 * once its own syncs made it durable; the cases where its bytes are missing
 * behind a reference are kept as pins of what the readers tolerate when a
 * disk loses them anyway.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ThreadCatalogue,
  type ThreadCatalogueTicket
} from '../../host-shared/thread-catalogue/ThreadCatalogue'
import { parseRunEventLine } from '../RunEventStore'
import { clearRunEventReplayCache, getRunEventReplaySync } from '../RunEventReplayCache'
import { deriveChatRecordMutation } from './ChatRecordMutation'
import { compactToolActivityWithDetailRef } from './ChatToolDetailExternalization'
import { createIncrementalChatJournal, type IncrementalChatJournal } from './IncrementalChatJournal'
import { MainCatalogueUnsyncedDurability } from './MainCatalogueUnsyncedDurability'
import { readRunEventLedgerHead } from './RunEventLedgerHead'
import { RunEventLedgerWriter } from './RunEventLedgerWriter'
import {
  ThreadCatalogueDiskReader,
  captureThreadCatalogueWitness,
  projectThreadCatalogueRecord
} from './ThreadCatalogueDiskReader'
import { createThreadDurabilityDebt, type ThreadDurabilityDebt } from './ThreadDurabilityDebt'
import {
  TOOL_ACTIVITY_DETAIL_ARTIFACT_NAME,
  ToolActivityDetailBatchWriter,
  hydrateToolActivityDetails,
  readToolActivityDetailSync
} from './ToolActivityDetailLedger'
import { createToolActivityDetailStaging } from './ToolActivityDetailStaging'
import type { ChatRecord, RunEventInput, RunEventRecord, ToolActivity } from './types'
import { watchCrashDisk, type CrashDisk } from './unsyncedWriteCrashDisk.testutil'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'log-cross-file-power-loss-'

/** Remove, with all it holds, a folder made here by `mkdtempSync` with TEMPORARY_PREFIX. */
function removeTemporaryDirectory(directory: string): void {
  const temporary = os.tmpdir()
  const made = temporary + path.sep + TEMPORARY_PREFIX
  if (
    directory === temporary ||
    !directory.startsWith(made) ||
    directory.length <= made.length ||
    path.dirname(directory) !== temporary
  )
    throw new Error(`Refusing to remove ${directory}: not a folder this file made`)
  fs.rmSync(directory, { recursive: true, force: true })
}

const CHAT = 'chat-1'
const RUN = 'run-1'
const READER = { runtimeInstanceId: 'reader', segmented: false }

/** Revision 1: the user's message, and the run it started. */
function started(): ChatRecord {
  return {
    appChatId: CHAT,
    title: 'Cross-file history',
    scope: 'global',
    chatKind: 'single',
    provider: 'claude',
    createdAt: 1,
    updatedAt: 1,
    persistenceRevision: 1,
    messages: [
      {
        id: 'message-1',
        role: 'user',
        content: 'Run the tests',
        timestamp: '2026-10-05T00:00:00.000Z'
      }
    ],
    runs: [{ runId: RUN, startedAt: '2026-10-05T00:00:00.000Z', status: 'running' }]
  } as ChatRecord
}

/** The next revision, with the assistant's reply carrying these tool calls. */
function replied(previous: ChatRecord, activities: ToolActivity[]): ChatRecord {
  const next = structuredClone(previous)
  next.persistenceRevision = (previous.persistenceRevision ?? 0) + 1
  next.updatedAt = next.persistenceRevision
  next.messages.push({
    id: `message-${next.persistenceRevision}`,
    role: 'assistant',
    content: 'Ran them.',
    timestamp: '2026-10-05T00:00:01.000Z',
    runId: RUN,
    toolActivities: activities
  })
  return next
}

/** The next revision, with the run's final record. */
function finished(previous: ChatRecord): ChatRecord {
  const next = structuredClone(previous)
  next.persistenceRevision = (previous.persistenceRevision ?? 0) + 1
  next.updatedAt = next.persistenceRevision
  next.runs[0] = {
    ...next.runs[0],
    status: 'completed',
    endedAt: '2026-10-05T00:00:02.000Z',
    exitCode: 0
  }
  return next
}

function activity(id: string): ToolActivity {
  return {
    id,
    toolName: 'run_shell_command',
    displayName: 'Ran command',
    category: 'shell',
    status: 'success',
    endedAt: '2026-10-05T00:00:01.000Z',
    parameters: { command: `npm test -- ${id}` },
    resultSummary: `${id} passed`,
    rawResultEvent: { output: `output of ${id}` }
  }
}

function event(sequence: number, overrides: Partial<RunEventInput> = {}): RunEventInput {
  return {
    id: `event-${sequence}`,
    runId: RUN,
    chatId: CHAT,
    kind: 'provider_raw',
    phase: 'raw',
    source: 'provider',
    payload: { data: `output ${sequence}\n` },
    timestamp: '2026-10-05T00:00:00.000Z',
    ...overrides
  }
}

const lifecycle = (sequence: number, state: string): RunEventInput =>
  event(sequence, { kind: 'lifecycle', phase: 'control', payload: { state } })

/** The app's run-event file reader (`readRunEventFile`, private to the store), line for line. */
function readRunEventFile(filePath: string): RunEventRecord[] {
  if (!fs.existsSync(filePath)) return []
  return fs
    .readFileSync(filePath, 'utf-8')
    .split(/\r?\n/)
    .map(parseRunEventLine)
    .filter((record): record is RunEventRecord => record !== null)
}

describe.skipIf(process.platform === 'win32')(
  'what a power loss leaves when a thread’s files disagree',
  () => {
    let root: string
    let journalDir: string
    let runEventsDir: string
    let runArtifactsDir: string
    let disk: CrashDisk
    let debt: ThreadDurabilityDebt
    let journal: IncrementalChatJournal

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
      journalDir = path.join(root, 'chat-journal-v2')
      runEventsDir = path.join(root, 'run-events')
      runArtifactsDir = path.join(root, 'run-artifacts')
      // A profile in use for a while: its directories and the Host's full
      // copy of the thread at revision 1 are on the disk already.
      for (const directory of [journalDir, runEventsDir, runArtifactsDir]) {
        fs.mkdirSync(directory, { recursive: true })
      }
      fs.mkdirSync(path.join(root, 'chats'))
      fs.writeFileSync(path.join(root, 'chats', `${CHAT}.json`), JSON.stringify(started()))
      disk = watchCrashDisk(root)
      debt = createThreadDurabilityDebt({ port: disk.port })
      journal = createIncrementalChatJournal(journalDir, { noteDurabilityDebt: debt.note })
      journal.initialize(CHAT, started())
    })

    afterEach(() => {
      disk.dispose()
      clearRunEventReplayCache()
      removeTemporaryDirectory(root)
    })

    const segment = (): string => path.join(journalDir, `${CHAT}.mutations.jsonl`)
    const eventsFile = (): string => path.join(runEventsDir, `${RUN}.jsonl`)
    const append = (previous: ChatRecord, next: ChatRecord): ChatRecord => {
      journal.append(deriveChatRecordMutation(previous, next))
      return next
    }
    /** The system wrote these out by itself: no barrier was raised for them. */
    const writtenOut = (...targets: string[]): void => {
      for (const target of targets) disk.flushedAnyway(target)
    }
    const replayed = (): ReturnType<IncrementalChatJournal['replay']> =>
      createIncrementalChatJournal(journalDir, { canWrite: () => false }).replay(CHAT)
    /** What the app and the history worker load: the full copy or the journal, whichever leads. */
    const loaded = (): ChatRecord =>
      new ThreadCatalogueDiskReader({ profilePath: root, ...READER }).read(CHAT)!.chat
    const runEvents = (): RunEventRecord[] =>
      getRunEventReplaySync(RUN, eventsFile(), readRunEventFile).events
    const eventWriter = (): RunEventLedgerWriter =>
      new RunEventLedgerWriter({ runEventsDir, runArtifactsDir, noteDurabilityDebt: debt.note })

    /**
     * A tool call whose detail is written without any sync, and a reply that
     * references it appended. Nothing in the app writes detail so now: it is
     * the state a disk that lost the bytes leaves.
     */
    const toolCall = (
      previous: ChatRecord,
      id: string
    ): { record: ChatRecord; ref: ToolActivity } => {
      const writer = new ToolActivityDetailBatchWriter(runArtifactsDir)
      const ref = writer.stage(RUN, activity(id))!
      writer.writeUnsynced()
      const compact = compactToolActivityWithDetailRef(activity(id), ref)
      return { record: append(previous, replied(previous, [compact])), ref: compact }
    }

    it('keeps everything the staging made durable and a resolved barrier covered, in every file of the thread', async () => {
      const events = eventWriter()
      events.append(lifecycle(1, 'running'))
      const staging = createToolActivityDetailStaging({
        runArtifactsDir,
        port: disk.port,
        appendRunEvent: (input) => events.appendStaged(input),
        checkpointInput: (chat, checkpoint) => ({
          ...event(0, { kind: 'tool', phase: 'artifact', source: 'main' }),
          chatId: chat.appChatId,
          payload: { type: 'tool_activity_detail_checkpoint', sha256: checkpoint.sha256 }
        })
      })
      // The reply goes in with its tool call inline, and the call's detail is staged.
      const first = staging.batch(started())
      expect(first.stage(RUN, activity('tool-1'))).toBeNull()
      first.commit()
      const inline = append(started(), replied(started(), [activity('tool-1')]))
      await vi.waitFor(() => expect(staging.snapshot().batches.durable).toBe(1))
      // A later save takes the ref the batch made durable, and strips the row.
      const next = staging.batch(inline)
      const ref = next.stage(RUN, activity('tool-1'))!
      next.commit()
      const withRef = structuredClone(inline)
      withRef.persistenceRevision = (inline.persistenceRevision ?? 0) + 1
      withRef.messages[1].toolActivities = [
        compactToolActivityWithDetailRef(activity('tool-1'), ref)
      ]
      append(inline, withRef)
      events.append(lifecycle(2, 'completed'))
      const done = append(withRef, finished(withRef))
      // The barrier pays the journal and the run's events; the detail, its
      // folders and its checkpoint were paid by the staging's own syncs.
      await debt.barrier(CHAT)

      disk.powerLoss()

      expect(replayed()).toMatchObject({ revision: 4, appliedBatches: 3 })
      expect(loaded().runs[0]).toMatchObject({ status: 'completed' })
      expect(loaded().persistenceRevision).toBe(done.persistenceRevision)
      expect(loaded().messages[1].toolActivities![0].detailRef).toEqual(ref)
      expect(readToolActivityDetailSync(runArtifactsDir, ref)).toEqual(
        expect.objectContaining({ id: 'tool-1', parameters: activity('tool-1').parameters })
      )
      // The run's two events, and the checkpoint the staging appended between them.
      expect(runEvents().map((record) => record.sequence)).toEqual([1, 2, 3])
      expect(runEvents()[1].payload).toMatchObject({ type: 'tool_activity_detail_checkpoint' })
    })

    describe('tool detail and the journal', () => {
      it('loads a reply whose tool detail did not survive, and the detail reads as unavailable', async () => {
        await debt.barrier(CHAT)
        const { ref } = toolCall(started(), 'tool-1')
        writtenOut(segment(), journalDir)

        disk.powerLoss()

        expect(replayed()).toMatchObject({ revision: 2, appliedBatches: 1 })
        const tool = loaded().messages[1].toolActivities![0]
        // The row keeps its name, status and a reference; its detail is gone.
        expect(tool).toMatchObject({ id: 'tool-1', status: 'success', detailRef: ref.detailRef })
        expect(tool.parameters).toBeUndefined()
        expect(fs.existsSync(path.join(runArtifactsDir, RUN))).toBe(false)
        expect(readToolActivityDetailSync(runArtifactsDir, ref.detailRef!)).toBeNull()
        await expect(
          hydrateToolActivityDetails(runArtifactsDir, [ref.detailRef!])
        ).resolves.toEqual([])
      })

      it('loads the thread without a reply whose detail survived, and the detail is left unreferenced', async () => {
        await debt.barrier(CHAT)
        const { ref } = toolCall(started(), 'tool-1')
        const file = path.join(runArtifactsDir, RUN, TOOL_ACTIVITY_DETAIL_ARTIFACT_NAME)
        writtenOut(file, path.join(runArtifactsDir, RUN), runArtifactsDir)

        disk.powerLoss()

        expect(replayed()).toMatchObject({ revision: 1, appliedBatches: 0 })
        expect(loaded().messages).toHaveLength(1)
        expect(readToolActivityDetailSync(runArtifactsDir, ref.detailRef!)).toMatchObject({
          id: 'tool-1'
        })
        // The run's next detail goes after the bytes nothing references.
        const next = new ToolActivityDetailBatchWriter(runArtifactsDir).stage(
          RUN,
          activity('tool-2')
        )!
        expect(next.offset).toBe(ref.detailRef!.offset + ref.detailRef!.byteLength)
      })
    })

    describe('run events and the journal', () => {
      it('loads a finished run whose event file ends early, and the run shows the events that are left', async () => {
        await debt.barrier(CHAT)
        const events = eventWriter()
        const first = events.append(lifecycle(1, 'running'))
        writtenOut(eventsFile(), runEventsDir)
        events.append(event(2))
        events.append(lifecycle(3, 'completed'))
        append(started(), finished(started()))
        writtenOut(segment(), journalDir)

        disk.powerLoss()

        expect(loaded().runs[0]).toMatchObject({ status: 'completed', exitCode: 0 })
        expect(runEvents()).toEqual([first])
        expect(getRunEventReplaySync(RUN, eventsFile(), readRunEventFile)).toMatchObject({
          count: 1,
          lastSequence: 1,
          hashChainValid: true
        })
        // A later event for the run carries the chain on from what is left.
        expect(readRunEventLedgerHead(eventsFile())).toEqual({ sequence: 1, hash: first.hash })
      })

      it('loads a finished run whose event file never reached the disk, and the run shows no events', async () => {
        await debt.barrier(CHAT)
        const events = eventWriter()
        events.append(lifecycle(1, 'running'))
        events.append(lifecycle(2, 'completed'))
        append(started(), finished(started()))
        writtenOut(segment(), journalDir)

        disk.powerLoss()

        expect(loaded().runs[0]).toMatchObject({ status: 'completed' })
        expect(fs.existsSync(eventsFile())).toBe(false)
        expect(getRunEventReplaySync(RUN, eventsFile(), readRunEventFile)).toMatchObject({
          count: 0,
          hashChainValid: true
        })
        expect(readRunEventLedgerHead(eventsFile())).toBeNull()
      })

      it('loads a run as still running when its events reached the end and its final record did not, and leaves it to be settled', async () => {
        await debt.barrier(CHAT)
        const events = eventWriter()
        events.append(lifecycle(1, 'running'))
        events.append(lifecycle(2, 'completed'))
        writtenOut(eventsFile(), runEventsDir)
        append(started(), finished(started()))

        disk.powerLoss()

        expect(replayed()).toMatchObject({ revision: 1 })
        const thread = loaded()
        expect(thread.runs[0]).toMatchObject({ status: 'running' })
        expect(thread.runs[0].endedAt).toBeUndefined()
        // The catalogue counts it for the sweep that settles interrupted runs.
        expect(projectThreadCatalogueRecord(thread).recovery.unsettledRuns).toBe(1)
        expect(runEvents().map((record) => record.payload)).toEqual([
          { state: 'running' },
          { state: 'completed' }
        ])
      })
    })

    describe('catalogue heads and the journal', () => {
      let source: ThreadCatalogue
      let resolver: ThreadCatalogue

      beforeEach(() => {
        const make = (deferredDurability?: MainCatalogueUnsyncedDurability): ThreadCatalogue =>
          new ThreadCatalogue({
            profilePath: root,
            writer: 'desktop',
            writerId: 'desktop-1',
            canWrite: () => true,
            writerLifecycle: () => 'active',
            canPublishResolution: () => true,
            canErase: () => true,
            isSourceWitnessCurrent: (chatId, witness) =>
              captureThreadCatalogueWitness({ profilePath: root, ...READER }, chatId).witness ===
              witness,
            isIndexedGenerationCommitted: () => true,
            deferredDurability
          })
        source = make(new MainCatalogueUnsyncedDurability({ profilePath: root }))
        resolver = make()
        source.registerWriter()
      })

      /** A publication of the record as it is now, as the source writer makes one. */
      const publish = (record: ChatRecord): ThreadCatalogueTicket => {
        const ticket = source.beginPublication(CHAT)
        const projection = projectThreadCatalogueRecord(record)
        expect(
          source.finishPublication(
            ticket,
            {
              operationId: ticket.operationId,
              sequence: ticket.sequence,
              revision: projection.revision,
              sourceWitness: captureThreadCatalogueWitness({ profilePath: root, ...READER }, CHAT)
                .witness
            },
            projection
          )
        ).toBe(true)
        return ticket
      }

      /** The history worker's import: decode the sources, resolve, acknowledge. */
      const index = (): number | null => {
        const decoded = new ThreadCatalogueDiskReader({ profilePath: root, ...READER }).read(CHAT)!
        const projection = projectThreadCatalogueRecord(decoded.persisted)
        if (resolver.publicationPending(CHAT)) return null
        const published = resolver.publishResolution({
          chatId: CHAT,
          epoch: resolver.epoch(CHAT),
          heads: resolver.sourceHeads(CHAT),
          sourceWitness: decoded.source.witness,
          indexReference: { databaseId: 'database', generation: `g-${projection.revision}` },
          projection
        })
        const row = resolver.read(CHAT)
        if (!published || row.status !== 'ready') return null
        resolver.acknowledgeResolution(CHAT, row.publicationId)
        return row.projection.revision
      }

      it('puts a row ahead of the journal back in step with it once the worker derives it again', async () => {
        publish(started())
        await debt.barrier(CHAT)
        expect(index()).toBe(1)
        const done = append(started(), finished(started()))
        publish(done)
        expect(index()).toBe(2)
        // The head reached the disk, and the journal line it was published for did not.
        writtenOut(path.join(source.directory, 'desktop', `${CHAT}.json`))
        writtenOut(path.join(source.directory, 'desktop'))

        disk.powerLoss()

        expect(replayed()).toMatchObject({ revision: 1 })
        expect(resolver.read(CHAT)).toMatchObject({
          status: 'repair-pending',
          summary: { title: 'Cross-file history' }
        })
        expect(index()).toBe(1)
        expect(resolver.read(CHAT)).toMatchObject({ status: 'ready', projection: { revision: 1 } })
      })

      it('brings a row behind the journal up to it once the worker derives it again', async () => {
        publish(started())
        await debt.barrier(CHAT)
        expect(index()).toBe(1)
        const done = append(started(), finished(started()))
        publish(done)
        // The journal line reached the disk, and the head published for it did not.
        writtenOut(segment(), journalDir)

        disk.powerLoss()

        expect(replayed()).toMatchObject({ revision: 2 })
        expect(resolver.read(CHAT)).toMatchObject({ status: 'repair-pending' })
        expect(index()).toBe(2)
        expect(resolver.read(CHAT)).toMatchObject({ status: 'ready', projection: { revision: 2 } })
      })
    })
  }
)
