/**
 * The terminal app's history of a thread the desktop app owns, while the app
 * writes the thread's log in another process: its journal as it runs under
 * the thread barrier, appending, rotating, compacting in its worker a moment
 * later and checkpointing at the cap. The thread's authority file names the
 * writer's process, so the Host serves the thread from the log. A client that
 * pages and asks `history.since` as the terminal app does must hold, at every
 * revision the Host served, what the full copy of the record at that revision
 * would have given it; and the pages must be the full copy's pages.
 *
 * Polls happen only where this file says: the app's `advanced` nudges, one
 * for the revisions the writer reported since the last, between the client's
 * requests, and the polls the requests make themselves. So the revision a
 * request was served at is the follower's revision when it returns. Now and
 * then nothing polls while the writer rotates and compacts past the follower,
 * which is seeded again when next asked.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildSync } from 'esbuild'
import { describe, expect, it } from 'vitest'

import { ThreadAuthorityFiles } from '../host-shared/thread-log/ThreadAuthorityFile'
import { createIncrementalChatJournal } from '../main/store/IncrementalChatJournal'
import type { ChatRecord } from '../main/store/types'
import {
  decodeHostHistorySinceResult,
  decodeHostThreadHistoryPage,
  decodeHostTranscriptHistoryEntry,
  type HostHistoryCursor,
  type HostHistorySinceRequest,
  type HostHistorySinceResult,
  type HostThreadHistoryPage,
  type HostThreadHistoryRequest,
  type HostTranscriptHistoryEntry
} from '../shared/hostHistoryProtocol'
import { classifyHistoryResult } from '../tui/historyReconcile'
import type { TuiHistoryState } from '../tui/state'
import { HOST_PROFILE_CHATS_DIRECTORY, HostProfileDomainStore } from './HostProfileDomainStore'
import { HostThreadHistoryRouter } from './HostThreadHistoryRouter'
import type { HostThreadLogRecord } from './HostThreadLogFollower'
import { HOST_THREAD_LOG_HISTORY_GENERATION_BASE } from './HostThreadLogHistory'
import { threadLogDirectory } from './HostThreadOwnerService'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'host-history-router-process-'

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
const LAST = 600
const PAGE = 20

/**
 * One revision's change to the record, as JavaScript: the writer and this
 * file run the same text, so both know the record at every revision. Shaped
 * as the app writes: user messages; assistant replies and their runs, which
 * finish a revision later (now and then a run a Host run wrote, with its own
 * tool rows); tool messages, whose tools finish a revision later; ensemble
 * lane results with their tools; an edit to a message a few back, and now and
 * then to the first one, far before the window; and now and then a removal.
 */
const STEP = `
  const at = new Date(Date.parse('${AT}') + revision * 1000).toISOString();
  const pad = (text) => text.padEnd(160, '.');
  const user = { id: 'm' + revision, role: 'user', content: pad(String(revision)), timestamp: at };
  const messages = record.messages.slice();
  const runs = record.runs.slice();
  const kind = revision % 10;
  if (kind === 0) {
    runs.push(revision % 40 === 0
      ? {
          runId: 'run-' + revision,
          startedAt: at,
          status: 'completed',
          toolActivities: [{ id: 'host-read-' + revision, name: 'Read', category: 'read', status: 'success', file: 'src/h' + revision + '.ts' }]
        }
      : { runId: 'run-' + revision, startedAt: at, status: 'running' });
    messages.push({ id: 'm' + revision, role: 'assistant', content: pad('reply ' + revision), timestamp: at, runId: 'run-' + revision });
  } else if (kind === 1) {
    const index = runs.findIndex((run) => run.runId === 'run-' + (revision - 1));
    if (index >= 0 && runs[index].status === 'running') {
      runs[index] = { ...runs[index], status: 'completed', endedAt: at };
    }
    messages.push(user);
  } else if (kind === 3) {
    messages.push({
      id: 'm' + revision,
      role: 'tool',
      content: '',
      timestamp: at,
      toolActivities: [{ id: 'grep-' + revision, toolName: 'Grep', displayName: 'Searched "' + revision + '"', category: 'search', status: 'running' }]
    });
  } else if (kind === 4) {
    const index = messages.findIndex((message) => message.id === 'm' + (revision - 1));
    if (index >= 0 && Array.isArray(messages[index].toolActivities)) {
      messages[index] = {
        ...messages[index],
        toolActivities: [
          { ...messages[index].toolActivities[0], status: 'success' },
          {
            id: 'edit-' + revision,
            toolName: 'Edit',
            displayName: 'Edited src/e' + revision + '.ts',
            category: 'write',
            status: 'success',
            filePath: 'src/e' + revision + '.ts',
            diffSummary: { additions: 3, deletions: 1, source: 'string_replace', confidence: 'exact' }
          }
        ]
      };
    } else {
      messages.push(user);
    }
  } else if (kind === 5) {
    messages.push({
      id: 'm' + revision,
      role: 'assistant',
      content: '',
      timestamp: at,
      metadata: { kind: 'ensembleParticipant', ensembleLaneId: 'lane-' + revision },
      toolActivities: [{ id: 'lane-read-' + revision, toolName: 'Read', displayName: 'Read src/l' + revision + '.ts', category: 'read', status: 'success', filePath: 'src/l' + revision + '.ts' }]
    });
  } else if (kind === 7 && messages.length > 4) {
    const index = revision % 70 === 7 ? 0 : messages.length - 4;
    messages[index] = { ...messages[index], content: pad('edited ' + revision) };
  } else if (revision % 50 === 49 && messages.length > 6) {
    messages.splice(messages.length - 6, 1);
  } else {
    messages.push(user);
  }
  return { ...record, updatedAt: revision, persistenceRevision: revision, messages, runs };
`

const FIRST: ChatRecord = {
  appChatId: CHAT,
  title: 'Thread',
  createdAt: 1,
  updatedAt: 1,
  archived: false,
  persistenceRevision: 1,
  messages: [],
  runs: []
}

const step = new Function('record', 'revision', STEP) as (
  record: ChatRecord,
  revision: number
) => ChatRecord

/** The record at each revision, worked out forwards and kept every 50 revisions. */
const kept = new Map<number, ChatRecord>([[1, FIRST]])
function recordAt(revision: number): ChatRecord {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > LAST) {
    throw new Error(`no record at revision ${revision}`)
  }
  let from = revision - (revision % 50)
  while (from > 1 && !kept.has(from)) from -= 50
  if (!kept.has(from)) from = 1
  let record = kept.get(from)!
  for (let next = from + 1; next <= revision; next += 1) {
    record = step(record, next)
    if (next % 50 === 0) kept.set(next, record)
  }
  return record
}

/** The writer: the journal as the app runs it under the barrier, its worker folding a moment later. */
const WRITER = (store: string): string => `
  const fs = require('node:fs');
  const path = require('node:path');
  const { randomUUID } = require('node:crypto');
  const { createIncrementalChatJournal } = require(${JSON.stringify(path.join(store, 'IncrementalChatJournal.ts'))});
  const { deriveChatRecordMutation } = require(${JSON.stringify(path.join(store, 'ChatRecordMutation.ts'))});
  const { prepareCheckpoint } = require(${JSON.stringify(path.join(store, 'CheckpointPreparationCore.ts'))});
  const { checkpointFileReference } = require(${JSON.stringify(path.join(store, 'CheckpointPreparationProtocol.ts'))});
  const [directory, lastText] = process.argv.slice(2);
  const last = Number(lastText);
  const step = new Function('record', 'revision', ${JSON.stringify(STEP)});
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const compactor = {
    start(source) {
      const outputPath = path.join(directory, '.' + source.chatId + '.checkpoint-prepared-' + process.pid + '-' + randomUUID() + '.tmp');
      fs.writeFileSync(outputPath, '', { flag: 'wx', mode: 0o600 });
      const output = checkpointFileReference(outputPath);
      const result = pause(1).then(() =>
        prepareCheckpoint({ ...source, output, maxOutputBytes: 64 * 1024 * 1024 })
      );
      const release = () => fs.rmSync(outputPath, { force: true });
      return { output, result, cancel: release, release };
    }
  };
  const journal = createIncrementalChatJournal(directory, {
    noteDurabilityDebt: () => {},
    checkpointPreparation: compactor,
    syncDirectory: () => pause(1),
    maxJournalBytes: 4096,
    canRepairOnRead: () => false,
    repairTornTailBeforeAppend: true
  });
  (async () => {
    let record = ${JSON.stringify(FIRST)};
    journal.initialize(record.appChatId, record);
    for (let revision = 2; revision <= last; revision += 1) {
      const next = step(record, revision);
      journal.append(deriveChatRecordMutation(record, next, { savedAt: new Date(Date.parse(${JSON.stringify(AT)}) + revision * 1000).toISOString() }));
      record = next;
      // The cap's checkpoint on the calling thread, now and then.
      if (revision % 197 === 0) journal.checkpoint(record.appChatId, 'bounded', record);
      process.stdout.write(revision + '\\n');
      await pause(revision % 3);
    }
    process.stdout.write('done\\n');
    // Alive, and so the thread's owner, until the test lets it go.
    process.stdin.on('data', () => {});
    process.stdin.on('end', () => process.exit(0));
  })().catch((error) => {
    process.stderr.write(String((error && error.stack) || error));
    process.exit(1);
  });
`

/** The app's own load, read-only. A load racing the writer's renames may fail: it is asked again. */
async function appLoad(directory: string): Promise<ChatRecord | null> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return createIncrementalChatJournal(directory, {
        noteDurabilityDebt: () => {},
        canWrite: () => false
      }).replay(CHAT).record
    } catch (error) {
      if (attempt >= 20) throw error
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }
}

/** What an entry is once it has crossed the wire. */
function wireEntry(entry: HostTranscriptHistoryEntry): HostTranscriptHistoryEntry {
  const decoded = decodeHostTranscriptHistoryEntry(entry)
  if (!decoded.ok) throw new Error(decoded.error)
  return decoded.value
}

/** The profile store over a copy of a record: the history every answer must equal. */
class FullCopy {
  private readonly store: HostProfileDomainStore
  private readonly file: string

  constructor(root: string) {
    const profile = path.join(root, 'full-copy')
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 })
    this.store = new HostProfileDomainStore({
      profilePath: profile,
      authority: { assertProfileAuthority: () => {} },
      now: () => 0,
      idFactory: () => 'unused'
    })
    this.file = path.join(profile, HOST_PROFILE_CHATS_DIRECTORY, `${CHAT}.json`)
  }

  private hold(record: ChatRecord): void {
    fs.writeFileSync(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  }

  page(record: ChatRecord, request: HostThreadHistoryRequest): HostThreadHistoryPage {
    this.hold(record)
    return this.store.threadHistory(request)
  }

  since(record: ChatRecord, request: HostHistorySinceRequest): HostHistorySinceResult {
    this.hold(record)
    return this.store.historySince(request)
  }

  /** Every page, newest first. */
  pages(record: ChatRecord, limit: number): HostThreadHistoryPage[] {
    this.hold(record)
    const pages = [this.store.threadHistory({ threadId: CHAT, limit })]
    while (pages.at(-1)!.nextBefore) {
      pages.push(
        this.store.threadHistory({ threadId: CHAT, limit, before: pages.at(-1)!.nextBefore })
      )
    }
    return pages
  }

  /** The record's whole history, oldest first, as the terminal app receives it. */
  whole(record: ChatRecord): HostTranscriptHistoryEntry[] {
    return this.pages(record, 100)
      .reverse()
      .flatMap((page) => page.entries)
      .map(wireEntry)
  }
}

type HistoryHost = Pick<HostThreadHistoryRouter, 'threadHistory' | 'historySince'>

/**
 * The terminal app's history for one thread, kept as TaskWraithTui keeps it:
 * `loadThreadHistory` takes `generation`, `cursor` and `nextBefore` from every
 * page and puts an older page before the rows it holds, dropping repeated ids;
 * `applyHistoryResult` classifies with the app's own `classifyHistoryResult`,
 * loads the tail again on `reload`, and applies deltas by id, an entry it does
 * not hold going last.
 */
class TerminalClient {
  rows: HostTranscriptHistoryEntry[] = []
  history: TuiHistoryState | null = null
  lastPage: HostThreadHistoryPage | null = null
  reloads = 0
  deltasApplied = 0
  olderPages = 0
  readonly olderFailures: string[] = []

  constructor(
    private readonly host: HistoryHost,
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
    this.lastPage = page
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

  async refresh(): Promise<void> {
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
    if (decision === 'ignore') return
    if (decision === 'reload') {
      this.reloads += 1
      await this.load()
      return
    }
    if (result.kind !== 'deltas') return
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
  }
}

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('history of a thread the desktop app owns, written by another process', () => {
  it('reaches the terminal app as the full copy at every revision served, by pages and deltas', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    try {
      const executable = path.join(root, 'writer.cjs')
      buildSync({
        stdin: {
          contents: WRITER(path.join(__dirname, '..', 'main', 'store')),
          resolveDir: process.cwd()
        },
        outfile: executable,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        logLevel: 'silent'
      })
      const profile = path.join(root, 'profile')
      const directory = threadLogDirectory(profile)
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      const copy = new FullCopy(root)
      let writerLive = true
      const fullCopyAsked: string[] = []
      const router = new HostThreadHistoryRouter({
        profilePath: profile,
        fullCopy: {
          threadHistory: (request) => {
            fullCopyAsked.push(writerLive ? 'page while the writer ran' : 'page')
            return copy.page(recordAt(LAST), request)
          },
          historySince: (request) => {
            fullCopyAsked.push(writerLive ? 'since while the writer ran' : 'since')
            return copy.since(recordAt(LAST), request)
          }
        },
        seedPort: {
          seed: async () => {
            await turn()
            return (await appLoad(directory)) as unknown as HostThreadLogRecord | null
          }
        },
        // The timer would poll between a request and the check of what it served.
        pollIntervalMs: 60 * 60 * 1000,
        history: { windowMessages: 48 }
      })
      const writer = spawn(process.execPath, [executable, directory, String(LAST)], {
        stdio: ['pipe', 'pipe', 'pipe']
      })
      let stderr = ''
      writer.stderr.on('data', (chunk) => (stderr += String(chunk)))
      let reported = 1
      let done = false
      let lines = ''
      writer.stdout.on('data', (chunk) => {
        lines += String(chunk)
        const whole = lines.split('\n')
        lines = whole.pop()!
        for (const line of whole) {
          if (line === 'done') done = true
          else reported = Number(line)
        }
      })
      const exited = new Promise<number | null>((resolve) => writer.on('exit', resolve))
      try {
        // The grant's file, as the app writes it before its first append.
        await new ThreadAuthorityFiles(profile).write({
          threadId: CHAT,
          writer: { writerId: 'desk-1', pid: writer.pid! },
          epoch: { host: 'f'.repeat(64), grant: 1 },
          grantedAtRevision: 1,
          grantedAt: Date.now()
        })
        while (reported < 2) await new Promise((resolve) => setTimeout(resolve, 1))

        const followed = (): number => {
          const thread = router.snapshot().threads.find((each) => each.threadId === CHAT)
          if (!thread || thread.freshness.followedRevision === null) {
            throw new Error('the thread is not followed')
          }
          return thread.freshness.followedRevision
        }
        /** Every nudge delivered has finished its poll. */
        const idle = async (): Promise<void> => {
          for (let turns = 0; ; turns += 1) {
            const thread = router.snapshot().threads.find((each) => each.threadId === CHAT)
            if (!thread?.polling) return
            if (turns > 10_000) throw new Error('a nudge never finished its poll')
            await turn()
          }
        }
        const failures: string[] = []
        const expectServed = (client: TerminalClient, note: string): void => {
          const revision = followed()
          const whole = copy.whole(recordAt(revision))
          if (client.rows.length < Math.min(client.limit, whole.length)) {
            failures.push(`${note} at ${revision}: holds ${client.rows.length} rows`)
          }
          const tail = whole.slice(whole.length - client.rows.length)
          if (JSON.stringify(client.rows) !== JSON.stringify(tail)) {
            failures.push(`${note} at ${revision}: rows differ from the full copy`)
          }
        }
        const expectTailPage = (client: TerminalClient, note: string): void => {
          const revision = followed()
          const page = client.lastPage!
          const full = copy.page(recordAt(revision), { threadId: CHAT, limit: PAGE })
          if (page.generation < HOST_THREAD_LOG_HISTORY_GENERATION_BASE) {
            failures.push(`${note} at ${revision}: served from the full copy`)
          }
          if (JSON.stringify(page.entries) !== JSON.stringify(full.entries.map(wireEntry))) {
            failures.push(`${note} at ${revision}: tail page differs from the full copy's`)
          }
          if (Boolean(page.nextBefore) !== Boolean(full.nextBefore)) {
            failures.push(`${note} at ${revision}: older pages differ from the full copy's`)
          }
        }

        const client = new TerminalClient(router, PAGE)
        await client.load()
        expectTailPage(client, 'first load')
        expectServed(client, 'first load')
        let nudged = 1
        let operations = 0
        const revisionsServed = new Set<number>()
        while (!done) {
          // The app's advanced messages that arrived meanwhile: one nudge for them.
          if (reported > nudged) {
            nudged = reported
            router.nudge(CHAT)
            await idle()
          }
          operations += 1
          // Now and then nobody asks, and nothing nudges, while the writer
          // rotates and compacts several times: the follower falls behind a
          // checkpoint and is seeded again when next asked.
          if (operations % 60 === 0) {
            const target = reported + 40
            while (reported < target && !done) {
              await new Promise((resolve) => setTimeout(resolve, 5))
            }
            nudged = reported
          }
          if (operations % 23 === 0) {
            await client.load()
            expectTailPage(client, `load ${operations}`)
          } else if (operations % 7 === 0) {
            await client.older()
            await client.refresh()
          } else {
            await client.refresh()
          }
          expectServed(client, `operation ${operations}`)
          revisionsServed.add(followed())
          if (failures.length > 0) break
        }
        expect(failures).toEqual([])
        expect(fullCopyAsked).toEqual([])

        // Caught up with the last revision: nudged until the follower holds it.
        for (let polls = 0; followed() < LAST; polls += 1) {
          if (polls > 1000) throw new Error('the follower never reached the last revision')
          router.nudge(CHAT)
          await idle()
        }
        await client.refresh()
        expectServed(client, 'last refresh')
        // Every page, newest first, is the full copy's page.
        const pages: HostThreadHistoryPage[] = [
          await router.threadHistory({ threadId: CHAT, limit: PAGE })
        ]
        while (pages.at(-1)!.nextBefore) {
          pages.push(
            await router.threadHistory({
              threadId: CHAT,
              limit: PAGE,
              before: pages.at(-1)!.nextBefore
            })
          )
        }
        const fullPages = copy.pages(recordAt(LAST), PAGE)
        expect(pages.map((page) => page.entries.map(wireEntry))).toEqual(
          fullPages.map((page) => page.entries.map(wireEntry))
        )
        expect(pages.map((page) => Boolean(page.nextBefore))).toEqual(
          fullPages.map((page) => Boolean(page.nextBefore))
        )
        expect(failures).toEqual([])
        expect(fullCopyAsked).toEqual([])

        // The client really was served across the writer's run, by every means.
        expect(revisionsServed.size).toBeGreaterThan(10)
        expect(client.deltasApplied).toBeGreaterThan(0)
        expect(client.reloads).toBeGreaterThan(0)
        expect(client.olderPages).toBeGreaterThan(0)
        const thread = router.snapshot().threads.find((each) => each.threadId === CHAT)!
        expect(thread.follower.seeds.cold).toBe(1)
        expect(thread.follower.seeds['checkpoint-passed']).toBeGreaterThan(0)
        expect(thread.follower.batchesApplied).toBeGreaterThan(0)

        // The writer ends: its file now names a process that is gone, and the
        // thread is served from the full copy again.
        writerLive = false
        writer.stdin.end()
        expect(await exited, stderr).toBe(0)
        const after = await router.threadHistory({ threadId: CHAT, limit: PAGE })
        expect(after.generation).toBe(LAST)
        expect(fullCopyAsked).toEqual(['page'])
        expect(router.snapshot().followed).toBe(0)
        expect(router.snapshot().dropped['writer-ended']).toBe(1)
      } finally {
        router.close()
        if (writer.exitCode === null && writer.signalCode === null) writer.kill('SIGKILL')
        await exited
      }
    } finally {
      removeTemporaryDirectory(root)
    }
  }, 120_000)
})
