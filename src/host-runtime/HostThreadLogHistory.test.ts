/**
 * History served from a followed thread's log. Pages are checked against the
 * profile store's `threadHistory` over the record the app wrote, at every
 * revision; deltas, through a client that takes pages and deltas as the
 * terminal app does, against a client that loads the tail again.
 */
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { applyThreadLogBatch } from '../host-shared/thread-log/ThreadLogApply'
import {
  THREAD_LOG_BATCH_FORMAT,
  THREAD_LOG_BATCH_VERSION,
  type ThreadLogOperation
} from '../host-shared/thread-log/ThreadLogBatch'
import {
  deriveChatRecordMutation,
  type ChatRecordMutationBatch
} from '../main/store/ChatRecordMutation'
import { prepareCheckpoint } from '../main/store/CheckpointPreparationCore'
import {
  checkpointFileReference,
  type CheckpointPreparationJob,
  type CheckpointPreparationPort,
  type CheckpointPreparationRequest,
  type CheckpointPreparationSource,
  type PreparedCheckpoint
} from '../main/store/CheckpointPreparationProtocol'
import {
  createIncrementalChatJournal,
  type IncrementalChatJournal,
  type IncrementalChatJournalOptions
} from '../main/store/IncrementalChatJournal'
import type { ChatMessage, ChatRecord, ChatRun } from '../main/store/types'
import {
  decodeHostHistorySinceResult,
  decodeHostThreadHistoryPage,
  decodeHostTranscriptHistoryEntry,
  type HostHistoryCursor,
  type HostHistorySinceResult,
  type HostThreadHistoryPage,
  type HostThreadHistoryRequest,
  type HostTranscriptHistoryEntry
} from '../shared/hostHistoryProtocol'
import { classifyHistoryResult } from '../tui/historyReconcile'
import type { TuiHistoryState } from '../tui/state'
import { HOST_PROFILE_CHATS_DIRECTORY, HostProfileDomainStore } from './HostProfileDomainStore'
import {
  HostThreadLogFollower,
  type HostThreadLogRecord,
  type HostThreadLogSeedPort,
  type HostThreadLogSeedRequest,
  type HostThreadLogWindowSeed
} from './HostThreadLogFollower'
import {
  HOST_THREAD_LOG_HISTORY_GENERATION_BASE,
  HOST_THREAD_LOG_HISTORY_LAG_BOUNDS_MS,
  HOST_THREAD_LOG_HISTORY_MAX_RETAINED_BATCHES,
  HOST_THREAD_LOG_HISTORY_SEQUENCE_SPAN,
  HostThreadLogHistory,
  hostThreadLogEntriesBefore,
  hostThreadLogHistoryEntries,
  type HostThreadLogHistoryGenerationCause,
  type HostThreadLogHistoryOptions
} from './HostThreadLogHistory'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'host-log-history-'

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
const AT = '2026-10-05T00:00:00.000Z'

function message(
  id: string,
  role: ChatMessage['role'],
  content: string,
  extra: Partial<ChatMessage> = {}
): ChatMessage {
  return { id, role, content, timestamp: AT, ...extra }
}

function run(runId: string, extra: Record<string, unknown> = {}): ChatRun {
  return { runId, startedAt: AT, status: 'running', ...extra } as ChatRun
}

/** A tool row as a run carries it for the history. */
function tool(id: string, status: 'running' | 'success' | 'error'): Record<string, unknown> {
  return { id, name: 'Read', category: 'read', status }
}

const ACTIVITY_STATUSES = ['running', 'success', 'error', 'warning', 'pending'] as const

/**
 * A tool activity as the app stores one on a message: rows the desktop draws
 * and rows it leaves out (reasoning, an MCP envelope, housekeeping).
 */
function appActivity(id: string, kind: number, status: string): Record<string, unknown> {
  const file = `src/f${kind}.ts`
  switch (kind % 7) {
    case 0:
      return {
        id,
        toolName: 'Read',
        displayName: `Read ${file}`,
        category: 'read',
        status,
        parameters: { file_path: file },
        filePath: file,
        affectedFilePath: file
      }
    case 1:
      return {
        id,
        toolName: 'Edit',
        displayName: `Edited ${file}`,
        category: 'write',
        status,
        parameters: { file_path: file, old_string: 'a', new_string: 'b' },
        filePath: file,
        diffSummary: {
          additions: kind,
          deletions: 1,
          source: 'string_replace',
          confidence: 'exact'
        }
      }
    case 2:
      return {
        id,
        toolName: 'run_shell_command',
        displayName: 'Shell command',
        category: 'shell',
        status,
        parameters: { command: 'npm test' }
      }
    case 3:
      return { id, toolName: 'codex_reasoning', displayName: 'Thinking', category: 'task', status }
    case 4:
      return {
        id,
        toolName: 'call_mcp_tool',
        displayName: 'Used call_mcp_tool',
        category: 'unknown',
        status
      }
    case 5:
      return {
        id,
        toolName: 'provider_diagnostic',
        displayName: 'Provider Diagnostic',
        category: 'unknown',
        status
      }
    default:
      return { id, toolName: 'Grep', displayName: `Searched "${kind}"`, category: 'search', status }
  }
}

function thread(extra: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: CHAT,
    title: 'Thread',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    persistenceRevision: 1,
    messages: [],
    runs: [],
    ...extra
  }
}

const revisionOf = (record: ChatRecord): number => record.persistenceRevision ?? 0
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** The checkpoint worker, run on this thread when a test says so. */
class Compactor implements CheckpointPreparationPort {
  private readonly jobs: Array<{
    request: CheckpointPreparationRequest
    ready: (value: PreparedCheckpoint) => void
    fail: (error: Error) => void
  }> = []

  constructor(private readonly directory: string) {}

  get pending(): number {
    return this.jobs.length
  }

  start(source: CheckpointPreparationSource): CheckpointPreparationJob | null {
    const outputPath = path.join(
      this.directory,
      `.${source.chatId}.checkpoint-prepared-${process.pid}-${randomUUID()}.tmp`
    )
    fs.writeFileSync(outputPath, '', { flag: 'wx', mode: 0o600 })
    const output = checkpointFileReference(outputPath)
    let ready!: (value: PreparedCheckpoint) => void
    let fail!: (error: Error) => void
    const result = new Promise<PreparedCheckpoint>((resolve, reject) => {
      ready = resolve
      fail = reject
    })
    const release = (): void => fs.rmSync(outputPath, { force: true })
    this.jobs.push({ request: { ...source, output, maxOutputBytes: 8 * 1024 * 1024 }, ready, fail })
    return { output, result, cancel: release, release }
  }

  /** The worker folds the oldest job and hands it back. */
  fold(): void {
    const job = this.jobs.shift()
    if (!job) throw new Error('no compaction is waiting for the worker')
    try {
      job.ready(prepareCheckpoint(job.request))
    } catch (error) {
      job.fail(error as Error)
    }
  }

  readonly syncDirectory = (): Promise<void> => Promise.resolve()
}

/** The app: its journal as it runs under the thread barrier, and every record it wrote. */
class App {
  readonly journal: IncrementalChatJournal
  readonly compactor: Compactor
  readonly records = new Map<number, ChatRecord>()
  record: ChatRecord
  clock = Date.parse(AT)

  constructor(
    readonly directory: string,
    options: IncrementalChatJournalOptions = {},
    initial: ChatRecord = thread()
  ) {
    this.compactor = new Compactor(directory)
    this.journal = createIncrementalChatJournal(directory, {
      noteDurabilityDebt: () => {},
      checkpointPreparation: this.compactor,
      syncDirectory: this.compactor.syncDirectory,
      maxJournalBytes: 64 * 1024 * 1024,
      canRepairOnRead: () => false,
      repairTornTailBeforeAppend: true,
      ...options
    })
    this.record = clone(initial)
    if (this.journal.replay(CHAT).record === null) this.journal.initialize(CHAT, this.record)
    this.records.set(revisionOf(this.record), clone(this.record))
  }

  /** Change the record and append the batch the journal derives from the two. */
  change(edit: (next: ChatRecord) => void): ChatRecordMutationBatch {
    const next = clone(this.record)
    edit(next)
    next.persistenceRevision = revisionOf(this.record) + 1
    next.updatedAt = revisionOf(next)
    this.clock += 1000
    const batch = deriveChatRecordMutation(this.record, next, {
      savedAt: new Date(this.clock).toISOString()
    })
    return this.write(batch, next)
  }

  /** Append operations written by hand; the record they make is the shared apply code's. */
  operations(operations: ThreadLogOperation[]): ChatRecordMutationBatch {
    this.clock += 1000
    const batch = {
      format: THREAD_LOG_BATCH_FORMAT,
      version: THREAD_LOG_BATCH_VERSION,
      chatId: CHAT,
      baseRevision: revisionOf(this.record),
      revision: revisionOf(this.record) + 1,
      savedAt: new Date(this.clock).toISOString(),
      operations
    } as ChatRecordMutationBatch
    return this.write(batch, applyThreadLogBatch(this.record, batch))
  }

  private write(batch: ChatRecordMutationBatch, next: ChatRecord): ChatRecordMutationBatch {
    this.journal.append(batch)
    this.record = next
    this.records.set(revisionOf(next), clone(next))
    return batch
  }

  /** Let the worker fold the waiting compaction, and wait until it is adopted. */
  async compact(): Promise<void> {
    const adopted = this.journal.stats().compactionsAdopted
    this.compactor.fold()
    for (let turn = 0; turn < 500; turn += 1) {
      if (this.journal.stats().compactionsAdopted > adopted) return
      await settle()
    }
    throw new Error('the compaction was not adopted')
  }
}

/** The app's own load, read-only, as the production seed must build it. */
function appLoad(directory: string): ChatRecord | null {
  return createIncrementalChatJournal(directory, {
    noteDurabilityDebt: () => {},
    canWrite: () => false
  }).replay(CHAT).record
}

/** The app's own load as a seed: always the whole record. */
function seedPortOf(directory: string): {
  readonly requests: HostThreadLogSeedRequest[]
  seed(request: HostThreadLogSeedRequest): Promise<HostThreadLogRecord | null>
} {
  const requests: HostThreadLogSeedRequest[] = []
  return {
    requests,
    async seed(request) {
      requests.push(request)
      await settle()
      return appLoad(directory) as unknown as HostThreadLogRecord | null
    }
  }
}

/**
 * The app's own load cut to the follower's window, with what the rows before
 * it show, as a load off the event loop hands it over; the whole record when
 * no window is asked for, as for an older page.
 */
function windowSeedPortOf(directory: string): HostThreadLogSeedPort & {
  readonly requests: HostThreadLogSeedRequest[]
  windows: number
} {
  const requests: HostThreadLogSeedRequest[] = []
  const port = {
    requests,
    windows: 0,
    async seed(request: HostThreadLogSeedRequest) {
      requests.push(request)
      await settle()
      const record = appLoad(directory) as unknown as HostThreadLogRecord | null
      if (!record || !request.window) return record
      const cut = HostThreadLogFollower.windowOf(record, request.window)
      const seed: HostThreadLogWindowSeed = {
        kind: 'window',
        ...cut,
        readFrom: [],
        entriesBefore: hostThreadLogEntriesBefore(record, cut)
      }
      port.windows += 1
      // As it crosses from a worker: a copy.
      return structuredClone(seed)
    }
  }
  return port
}

/** The two ways a seed arrives: the whole record, or a window cut where it was loaded. */
const SEED_PORTS = [
  ['whole records', seedPortOf],
  ['windows', windowSeedPortOf]
] as const

/** The profile store over a copy of the app's record: the history every page must equal. */
class FullCopy {
  private readonly store: HostProfileDomainStore
  private readonly file: string

  constructor(root: string) {
    const profile = path.join(root, 'profile')
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 })
    this.store = new HostProfileDomainStore({
      profilePath: profile,
      authority: { assertProfileAuthority: () => {} },
      now: () => 0,
      idFactory: () => 'unused'
    })
    this.file = path.join(profile, HOST_PROFILE_CHATS_DIRECTORY, `${CHAT}.json`)
  }

  /** One page of the record's history, asked for as a client asks. */
  page(
    record: ChatRecord,
    request: Omit<HostThreadHistoryRequest, 'threadId'>
  ): HostThreadHistoryPage {
    fs.writeFileSync(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    return this.store.threadHistory({ threadId: CHAT, ...request })
  }

  /** The record's whole history, oldest first, as the terminal app receives it. */
  whole(record: ChatRecord): HostTranscriptHistoryEntry[] {
    return this.pages(record, 100)
      .reverse()
      .flatMap((page) => page.entries)
      .map(wireEntry)
  }

  /** Every page, newest first, of the record's history. */
  pages(record: ChatRecord, limit: number): HostThreadHistoryPage[] {
    fs.writeFileSync(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    const pages = [this.store.threadHistory({ threadId: CHAT, limit })]
    while (pages.at(-1)!.nextBefore) {
      pages.push(
        this.store.threadHistory({ threadId: CHAT, limit, before: pages.at(-1)!.nextBefore })
      )
    }
    return pages
  }
}

/** Every page, newest first, of the history served from the log. */
async function pagesOf(
  history: HostThreadLogHistory,
  limit: number
): Promise<HostThreadHistoryPage[]> {
  const pages = [await history.threadHistory({ threadId: CHAT, limit })]
  while (pages.at(-1)!.nextBefore) {
    pages.push(
      await history.threadHistory({ threadId: CHAT, limit, before: pages.at(-1)!.nextBefore })
    )
  }
  return pages
}

/** What a page or entry is once it has crossed the wire. */
function wireEntry(entry: HostTranscriptHistoryEntry): HostTranscriptHistoryEntry {
  const decoded = decodeHostTranscriptHistoryEntry(entry)
  if (!decoded.ok) throw new Error(decoded.error)
  return decoded.value
}

const fullCopies = new Map<string, FullCopy>()

/** The full copy kept beside an app's journal. */
function fullCopyOf(app: App): FullCopy {
  let copy = fullCopies.get(app.directory)
  if (!copy) {
    copy = new FullCopy(app.directory)
    fullCopies.set(app.directory, copy)
  }
  return copy
}

/**
 * The terminal app's history for one thread, kept as TaskWraithTui keeps it:
 * `loadThreadHistory` takes `generation`, `cursor` and `nextBefore` from every
 * page and puts an older page before the rows it holds, dropping repeated ids;
 * `applyHistoryResult` classifies with the app's own `classifyHistoryResult`,
 * loads the tail again on `reload`, and applies deltas by id, an entry it does
 * not hold going last. The app asks for 50 entries a page; the limit here is
 * smaller so that a short history has many pages.
 */
class TerminalClient {
  rows: HostTranscriptHistoryEntry[] = []
  history: TuiHistoryState | null = null
  reloads = 0
  deltasApplied = 0
  olderPages = 0
  readonly olderFailures: string[] = []

  constructor(
    private readonly host: HostThreadLogHistory,
    readonly limit: number
  ) {}

  async load(before?: HostHistoryCursor): Promise<void> {
    const decoded = decodeHostThreadHistoryPage(
      await this.host.threadHistory({
        threadId: CHAT,
        limit: this.limit,
        ...(before ? { before } : {})
      })
    )
    if (!decoded.ok) throw new Error(decoded.error)
    const page = decoded.value
    const current = this.history ? this.rows : []
    if (before) {
      const ids = new Set<string>()
      this.rows = [...page.entries, ...current].filter((row) => {
        if (ids.has(row.entryId)) return false
        ids.add(row.entryId)
        return true
      })
    } else this.rows = [...page.entries]
    this.history = {
      threadId: CHAT,
      generation: page.generation,
      cursor: page.cursor,
      ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
      previewOnly: false
    }
  }

  /** An older page, as the app asks for one at the top of the transcript; it shows a failure and goes on. */
  async older(): Promise<boolean> {
    if (!this.history?.nextBefore) return false
    try {
      await this.load(this.history.nextBefore)
    } catch (error) {
      this.olderFailures.push((error as Error).message)
      return false
    }
    this.olderPages += 1
    return true
  }

  async refresh(): Promise<HostHistorySinceResult> {
    const history = this.history!
    const decoded = decodeHostHistorySinceResult(
      await this.host.historySince({
        threadId: CHAT,
        since: { generation: history.generation, cursor: history.cursor }
      })
    )
    if (!decoded.ok) throw new Error(decoded.error)
    const result = decoded.value
    const decision = classifyHistoryResult(history, result)
    if (decision === 'ignore') return result
    if (decision === 'reload') {
      this.reloads += 1
      await this.load()
      return result
    }
    if (result.kind !== 'deltas') return result
    let rows = [...this.rows]
    for (const delta of result.deltas) {
      if (delta.kind === 'remove') {
        rows = rows.filter((row) => row.entryId !== delta.entryId)
        continue
      }
      const existing = rows.findIndex((row) => row.entryId === delta.entry.entryId)
      if (existing >= 0) rows.splice(existing, 1, delta.entry)
      else rows.push(delta.entry)
    }
    this.rows = rows
    this.deltasApplied += result.deltas.length
    this.history = {
      ...history,
      generation: result.generation,
      cursor: result.toCursor,
      previewOnly: false
    }
    return result
  }
}

/** The client holds the newest entries of the full copy's history, in its order, and nothing else. */
function expectClientOf(client: TerminalClient, app: App, note: string): void {
  const whole = fullCopyOf(app).whole(app.record)
  expect(client.rows.length, `${note}: holds a full page or all`).toBeGreaterThanOrEqual(
    Math.min(client.limit, whole.length)
  )
  expect(client.rows, note).toEqual(whole.slice(whole.length - client.rows.length))
}

describe('history from a followed thread log', () => {
  let directory: string
  const histories: HostThreadLogHistory[] = []

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
  })

  afterEach(() => {
    fullCopies.clear()
    for (const history of histories.splice(0)) history.close()
    vi.restoreAllMocks()
    syncBuiltinESMExports()
    removeTemporaryDirectory(directory)
  })

  const open = (
    options: Partial<HostThreadLogHistoryOptions> = {},
    seedPort: HostThreadLogSeedPort = seedPortOf(directory)
  ): HostThreadLogHistory => {
    const history = new HostThreadLogHistory({ chatId: CHAT, directory, seedPort, ...options })
    histories.push(history)
    return history
  }

  /**
   * One change of a seeded random history: most near the end of the
   * transcript, as an ensemble writes, some anywhere, some with text the
   * history refuses or keeps at its edges.
   */
  function randomChange(app: App, random: (bound: number) => number, step: number): void {
    const record = app.record
    const length = record.messages.length
    const id = (): string => `m${step}-${random(1_000_000)}`
    const recent = (span: number): number =>
      Math.max(0, length - 1 - random(Math.max(1, Math.min(span, length))))
    const choice = random(24)
    if (choice <= 2) {
      // A user message that names a run shows no tool rows.
      const named = random(4) === 0 ? { runId: record.runs.at(-1)?.runId ?? 'r-none' } : {}
      app.change((next) => next.messages.push(message(id(), 'user', `ask ${step}`, named)))
    } else if (choice <= 4) {
      const runId = `r${step}`
      app.change((next) => {
        next.runs.push(
          run(runId, random(2) === 0 ? { toolActivities: [tool(`t${step}`, 'running')] } : {})
        )
        next.messages.push(message(id(), 'assistant', '', { runId }))
      })
    } else if (choice <= 7 && length > 0) {
      const at = recent(4)
      app.change((next) => (next.messages[at].content += ` w${step}`))
    } else if (choice === 8) {
      app.change((next) =>
        next.messages.push(message(id(), random(2) === 0 ? 'tool' : 'error', `out ${step}`))
      )
    } else if (choice === 9 && record.runs.length > 0) {
      const at = random(record.runs.length)
      app.change((next) => {
        ;(next.runs[at] as unknown as Record<string, unknown>).toolActivities = [
          tool(`t${step}`, random(2) === 0 ? 'success' : 'error')
        ]
      })
    } else if (choice === 10 && length > 0) {
      const at = random(length)
      app.change((next) => (next.messages[at].content += '!'))
    } else if (choice === 11 && length > 0) {
      const at = recent(6)
      app.change((next) => next.messages.splice(at, 1))
    } else if (choice === 12) {
      const at = length === 0 ? 0 : recent(5)
      app.change((next) => next.messages.splice(at, 0, message(id(), 'user', `between ${step}`)))
    } else if (choice === 13 && length > 0) {
      const at = recent(6)
      app.change((next) => {
        const row = next.messages[at]
        row.role = row.role === 'user' ? 'tool' : 'user'
      })
    } else if (choice === 14) {
      app.change((next) =>
        next.messages.push(
          message(id(), 'user', random(2) === 0 ? 'x'.repeat(16_001) : `bell \u0007 ${step}`)
        )
      )
    } else if (choice === 15) {
      app.change((next) =>
        next.messages.push(
          message(
            id(),
            'assistant',
            random(2) === 0 ? 'y'.repeat(16_000) : `tab\there\r\nline \u{1f600} ${step}`,
            { runId: record.runs.at(-1)?.runId ?? 'r-none' }
          )
        )
      )
    } else if (choice === 16) {
      app.change((next) =>
        next.messages.push(message(id(), 'system', `note ${step}`, { timestamp: 'not a time' }))
      )
    } else if (choice === 17 && record.runs.length > 0) {
      const at = random(record.runs.length)
      app.change((next) => next.runs.splice(at, 1))
    } else if (choice === 18) {
      app.change((next) => (next.title = `Thread ${step}`))
    } else if (choice === 19) {
      // A tool message, which the desktop draws as a stack; its own text is never shown.
      const runId = record.runs.at(-1)?.runId
      const count = 1 + random(3)
      const toolActivities = Array.from({ length: count }, (_unused, index) =>
        appActivity(`a${step}-${index}`, random(7), ACTIVITY_STATUSES[random(5)])
      )
      app.change((next) =>
        next.messages.push(
          message(id(), 'tool', random(4) === 0 ? `payload ${step}` : '', {
            ...(runId ? { runId } : {}),
            toolActivities
          } as unknown as Partial<ChatMessage>)
        )
      )
    } else if (choice === 20 && length > 0) {
      // A recent message's rows change as a run streams: a status, one row more, one fewer.
      const at = recent(6)
      const pick = random(3)
      const which = random(4)
      const status = ACTIVITY_STATUSES[random(5)]
      app.change((next) => {
        const row = next.messages[at] as unknown as { toolActivities?: Record<string, unknown>[] }
        const activities = row.toolActivities ?? []
        if (pick === 0 && activities.length > 0) {
          activities[which % activities.length].status = status
        } else if (pick === 1) activities.push(appActivity(`a${step}`, which, 'running'))
        else activities.splice(which % Math.max(1, activities.length), 1)
        row.toolActivities = activities
      })
    } else if (choice === 21) {
      // An ensemble lane's result, whose card draws the lane's own rows.
      const lane = random(3)
      const kind = random(7)
      app.change((next) =>
        next.messages.push(
          message(id(), 'assistant', lane === 0 ? '' : `lane ${step}`, {
            metadata: { kind: 'ensembleParticipant', ensembleLaneId: `lane-${lane}` },
            toolActivities: [appActivity(`l${step}`, kind, ACTIVITY_STATUSES[random(5)])]
          } as unknown as Partial<ChatMessage>)
        )
      )
    } else if (choice === 22 && length > 0) {
      // The rows' detail moves out of the record, as the app's save does once a run ends.
      const at = recent(8)
      app.change((next) => {
        const row = next.messages[at] as unknown as { toolActivities?: Record<string, unknown>[] }
        row.toolActivities = row.toolActivities?.map((activity) => {
          const { parameters: _parameters, ...compact } = activity
          return {
            ...compact,
            detailRef: {
              schemaVersion: 1,
              storage: 'run_event_artifact',
              runId: 'r-detail',
              activityId: activity.id,
              offset: 0,
              byteLength: 10,
              sha256: 'a'.repeat(64)
            }
          }
        })
      })
    } else {
      app.change((next) => next.messages.push(message(id(), 'user', `more ${step}`)))
    }
  }

  /**
   * A seeded generator (mulberry32). The low digits of a power-of-two linear
   * congruential generator repeat with a short period and leave whole kinds
   * of change untried.
   */
  function seeded(seed: number): (bound: number) => number {
    let state = seed >>> 0
    return (bound) => {
      state = (state + 0x6d2b79f5) >>> 0
      let mixed = Math.imul(state ^ (state >>> 15), state | 1)
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
      return ((mixed ^ (mixed >>> 14)) >>> 0) % bound
    }
  }

  const users = (count: number, prefix = 'm'): ChatMessage[] =>
    Array.from({ length: count }, (_unused, index) =>
      message(`${prefix}${index}`, 'user', `text ${index}`)
    )
  const ids = (entries: readonly HostTranscriptHistoryEntry[]): string[] =>
    entries.map((entry) => entry.entryId)
  const said = (result: HostHistorySinceResult): Array<[string, string]> =>
    result.kind === 'deltas'
      ? result.deltas.map((delta) => [
          delta.kind,
          delta.kind === 'remove' ? delta.entryId : delta.entry.entryId
        ])
      : []

  describe('pages from the window and from the record', () => {
    it("take an entry's tool rows from the first run with its run id, as the full copy's find does", () => {
      // The full copy refuses a record with two runs of one id, so this is the projection alone.
      const record = thread({
        messages: [
          message('a', 'assistant', 'x', { runId: 'r' }),
          message('u', 'user', 'y', { runId: 'r' }),
          message('b', 'assistant', 'z', { runId: 'gone' })
        ],
        runs: [
          run('r', { toolActivities: [tool('first', 'success')] }),
          run('r', { toolActivities: [tool('second', 'error')] })
        ]
      })
      expect(hostThreadLogHistoryEntries(record as unknown as HostThreadLogRecord)).toEqual([
        {
          entryId: 'a',
          role: 'assistant',
          createdAt: Date.parse(AT),
          text: 'x',
          tools: [tool('first', 'success')]
        },
        { entryId: 'u', role: 'user', createdAt: Date.parse(AT), text: 'y' },
        { entryId: 'b', role: 'assistant', createdAt: Date.parse(AT), text: 'z', tools: [] }
      ])
    })

    it('serve the tail from the window, and load the record only for what lies before it', async () => {
      new App(directory, {}, thread({ messages: users(12) }))
      const seedPort = seedPortOf(directory)
      const history = open({ windowMessages: 8 }, seedPort)
      const tail = await history.threadHistory({ threadId: CHAT, limit: 5 })
      expect(ids(tail.entries)).toEqual(['m7', 'm8', 'm9', 'm10', 'm11'])
      const inWindow = await history.threadHistory({
        threadId: CHAT,
        limit: 3,
        before: tail.nextBefore
      })
      expect(ids(inWindow.entries)).toEqual(['m4', 'm5', 'm6'])
      expect(seedPort.requests.map((request) => request.reason)).toEqual(['cold'])
      const beforeWindow = await history.threadHistory({
        threadId: CHAT,
        limit: 5,
        before: inWindow.nextBefore
      })
      expect(ids(beforeWindow.entries)).toEqual(['m0', 'm1', 'm2', 'm3'])
      expect(beforeWindow.nextBefore).toBeUndefined()
      expect(seedPort.requests.map((request) => request.reason)).toEqual(['cold', 'requested'])
      // A tail longer than the window's entries comes from the record too.
      const long = await history.threadHistory({ threadId: CHAT, limit: 9 })
      expect(ids(long.entries)).toEqual(['m3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11'])
      expect(history.stats()).toMatchObject({
        tailPages: { window: 1, record: 1 },
        olderPages: { window: 1, record: 1 },
        recordLoads: 2
      })
    })

    it('continue below the oldest entry a client holds while batches arrive, where the full copy refuses', async () => {
      const app = new App(directory, {}, thread({ messages: users(12) }))
      const copy = fullCopyOf(app)
      const history = open()
      const client = new TerminalClient(history, 3)
      await client.load()
      expect(ids(client.rows)).toEqual(['m9', 'm10', 'm11'])
      const fullCopyTail = copy.page(app.record, { limit: 3 })
      app.change((next) => next.messages.push(message('m12', 'user', 'text 12')))
      app.change((next) => next.messages.splice(2, 1))
      app.change((next) => (next.messages[9].content += ' edited'))
      app.change((next) => next.messages.push(message('m13', 'user', 'text 13')))
      expect(await client.older()).toBe(true)
      // The three before m9, though m2 went before them; the rows it held stay
      // as old as its cursor until it polls.
      expect(ids(client.rows)).toEqual(['m6', 'm7', 'm8', 'm9', 'm10', 'm11'])
      const result = await client.refresh()
      expect(said(result)).toEqual([
        ['replace', 'm10'],
        ['append', 'm12'],
        ['append', 'm13']
      ])
      expectClientOf(client, app, 'after the poll')
      expect(() => copy.page(app.record, { limit: 3, before: fullCopyTail.nextBefore })).toThrow(
        'History generation mismatch'
      )
    })

    it('refuse an older page of a generation that has ended, as the full copy does', async () => {
      const app = new App(directory, {}, thread({ messages: users(6) }))
      const history = open()
      const client = new TerminalClient(history, 2)
      await client.load()
      app.change((next) => next.messages.splice(2, 0, message('x', 'user', 'between')))
      expect(await client.older()).toBe(false)
      expect(client.olderFailures).toEqual(['History generation mismatch'])
      const result = await client.refresh()
      expect(result).toMatchObject({
        kind: 'full_resnapshot_required',
        reason: 'generation_mismatch'
      })
      expectClientOf(client, app, 'loaded again')
    })

    it('ask for a seed when a record does not match the numbers it was given', async () => {
      const app = new App(directory, {}, thread({ messages: users(10) }))
      const real = seedPortOf(directory)
      let calls = 0
      const history = open(
        { windowMessages: 4 },
        {
          async seed(request) {
            calls += 1
            const record = await real.seed(request)
            if (!record) return record
            const messages = record.messages as ChatMessage[]
            // The second load, a page's, has one message more than the log.
            if (calls === 2) {
              return { ...record, messages: [message('stray', 'user', 'stray'), ...messages] }
            }
            // The fourth, as many messages, but the newest says something else.
            if (calls === 4) {
              return {
                ...record,
                messages: [...messages.slice(0, -1), { ...messages.at(-1)!, content: 'other' }]
              }
            }
            if (calls === 7) {
              app.change((next) => next.messages.push(message('late', 'user', 'late')))
              await history.follower.poll()
              return { ...record, messages: [message('stray', 'user', 'stray'), ...messages] }
            }
            return record
          }
        }
      )
      await expect(history.threadHistory({ threadId: CHAT, limit: 8 })).rejects.toThrow(
        'does not match its record'
      )
      expect(history.stats().seedsAsked['record-mismatch']).toBe(1)
      await expect(history.threadHistory({ threadId: CHAT, limit: 8 })).rejects.toThrow(
        'does not match its record'
      )
      expect(history.stats().seedsAsked['record-mismatch']).toBe(2)
      const page = await history.threadHistory({ threadId: CHAT, limit: 8 })
      expect(ids(page.entries)).toEqual(['m2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9'])
      expect(history.follower.stats().seeds).toMatchObject({ cold: 1, requested: 2 })
      // The seventh comes back with one message more while the log moves past it.
      await expect(history.threadHistory({ threadId: CHAT, limit: 8 })).rejects.toThrow(
        'does not match its record'
      )
      expect(history.stats().seedsAsked['record-mismatch']).toBe(3)
      expect(history.follower.headRevision).toBe(revisionOf(app.record))
    })

    it('bring the follower up to a record the log moved on to while it loaded', async () => {
      const app = new App(directory, {}, thread({ messages: users(10) }))
      const copy = fullCopyOf(app)
      const real = seedPortOf(directory)
      let writeFirst = false
      const history = open(
        { windowMessages: 4 },
        {
          async seed(request) {
            if (writeFirst) {
              writeFirst = false
              app.change((next) => next.messages.push(message('late', 'user', 'late')))
            }
            return real.seed(request)
          }
        }
      )
      await history.threadHistory({ threadId: CHAT, limit: 2 })
      writeFirst = true
      const page = await history.threadHistory({ threadId: CHAT, limit: 8 })
      expect(page.entries).toEqual(copy.page(app.record, { limit: 8 }).entries)
      expect(history.follower.headRevision).toBe(revisionOf(app.record))
    })

    it('number a record the follower has passed as things stood at its revision', async () => {
      const app = new App(directory, {}, thread({ messages: users(10) }))
      const copy = fullCopyOf(app)
      const real = seedPortOf(directory)
      let writeAfter = false
      const history = open(
        { windowMessages: 4 },
        {
          async seed(request) {
            const record = await real.seed(request)
            if (writeAfter) {
              // The log moves on while the record is on its way, and another
              // request's poll takes the follower past it.
              writeAfter = false
              app.change((next) => {
                next.messages.splice(8, 1)
                next.messages.push(message('late', 'user', 'late'))
              })
              await history.follower.poll()
            }
            return record
          }
        }
      )
      await history.threadHistory({ threadId: CHAT, limit: 2 })
      const loaded = clone(app.record)
      writeAfter = true
      const client = new TerminalClient(history, 8)
      await client.load()
      expect(history.follower.headRevision).toBe(revisionOf(loaded) + 1)
      expect(client.rows).toEqual(copy.page(loaded, { limit: 8 }).entries.map(wireEntry))
      // It held m8, which went in the batch after its page.
      expect(await client.refresh()).toMatchObject({
        kind: 'full_resnapshot_required',
        reason: 'retention_gap'
      })
      expectClientOf(client, app, 'after the batch it loaded before')
    })

    it('start again from a seed when it cannot follow what the follower saw', async () => {
      new App(
        directory,
        {},
        thread({
          messages: [message('a0', 'assistant', 'reply', { runId: 'r0' })],
          runs: [run('r0', { toolActivities: [tool('t0', 'success')] })]
        })
      )
      const real = seedPortOf(directory)
      let calls = 0
      const history = open(
        { windowMessages: 1 },
        {
          async seed(request) {
            calls += 1
            const record = await real.seed(request)
            // The first seed carries, before the window, a message the history cannot read.
            if (calls === 1 && record) {
              const unreadable = { id: 'u0', content: 'hello', timestamp: AT }
              Object.defineProperty(unreadable, 'role', {
                enumerable: true,
                get: () => {
                  throw new Error('unreadable message')
                }
              })
              return { ...record, messages: [unreadable, ...record.messages] }
            }
            return record
          }
        }
      )
      const page = await history.threadHistory({ threadId: CHAT, limit: 5 })
      expect(page.entries).toEqual([
        {
          entryId: 'a0',
          role: 'assistant',
          createdAt: Date.parse(AT),
          text: 'reply',
          tools: [tool('t0', 'success')]
        }
      ])
      expect(history.follower.stats()).toMatchObject({
        observerFailures: 1,
        seeds: { cold: 1, requested: 1 }
      })
    })

    it('refuse what is not a page of this thread', async () => {
      new App(directory, {}, thread({ messages: users(3) }))
      const history = open()
      await expect(history.threadHistory({ threadId: 'chat-2', limit: 5 })).rejects.toThrow(
        'History is for another thread'
      )
      for (const limit of [0, 101, 1.5]) {
        await expect(history.threadHistory({ threadId: CHAT, limit })).rejects.toThrow(
          'History page size is invalid'
        )
      }
      const page = await history.threadHistory({ threadId: CHAT, limit: 1 })
      await expect(
        history.threadHistory({
          threadId: CHAT,
          limit: 1,
          before: { generation: page.generation, cursor: page.cursor + 10 * 2 ** 24 }
        })
      ).rejects.toThrow('History cursor is invalid')
      await expect(
        history.threadHistory({ threadId: CHAT, limit: 1, before: { generation: 2, cursor: 1 } })
      ).rejects.toThrow('History generation mismatch')
    })

    it('are not served for a thread without a log', async () => {
      const history = open()
      await expect(history.threadHistory({ threadId: CHAT, limit: 5 })).rejects.toThrow(
        'not available from the log: absent'
      )
      await expect(
        history.historySince({ threadId: CHAT, since: { generation: 1, cursor: 0 } })
      ).rejects.toThrow('not available from the log: absent')
    })
  })

  describe('since a cursor', () => {
    it('say appends and replacements in the order the client keeps, and load again for an entry it held that went', async () => {
      const app = new App(directory, {}, thread({ messages: users(6) }))
      const history = open()
      const client = new TerminalClient(history, 10)
      await client.load()
      app.change((next) => next.messages.push(message('a', 'user', 'A')))
      app.change((next) => {
        next.messages[2].content = 'changed'
        next.messages.push(message('b', 'user', 'B'))
      })
      const result = await client.refresh()
      expect(said(result)).toEqual([
        ['replace', 'm2'],
        ['append', 'a'],
        ['append', 'b']
      ])
      expect(result.kind === 'deltas' && result.toCursor > result.fromCursor).toBe(true)
      expectClientOf(client, app, 'after the deltas')
      // Once more from where it is now: nothing.
      const again = await client.refresh()
      expect(again).toMatchObject({ kind: 'deltas', deltas: [] })
      expect(again.kind === 'deltas' && again.toCursor === again.fromCursor).toBe(true)
      // The app would drop m4 and hold one entry less than a fresh page: it loads again.
      app.change((next) => next.messages.splice(4, 1))
      expect(await client.refresh()).toMatchObject({
        kind: 'full_resnapshot_required',
        reason: 'retention_gap'
      })
      expect(history.stats().reloadsForRemovals).toBe(1)
      expectClientOf(client, app, 'loaded again')
      // One it never held, added and removed since its cursor, is said as a removal.
      app.change((next) => next.messages.push(message('c', 'user', 'C')))
      app.change((next) => next.messages.pop())
      expect(said(await client.refresh())).toEqual([['remove', 'c']])
      expectClientOf(client, app, 'after a removal of what it never held')
    })

    it('fold a run of batches into each entry as it stands now', async () => {
      const app = new App(directory, {}, thread({ messages: users(2) }))
      const history = open()
      const client = new TerminalClient(history, 10)
      await client.load()
      app.change((next) => next.messages.push(message('c', 'user', 'one')))
      app.change((next) => (next.messages[2].content += ' two'))
      app.change((next) => next.messages.push(message('d', 'user', 'gone soon')))
      app.change((next) => next.messages.pop())
      app.change((next) => (next.messages[0].content += ' and more'))
      const result = await client.refresh()
      expect(said(result)).toEqual([
        ['remove', 'd'],
        ['replace', 'm0'],
        ['append', 'c']
      ])
      expect(result.kind === 'deltas' && result.deltas.at(-1)).toMatchObject({
        entry: { entryId: 'c', text: 'one two' }
      })
      expectClientOf(client, app, 'after the deltas')
    })

    it('read on to the end of what the log holds before answering', async () => {
      const app = new App(directory, {}, thread({ messages: users(2) }))
      const history = open({ maxPollBytes: 1 })
      const client = new TerminalClient(history, 3)
      await client.load()
      for (let index = 0; index < 6; index += 1) {
        app.change((next) => next.messages.push(message(`n${index}`, 'user', 'z'.repeat(15_000))))
      }
      expect(said(await client.refresh())).toEqual(
        Array.from({ length: 6 }, (_unused, index) => ['append', `n${index}`])
      )
      expect(history.follower.stats().batchesApplied).toBe(6)
    })

    it('begin a new generation for what deltas cannot say', async () => {
      const cases: Array<[HostThreadLogHistoryGenerationCause, (app: App) => void]> = [
        [
          'added-before',
          (app) => app.change((next) => next.messages.splice(2, 0, message('x', 'user', 'between')))
        ],
        [
          'added-again',
          (app) => {
            app.change((next) => next.messages.splice(3, 1))
            app.change((next) => next.messages.push(message('m3', 'user', 'again')))
          }
        ],
        [
          'order',
          (app) =>
            app.operations([
              { type: 'messages_splice', index: 1, deleteCount: 1, messages: [] },
              {
                type: 'messages_splice',
                index: 2,
                deleteCount: 0,
                messages: [app.record.messages[1]]
              }
            ])
        ],
        [
          'duplicate-id',
          (app) => app.change((next) => next.messages.push(message('m1', 'user', 'twin')))
        ]
      ]
      for (const [cause, change] of cases) {
        const local = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
        const app = new App(local, {}, thread({ messages: users(5) }))
        const history = new HostThreadLogHistory({
          chatId: CHAT,
          directory: local,
          seedPort: seedPortOf(local)
        })
        try {
          // Two a page: a page holding both rows of one id is one the wire refuses.
          const client = new TerminalClient(history, 2)
          await client.load()
          change(app)
          const result = await client.refresh()
          expect(result, cause).toMatchObject({
            kind: 'full_resnapshot_required',
            reason: 'generation_mismatch'
          })
          expect(history.stats().generations[cause], cause).toBe(1)
          expectClientOf(client, app, cause)
        } finally {
          history.close()
          removeTemporaryDirectory(local)
        }
      }
    })

    it('begin a new generation when a message changes as it leaves the window', async () => {
      const app = new App(directory, {}, thread({ messages: users(4) }))
      const history = open({ windowMessages: 4 })
      const client = new TerminalClient(history, 4)
      await client.load()
      app.change((next) => {
        next.messages[0].content += ' edited'
        next.messages.push(message('m4', 'user', 'text 4'))
      })
      expect(await client.refresh()).toMatchObject({ reason: 'generation_mismatch' })
      expect(history.stats().generations['trimmed-while-changed']).toBe(1)
      expect(await client.older()).toBe(true)
      expectClientOf(client, app, 'the edited message, before the window')
      expect(client.rows[0]).toMatchObject({ entryId: 'm0', text: 'text 0 edited' })
    })

    it('ask for a seed when a message before the window changes', async () => {
      const app = new App(directory, {}, thread({ messages: users(10) }))
      const history = open({ windowMessages: 4 })
      const client = new TerminalClient(history, 3)
      await client.load()
      app.change((next) => (next.messages[0].content += ' edited'))
      expect(await client.refresh()).toMatchObject({
        kind: 'full_resnapshot_required',
        reason: 'generation_mismatch'
      })
      expect(history.stats().seedsAsked['older-row']).toBe(1)
      expect(history.stats().generations.seed).toBe(2)
      expect(history.follower.stats().seeds).toMatchObject({ cold: 1, requested: 1 })
      while (await client.older()) await client.refresh()
      expectClientOf(client, app, 'down to the edited message')
      expect(client.rows[0]).toMatchObject({ entryId: 'm0', text: 'text 0 edited' })
    })

    it('ask for a seed when a held message names a run the view lacks', async () => {
      const app = new App(
        directory,
        {},
        thread({
          messages: [message('a0', 'assistant', 'answer', { runId: 'r0' }), ...users(2, 'u')],
          runs: [run('r0', { toolActivities: [tool('t0', 'success')] }), run('r1'), run('r2')]
        })
      )
      const copy = fullCopyOf(app)
      const history = open({ windowMessages: 2, windowRuns: 1 })
      const client = new TerminalClient(history, 2)
      await client.load()
      app.change((next) => next.messages.push(message('a3', 'assistant', 'again', { runId: 'r0' })))
      expect(await client.refresh()).toMatchObject({ reason: 'generation_mismatch' })
      expect(history.stats().seedsAsked['unresolved-run']).toBe(1)
      expectClientOf(client, app, 'after the seed')
      expect(client.rows.at(-1)).toMatchObject({ entryId: 'a3', tools: [tool('t0', 'success')] })
      expect((await history.threadHistory({ threadId: CHAT, limit: 2 })).entries).toEqual(
        copy.page(app.record, { limit: 2 }).entries
      )
    })

    it('replace an entry whose run changed its tool rows', async () => {
      const app = new App(
        directory,
        {},
        thread({
          messages: [
            message('u0', 'user', 'ask'),
            message('a1', 'assistant', 'reply', { runId: 'r1' })
          ],
          runs: [run('r1', { toolActivities: [tool('t1', 'running')] })]
        })
      )
      const history = open()
      const client = new TerminalClient(history, 5)
      await client.load()
      app.change((next) => {
        ;(next.runs[0] as unknown as Record<string, unknown>).toolActivities = [
          tool('t1', 'success')
        ]
      })
      // A change to the run that leaves its tool rows alone says nothing.
      app.change((next) => (next.runs[0].status = 'completed'))
      const result = await client.refresh()
      expect(said(result)).toEqual([['replace', 'a1']])
      expect(client.rows.at(-1)).toMatchObject({ tools: [tool('t1', 'success')] })
      expectClientOf(client, app, 'after the replacement')
      expect(history.stats().batchesWithUnsaidChanges).toBe(0)
    })

    it('tell only clients that hold it when an entry before the window changes its tool rows', async () => {
      const app = new App(
        directory,
        {},
        thread({
          messages: [message('a0', 'assistant', 'answer', { runId: 'r0' }), ...users(6, 'u')],
          runs: [run('r0', { toolActivities: [tool('t0', 'running')] })]
        })
      )
      const history = open({ windowMessages: 4 })
      const near = new TerminalClient(history, 2)
      await near.load()
      const far = new TerminalClient(history, 2)
      await far.load()
      while (await far.older());
      expect(far.rows[0].entryId).toBe('a0')
      // A change to the run that leaves its tool rows alone reaches no entry.
      app.change((next) => (next.runs[0].status = 'completed'))
      expect(await far.refresh()).toMatchObject({ kind: 'deltas', deltas: [] })
      app.change((next) => {
        ;(next.runs[0] as unknown as Record<string, unknown>).toolActivities = [
          tool('t0', 'success')
        ]
      })
      expect(await near.refresh()).toMatchObject({ kind: 'deltas', deltas: [] })
      expect(await far.refresh()).toMatchObject({
        kind: 'full_resnapshot_required',
        reason: 'retention_gap'
      })
      expect(history.stats().batchesWithUnsaidChanges).toBe(1)
      while (await far.older());
      expectClientOf(far, app, 'loaded again')
      expect(far.rows[0]).toMatchObject({ entryId: 'a0', tools: [tool('t0', 'success')] })
      expectClientOf(near, app, 'never held it')
    })

    it('tell the clients that hold it whichever way an entry before the window comes to change its tool rows', async () => {
      type Step = { readonly change: (app: App) => void; readonly far: 'deltas' | 'reload' }
      const setTools = (at: number, rows: Record<string, unknown>[]) => (app: App) =>
        app.change((next) => {
          ;(next.runs[at] as unknown as Record<string, unknown>).toolActivities = rows
        })
      const cases: Array<{
        readonly note: string
        readonly initial: ChatRecord
        readonly windowMessages: number
        readonly windowRuns: number
        readonly steps: readonly Step[]
        readonly references?: number
      }> = [
        {
          note: 'named by a message that left the window after the seed',
          initial: thread({
            messages: [
              message('u0', 'user', 'ask'),
              message('a1', 'assistant', 'reply', { runId: 'r1' }),
              ...users(2, 'v')
            ],
            runs: [run('r1', { toolActivities: [tool('t1', 'running')] })]
          }),
          windowMessages: 3,
          windowRuns: 256,
          steps: [
            {
              change: (app) =>
                app.change((next) => next.messages.push(message('u9', 'user', 'more'))),
              far: 'deltas'
            },
            { change: setTools(0, [tool('t1', 'success')]), far: 'reload' }
          ]
        },
        {
          note: 'of a run the view does not hold',
          initial: thread({
            messages: [message('a0', 'assistant', 'answer', { runId: 'r0' }), ...users(3, 'u')],
            runs: [run('r0', { toolActivities: [tool('t0', 'running')] }), run('r1'), run('r2')]
          }),
          windowMessages: 2,
          windowRuns: 1,
          steps: [{ change: setTools(0, [tool('t0', 'success')]), far: 'reload' }]
        },
        {
          note: 'of a run named before it was added, then changed, then no longer held',
          initial: thread({
            messages: [message('a0', 'assistant', 'answer', { runId: 'rx' }), ...users(3, 'u')]
          }),
          windowMessages: 2,
          windowRuns: 1,
          steps: [
            {
              change: (app) =>
                app.change((next) =>
                  next.runs.push(run('rx', { toolActivities: [tool('tx', 'running')] }))
                ),
              far: 'reload'
            },
            { change: setTools(0, [tool('tx', 'success')]), far: 'reload' },
            { change: (app) => app.change((next) => next.runs.push(run('ry'))), far: 'deltas' }
          ],
          references: 0
        },
        {
          note: 'of a held run removed, then added again',
          initial: thread({
            messages: [message('a0', 'assistant', 'answer', { runId: 'r0' }), ...users(3, 'u')],
            runs: [run('r0', { toolActivities: [tool('t0', 'running')] })]
          }),
          windowMessages: 2,
          windowRuns: 256,
          steps: [
            { change: (app) => app.change((next) => next.runs.splice(0, 1)), far: 'reload' },
            {
              change: (app) =>
                app.change((next) =>
                  next.runs.push(run('r0', { toolActivities: [tool('t0', 'success')] }))
                ),
              far: 'reload'
            }
          ]
        }
      ]
      for (const { note, initial, windowMessages, windowRuns, steps, references } of cases) {
        const local = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
        const app = new App(local, {}, initial)
        const history = new HostThreadLogHistory({
          chatId: CHAT,
          directory: local,
          seedPort: seedPortOf(local),
          windowMessages,
          windowRuns
        })
        try {
          const near = new TerminalClient(history, 1)
          await near.load()
          for (const [index, step] of steps.entries()) {
            const far = new TerminalClient(history, 2)
            await far.load()
            while (await far.older());
            await near.refresh()
            step.change(app)
            const result = await far.refresh()
            expect(result.kind === 'deltas' ? 'deltas' : 'reload', `${note}, step ${index}`).toBe(
              step.far
            )
            while (await far.older()) await far.refresh()
            expectClientOf(far, app, `${note}, step ${index}`)
            expect(await near.refresh(), `${note}, step ${index}: near`).toMatchObject({
              kind: 'deltas'
            })
            expectClientOf(near, app, `${note}, step ${index}: near`)
          }
          if (references !== undefined) {
            expect(history.memory().runReferences, note).toBe(references)
          }
        } finally {
          history.close()
          removeTemporaryDirectory(local)
        }
      }
    })

    it('reach a client behind by entries that have since left the window', async () => {
      const app = new App(directory, {}, thread({ messages: users(4) }))
      const history = open({ windowMessages: 4 })
      const client = new TerminalClient(history, 3)
      await client.load()
      for (let index = 0; index < 6; index += 1) {
        app.change((next) => next.messages.push(message(`n${index}`, 'user', `new ${index}`)))
      }
      const result = await client.refresh()
      expect(said(result)).toEqual(
        Array.from({ length: 6 }, (_unused, index) => ['append', `n${index}`])
      )
      expectClientOf(client, app, 'after the deltas')
      expect(history.memory().leftWindowEntries).toBe(6)
    })

    it('tell a client behind by more batches than are kept to load again', async () => {
      const app = new App(directory, {}, thread({ messages: users(2) }))
      const history = open({ maxRetainedBatches: 2 })
      const client = new TerminalClient(history, 5)
      await client.load()
      for (let index = 0; index < 3; index += 1) {
        app.change((next) => next.messages.push(message(`n${index}`, 'user', `new ${index}`)))
      }
      expect(await client.refresh()).toMatchObject({
        kind: 'full_resnapshot_required',
        reason: 'retention_gap'
      })
      expectClientOf(client, app, 'loaded again')
      app.change((next) => next.messages.push(message('n3', 'user', 'new 3')))
      app.change((next) => next.messages.push(message('n4', 'user', 'new 4')))
      expect(said(await client.refresh())).toEqual([
        ['append', 'n3'],
        ['append', 'n4']
      ])
      expect(history.memory().retainedBatches).toBe(2)
    })

    it('tell a client to load again rather than send more than a page of deltas', async () => {
      const app = new App(directory, {}, thread({ messages: users(2) }))
      const history = open()
      const client = new TerminalClient(history, 5)
      await client.load()
      for (let index = 0; index < 101; index += 1) {
        app.change((next) => next.messages.push(message(`n${index}`, 'user', `new ${index}`)))
      }
      expect(await client.refresh()).toMatchObject({
        kind: 'full_resnapshot_required',
        reason: 'retention_gap'
      })
      expectClientOf(client, app, 'loaded again')
    })

    it('tell a client whose cursor is not of this generation to load again', async () => {
      new App(directory, {}, thread({ messages: users(3) }))
      const history = open()
      const page = await history.threadHistory({ threadId: CHAT, limit: 2 })
      const since = (generation: number, cursor: number): Promise<HostHistorySinceResult> =>
        history.historySince({ threadId: CHAT, since: { generation, cursor } })
      // The full copy's generation is a revision: below every generation here.
      expect(await since(1, page.cursor)).toMatchObject({
        kind: 'full_resnapshot_required',
        reason: 'generation_mismatch',
        clientGeneration: 1,
        clientCursor: page.cursor
      })
      expect(
        await since(page.generation, page.cursor + HOST_THREAD_LOG_HISTORY_SEQUENCE_SPAN)
      ).toMatchObject({
        reason: 'cursor_mismatch'
      })
      expect(await since(page.generation, page.cursor + 1_000)).toMatchObject({
        reason: 'cursor_mismatch'
      })
      await expect(
        history.historySince({ threadId: 'chat-2', since: { generation: 1, cursor: 0 } })
      ).rejects.toThrow('History is for another thread')
      expect(history.stats().resnapshots).toEqual({
        generation_mismatch: 1,
        retention_gap: 0,
        cursor_mismatch: 2
      })
    })
  })

  describe('freshness', () => {
    it('says how far the history served is behind the log, and how long each batch waited', async () => {
      const app = new App(directory)
      let now = app.clock
      const history = open({ now: () => now })
      expect(history.freshness()).toMatchObject({
        servedRevision: null,
        logHeadRevision: 1,
        revisionsBehind: null,
        behindMs: null
      })
      const page = await history.threadHistory({ threadId: CHAT, limit: 5 })
      expect(history.freshness()).toMatchObject({
        servedRevision: 1,
        logHeadRevision: 1,
        revisionsBehind: 0,
        behindMs: 0
      })
      for (const id of ['a', 'b', 'c']) {
        app.change((next) => next.messages.push(message(id, 'user', id)))
      }
      now = app.clock + 1000
      expect(history.freshness()).toEqual({
        servedRevision: 1,
        followedRevision: 1,
        logHeadRevision: 4,
        revisionsBehind: 3,
        headSavedAt: new Date(app.clock).toISOString(),
        behindMs: 1000,
        servedLagCounts: [0, 0, 0, 0, 0, 0, 0],
        servedLagUncounted: 0
      })
      await history.historySince({
        threadId: CHAT,
        since: { generation: page.generation, cursor: page.cursor }
      })
      // Saved 3000, 2000 and 1000 ms before the answer that served them: a
      // bound is the most its bucket counts.
      expect(history.freshness()).toEqual({
        servedRevision: 4,
        followedRevision: 4,
        logHeadRevision: 4,
        revisionsBehind: 0,
        headSavedAt: new Date(app.clock).toISOString(),
        behindMs: 0,
        servedLagCounts: [0, 0, 0, 1, 1, 1, 0],
        servedLagUncounted: 0
      })
      expect(HOST_THREAD_LOG_HISTORY_LAG_BOUNDS_MS).toEqual([100, 250, 500, 1000, 2000, 5000])
    })

    it('reads the head from the sealed segment, and from the checkpoint when no segment is left', async () => {
      // Every line starts a compaction; none is done on this thread at a cap.
      const app = new App(directory, { maxJournalBytes: 1, compactionHardCapBytes: 1024 * 1024 })
      const history = open()
      await history.threadHistory({ threadId: CHAT, limit: 5 })
      const files = (): string[] =>
        fs
          .readdirSync(directory)
          .filter((name) => name.startsWith(CHAT))
          .sort()
      app.change((next) => next.messages.push(message('a', 'user', 'a')))
      expect(files()).toEqual([`${CHAT}.checkpoint.json`, `${CHAT}.sealed.mutations.jsonl`])
      expect(history.freshness()).toMatchObject({ logHeadRevision: 2, revisionsBehind: 1 })
      // A new active segment holds the newer lines while the sealed one waits to be folded.
      app.change((next) => next.messages.push(message('b', 'user', 'b')))
      expect(files()).toEqual([
        `${CHAT}.checkpoint.json`,
        `${CHAT}.mutations.jsonl`,
        `${CHAT}.sealed.mutations.jsonl`
      ])
      expect(history.freshness()).toMatchObject({ logHeadRevision: 3, revisionsBehind: 2 })
      await app.compact()
      app.change((next) => next.messages.push(message('c', 'user', 'c')))
      await app.compact()
      expect(files()).toEqual([`${CHAT}.checkpoint.json`])
      const checkpoint = JSON.parse(
        fs.readFileSync(path.join(directory, `${CHAT}.checkpoint.json`), 'utf8')
      ) as { revision: number; savedAt: string }
      expect(checkpoint.revision).toBe(4)
      expect(history.freshness()).toMatchObject({
        logHeadRevision: 4,
        revisionsBehind: 3,
        headSavedAt: checkpoint.savedAt
      })
    })
  })

  describe('bounds', () => {
    it('keeps its defaults', () => {
      expect(HOST_THREAD_LOG_HISTORY_GENERATION_BASE).toBe(2 ** 40)
      expect(HOST_THREAD_LOG_HISTORY_SEQUENCE_SPAN).toBe(2 ** 24)
      expect(HOST_THREAD_LOG_HISTORY_MAX_RETAINED_BATCHES).toBe(4096)
    })

    it('writes nothing, and reads the log only through read-only opens', async () => {
      const app = new App(directory, { maxJournalBytes: 2_000 }, thread({ messages: users(10) }))
      const history = open({ windowMessages: 4 })
      const client = new TerminalClient(history, 3)
      const writes: string[] = []
      const writeBits =
        fs.constants.O_WRONLY |
        fs.constants.O_RDWR |
        fs.constants.O_CREAT |
        fs.constants.O_APPEND |
        fs.constants.O_TRUNC
      const module = fs as unknown as Record<string, (...args: unknown[]) => unknown>
      let observing = false
      for (const name of [
        'writeSync',
        'writeFileSync',
        'appendFileSync',
        'renameSync',
        'unlinkSync',
        'rmSync',
        'truncateSync',
        'ftruncateSync',
        'mkdirSync',
        'fsyncSync'
      ]) {
        const real = module[name]
        vi.spyOn(module, name).mockImplementation((...args: unknown[]) => {
          if (observing) writes.push(name)
          return real(...args)
        })
      }
      const realOpen = module.openSync
      vi.spyOn(module, 'openSync').mockImplementation((...args: unknown[]) => {
        const flags = args[1]
        if (observing && (typeof flags !== 'number' || (flags & writeBits) !== 0)) {
          writes.push(`openSync ${String(flags)}`)
        }
        return realOpen(...args)
      })
      syncBuiltinESMExports()
      const watch = async (call: () => Promise<unknown> | unknown): Promise<void> => {
        observing = true
        try {
          await call()
        } finally {
          observing = false
        }
      }
      await watch(() => client.load())
      for (let index = 0; index < 20; index += 1) {
        app.change((next) => next.messages.push(message(`n${index}`, 'user', `new ${index}`)))
        if (app.compactor.pending > 0) await app.compact()
        await watch(() => client.refresh())
        await watch(() => client.older())
        await watch(() => history.freshness())
      }
      expectClientOf(client, app, 'at the end')
      expect(writes).toEqual([])
      expect(app.journal.stats().compactionsAdopted).toBeGreaterThan(0)
    })
  })

  describe('pages', () => {
    it.each(SEED_PORTS)(
      'equal the full copy at every revision of a random history, across rotation and compaction, seeded with %s',
      async (_, portOf) => {
        const app = new App(directory, { maxJournalBytes: 24 * 1024 })
        const copy = fullCopyOf(app)
        const port = portOf(directory)
        const history = open({ windowMessages: 6, windowRuns: 3 }, port)
        const random = seeded(11)
        const drawn = { stacks: 0, lanes: 0, runs: 0 }
        for (let step = 0; step < 300; step += 1) {
          randomChange(app, random, step)
          if (app.compactor.pending > 0 && random(3) === 0) await app.compact()
          const record = app.records.get(revisionOf(app.record))!
          for (const limit of step % 25 === 0 ? [2, 20, 3] : [2, 20]) {
            const expected = copy.pages(record, limit)
            const served = await pagesOf(history, limit)
            expect(
              served.map((page) => page.entries),
              `revision ${revisionOf(record)}, ${limit} a page`
            ).toEqual(expected.map((page) => page.entries))
            expect(served.map((page) => page.nextBefore !== undefined)).toEqual(
              expected.map((page) => page.nextBefore !== undefined)
            )
            for (const page of served) {
              expect(page.generation).toBeGreaterThanOrEqual(
                HOST_THREAD_LOG_HISTORY_GENERATION_BASE
              )
              expect(decodeHostThreadHistoryPage(page).ok).toBe(true)
              for (const entry of page.entries) {
                if (!entry.tools?.length) continue
                if (entry.role === 'tool') drawn.stacks += 1
                else if (entry.tools[0].id.startsWith('l')) drawn.lanes += 1
                else drawn.runs += 1
              }
            }
          }
        }
        const stats = history.stats()
        if (process.env.HISTORY_TEST_REPORT === '1') {
          console.log(
            JSON.stringify({
              revisions: revisionOf(app.record),
              stats,
              journal: app.journal.stats().compactionsAdopted,
              follower: history.follower.stats()
            })
          )
        }
        // Tool rows were served from tool messages, from lanes' results and from runs.
        expect(drawn.stacks).toBeGreaterThan(50)
        expect(drawn.lanes).toBeGreaterThan(10)
        expect(drawn.runs).toBeGreaterThan(10)
        // Every path was taken: tail and older pages from the window and from the record.
        expect(stats.tailPages.window).toBeGreaterThan(0)
        expect(stats.tailPages.record).toBeGreaterThan(0)
        expect(stats.olderPages.window).toBeGreaterThan(0)
        expect(stats.olderPages.record).toBeGreaterThan(0)
        expect(app.journal.stats().compactionsAdopted).toBeGreaterThan(0)
        expect(history.follower.stats().seeds.cold).toBe(1)
        expect(history.follower.stats().segmentsOpened).toBeGreaterThan(3)
        // Seeds the history asked for came as windows too.
        if ('windows' in port) {
          expect(port.windows).toBe(port.requests.filter((request) => request.window).length)
          expect(port.windows).toBeGreaterThan(1)
        }
      },
      120_000
    )

    it('are not served from a window that does not say what the rows before it show', async () => {
      const app = new App(directory)
      for (let index = 0; index < 4; index += 1) {
        app.change((next) => next.messages.push(message(`m${index}`, 'user', `${index}`)))
      }
      const port = windowSeedPortOf(directory)
      const history = open(
        { windowMessages: 2 },
        {
          seed: async (request) => {
            const seed = await port.seed(request)
            if (!seed || !request.window) return seed
            // Lists as they should be, but a count no record has.
            return {
              ...seed,
              entriesBefore: {
                shown: -1,
                heldRunIds: [],
                missingRunIds: [],
                missingOverflow: false
              }
            } as never
          }
        }
      )
      await expect(history.threadHistory({ threadId: CHAT, limit: 2 })).rejects.toThrow(
        'no generation settled'
      )
      expect(history.follower.stats().observerFailures).toBeGreaterThan(0)
      const fine = open({ windowMessages: 2 }, port)
      expect(
        (await fine.threadHistory({ threadId: CHAT, limit: 3 })).entries.map(
          (entry) => entry.entryId
        )
      ).toEqual(['m1', 'm2', 'm3'])
    })
  })

  describe('deltas', () => {
    it.each(SEED_PORTS)(
      'leave a client that applies them with the history of one that loads it again, seeded with %s',
      async (_, portOf) => {
        for (const [seed, windowMessages, limit] of [
          [3, 16, 5],
          [5, 4, 5],
          [8, 32, 3]
        ] as const) {
          const local = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
          const app = new App(local, { maxJournalBytes: 24 * 1024 }, thread())
          const history = new HostThreadLogHistory({
            chatId: CHAT,
            directory: local,
            seedPort: portOf(local),
            windowMessages,
            windowRuns: 3
          })
          try {
            const random = seeded(seed)
            const client = new TerminalClient(history, limit)
            await client.load()
            for (let step = 0; step < 400; step += 1) {
              randomChange(app, random, step)
              if (app.compactor.pending > 0 && random(3) === 0) await app.compact()
              if (random(2) === 0) {
                await client.refresh()
                expectClientOf(client, app, `seed ${seed}, step ${step}`)
              }
              // An older page comes from the newest revision while the rows the client
              // held are as old as its cursor; its next poll brings them together.
              if (random(6) === 0 && (await client.older())) {
                await client.refresh()
                expectClientOf(client, app, `seed ${seed}, step ${step}, older page`)
              }
            }
            await client.refresh()
            expectClientOf(client, app, `seed ${seed}, at the end`)
            const fresh = new TerminalClient(history, limit)
            await fresh.load()
            expect(client.rows.slice(client.rows.length - fresh.rows.length)).toEqual(fresh.rows)
            expect(client.deltasApplied, `seed ${seed}: deltas were applied`).toBeGreaterThan(50)
            expect(client.olderPages).toBeGreaterThan(5)
            // An older page asked for in a generation that has ended is refused, as the full copy refuses it.
            for (const failure of client.olderFailures)
              expect(failure).toBe('History generation mismatch')
            if (process.env.HISTORY_TEST_REPORT === '1') {
              console.log(
                JSON.stringify({
                  seed,
                  windowMessages,
                  limit,
                  deltasApplied: client.deltasApplied,
                  reloads: client.reloads,
                  olderPages: client.olderPages,
                  olderFailures: client.olderFailures.length,
                  stats: history.stats(),
                  memory: history.memory(),
                  follower: history.follower.stats().seeds
                })
              )
            }
          } finally {
            history.close()
            removeTemporaryDirectory(local)
          }
        }
      },
      120_000
    )
  })
})
