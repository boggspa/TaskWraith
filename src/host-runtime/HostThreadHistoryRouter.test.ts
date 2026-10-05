/**
 * Which copy of a thread the Host serves the terminal app's history from,
 * with the thread log authority switch on: the log, while the thread's
 * authority file names a live writer, and the full copy otherwise. And how
 * the followers it keeps are polled, bounded and let go.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ThreadAuthorityFiles,
  threadAuthorityFilePath,
  type ThreadAuthorityWriter
} from '../host-shared/thread-log/ThreadAuthorityFile'
import { deriveChatRecordMutation } from '../main/store/ChatRecordMutation'
import {
  createIncrementalChatJournal,
  type IncrementalChatJournal
} from '../main/store/IncrementalChatJournal'
import type { ChatRecord } from '../main/store/types'
import {
  decodeHostTranscriptHistoryEntry,
  type HostHistorySinceResult,
  type HostThreadHistoryPage,
  type HostTranscriptHistoryEntry
} from '../shared/hostHistoryProtocol'
import {
  HostThreadHistoryRouter,
  type HostThreadHistoryRouterOptions,
  type HostThreadHistoryRouterTimers
} from './HostThreadHistoryRouter'
import {
  HostThreadLogFollower,
  type HostThreadLogRecord,
  type HostThreadLogSeedPort
} from './HostThreadLogFollower'
import {
  HOST_THREAD_LOG_HISTORY_GENERATION_BASE,
  HostThreadLogHistory,
  hostThreadLogHistoryEntries
} from './HostThreadLogHistory'
import { threadLogDirectory } from './HostThreadOwnerService'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'host-history-router-'

/** Remove, with all it holds, a folder made here by `mkdtempSync` with TEMPORARY_PREFIX. */
function removeTemporaryDirectory(directory: string): void {
  const temporary = os.tmpdir()
  if (
    directory === temporary ||
    path.dirname(directory) !== temporary ||
    !path.basename(directory).startsWith(TEMPORARY_PREFIX) ||
    path.basename(directory).length <= TEMPORARY_PREFIX.length
  ) {
    throw new Error(`Refusing to remove ${directory}: not a folder this file made`)
  }
  fs.rmSync(directory, { recursive: true, force: true })
}

const CHAT = 'chat-1'
const AT = '2026-10-05T00:00:00.000Z'

let profile = ''
let directory = ''
let clock = 0
const ended = new Set<string>()
const routers: HostThreadHistoryRouter[] = []
const journals = new Map<string, AppLog>()

beforeEach(() => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
  directory = threadLogDirectory(profile)
  fs.mkdirSync(directory, { recursive: true })
  clock = 1_000_000
  ended.clear()
})

afterEach(() => {
  for (const router of routers.splice(0)) router.close()
  journals.clear()
  vi.restoreAllMocks()
  removeTemporaryDirectory(profile)
})

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let turns = 0; !condition(); turns += 1) {
    if (turns > 2000) throw new Error(`never: ${what}`)
    await turn()
  }
}

/** A thread's journal, written on this thread as the app writes it under the barrier. */
class AppLog {
  readonly journal: IncrementalChatJournal
  record: ChatRecord

  constructor(readonly chatId: string) {
    this.journal = createIncrementalChatJournal(directory, {
      noteDurabilityDebt: () => {},
      syncDirectory: () => Promise.resolve(),
      maxJournalBytes: 64 * 1024 * 1024,
      canRepairOnRead: () => false,
      repairTornTailBeforeAppend: true
    })
    this.record = {
      appChatId: chatId,
      title: 'Thread',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      persistenceRevision: 1,
      messages: [],
      runs: []
    }
    this.journal.initialize(chatId, this.record)
  }

  say(content: string): number {
    const revision = (this.record.persistenceRevision ?? 0) + 1
    const next: ChatRecord = {
      ...this.record,
      updatedAt: revision,
      persistenceRevision: revision,
      messages: [
        ...this.record.messages,
        { id: `m${revision}`, role: 'user', content, timestamp: AT }
      ]
    }
    this.journal.append(
      deriveChatRecordMutation(this.record, next, {
        savedAt: new Date(Date.parse(AT) + revision * 1000).toISOString()
      })
    )
    this.record = next
    return revision
  }
}

function logOf(chatId = CHAT, messages = 0): AppLog {
  const log = new AppLog(chatId)
  for (let index = 0; index < messages; index += 1) log.say(`message ${index}`)
  journals.set(chatId, log)
  return log
}

/** The app's own load, read-only, as the production seed builds it. */
function seedPortOf(): HostThreadLogSeedPort & {
  asked: number
  fail: boolean
  hold: Promise<void> | null
} {
  const port = {
    asked: 0,
    fail: false,
    hold: null as Promise<void> | null,
    async seed({ chatId }: { chatId: string }): Promise<HostThreadLogRecord | null> {
      port.asked += 1
      await turn()
      if (port.hold) await port.hold
      if (port.fail) throw new Error('the seed could not be loaded')
      return createIncrementalChatJournal(directory, {
        noteDurabilityDebt: () => {},
        canWrite: () => false
      }).replay(chatId).record as unknown as HostThreadLogRecord | null
    }
  }
  return port
}

/** The full copy: answers that say where they came from. */
function fullCopyOf() {
  const calls: Array<[string, string]> = []
  return {
    calls,
    threadHistory: (request: { threadId: string }): HostThreadHistoryPage => {
      calls.push(['page', request.threadId])
      return { threadId: request.threadId, generation: 3, cursor: 0, entries: [] }
    },
    historySince: (request: {
      threadId: string
      since: { generation: number; cursor: number }
    }): HostHistorySinceResult => {
      calls.push(['since', request.threadId])
      return {
        kind: 'full_resnapshot_required',
        threadId: request.threadId,
        generation: 3,
        cursor: 0,
        clientGeneration: request.since.generation,
        clientCursor: request.since.cursor,
        reason: 'generation_mismatch'
      }
    }
  }
}

/** Intervals that fire when the test says. */
function timersOf(): HostThreadHistoryRouterTimers & {
  readonly handles: Array<{ callback: () => void; ms: number; cleared: boolean }>
  tick(): void
} {
  const handles: Array<{ callback: () => void; ms: number; cleared: boolean }> = []
  return {
    handles,
    setInterval: (callback, ms) => {
      const handle = { callback, ms, cleared: false }
      handles.push(handle)
      return handle
    },
    clearInterval: (handle) => {
      ;(handle as { cleared: boolean }).cleared = true
    },
    tick: () => {
      for (const handle of handles) if (!handle.cleared) handle.callback()
    }
  }
}

/** The grant's file, as the app writes it before its first append. */
async function own(threadId = CHAT, writerId = 'desk-1'): Promise<void> {
  await new ThreadAuthorityFiles(profile).write({
    threadId,
    writer: { writerId, pid: process.pid },
    epoch: { host: 'f'.repeat(64), grant: 1 },
    grantedAtRevision: 1,
    grantedAt: 1
  })
}

async function disown(threadId = CHAT): Promise<void> {
  await new ThreadAuthorityFiles(profile).remove(threadId)
}

function wire(entries: readonly HostTranscriptHistoryEntry[]): HostTranscriptHistoryEntry[] {
  return entries.map((entry) => {
    const decoded = decodeHostTranscriptHistoryEntry(entry)
    if (!decoded.ok) throw new Error(decoded.error)
    return decoded.value
  })
}

function routerOf(
  options: Partial<HostThreadHistoryRouterOptions> = {},
  parts: {
    fullCopy?: ReturnType<typeof fullCopyOf>
    seedPort?: ReturnType<typeof seedPortOf>
    timers?: ReturnType<typeof timersOf>
  } = {}
) {
  const fullCopy = parts.fullCopy ?? fullCopyOf()
  const seedPort = parts.seedPort ?? seedPortOf()
  const timers = parts.timers ?? timersOf()
  const router = new HostThreadHistoryRouter({
    profilePath: profile,
    fullCopy,
    seedPort,
    liveness: (writer: ThreadAuthorityWriter) => (ended.has(writer.writerId) ? 'dead' : 'alive'),
    now: () => clock,
    timers,
    ...options
  })
  routers.push(router)
  const thread = (threadId = CHAT) =>
    router.snapshot().threads.find((each) => each.threadId === threadId)
  const idle = () =>
    until(() => router.snapshot().threads.every((each) => !each.polling), 'polls finished')
  return { router, fullCopy, seedPort, timers, thread, idle }
}

const tail = (threadId = CHAT, limit = 10) => ({ threadId, limit })

describe('the copy a thread’s history is served from', () => {
  it('is the full copy for a thread with no authority file, and nothing is followed', async () => {
    logOf(CHAT, 3)
    const { router, fullCopy, seedPort, timers } = routerOf()
    expect(await router.threadHistory(tail())).toMatchObject({ generation: 3 })
    expect(
      await router.historySince({ threadId: CHAT, since: { generation: 3, cursor: 0 } })
    ).toMatchObject({ generation: 3 })
    expect(fullCopy.calls).toEqual([
      ['page', CHAT],
      ['since', CHAT]
    ])
    const snapshot = router.snapshot()
    expect(snapshot.followed).toBe(0)
    expect(snapshot.served.fullCopy['no-file']).toBe(2)
    expect(snapshot.served.log).toBe(0)
    expect(seedPort.asked).toBe(0)
    expect(timers.handles).toEqual([])
  })

  it('is the log for a thread whose file names a live writer, as the full copy of its record would be', async () => {
    const log = logOf(CHAT, 5)
    await own()
    const { router, fullCopy, thread } = routerOf()
    const whole = wire(hostThreadLogHistoryEntries(log.record as unknown as HostThreadLogRecord))
    const page = await router.threadHistory(tail(CHAT, 2))
    expect(page.generation).toBeGreaterThanOrEqual(HOST_THREAD_LOG_HISTORY_GENERATION_BASE)
    expect(wire(page.entries)).toEqual(whole.slice(-2))
    const older = await router.threadHistory({ ...tail(CHAT, 2), before: page.nextBefore })
    expect(wire(older.entries)).toEqual(whole.slice(-4, -2))
    // A message the app appends reaches a client that asks what changed.
    log.say('after the page')
    const since = await router.historySince({
      threadId: CHAT,
      since: { generation: page.generation, cursor: page.cursor }
    })
    expect(since).toMatchObject({ kind: 'deltas', generation: page.generation })
    expect(since.kind === 'deltas' && since.deltas.map((delta) => delta.kind)).toEqual(['append'])
    expect(fullCopy.calls).toEqual([])
    expect(router.snapshot()).toMatchObject({ followed: 1, served: { log: 3 } })
    expect(thread()).toMatchObject({ status: 'following', follower: { seeds: { cold: 1 } } })
  })

  it('is the full copy again, and the follower is let go, once the file goes or its writer has ended', async () => {
    logOf(CHAT, 2)
    await own()
    const { router, fullCopy } = routerOf()
    expect((await router.threadHistory(tail())).generation).toBeGreaterThan(3)
    await disown()
    expect(await router.threadHistory(tail())).toMatchObject({ generation: 3 })
    expect(router.snapshot()).toMatchObject({ followed: 0, dropped: { 'no-file': 1 } })
    await own()
    expect((await router.threadHistory(tail())).generation).toBeGreaterThan(3)
    ended.add('desk-1')
    expect(await router.threadHistory(tail())).toMatchObject({ generation: 3 })
    expect(router.snapshot()).toMatchObject({
      followed: 0,
      dropped: { 'no-file': 1, 'writer-ended': 1 },
      served: { log: 2, fullCopy: { 'no-file': 1, 'writer-ended': 1 } }
    })
    expect(fullCopy.calls.length).toBe(2)
  })

  it('is the full copy for a file that cannot be read, which names no writer', async () => {
    logOf(CHAT, 2)
    const file = threadAuthorityFilePath(profile, CHAT)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{"format":')
    const { router, seedPort } = routerOf()
    expect(await router.threadHistory(tail())).toMatchObject({ generation: 3 })
    expect(router.snapshot()).toMatchObject({ followed: 0, served: { fullCopy: { damaged: 1 } } })
    expect(seedPort.asked).toBe(0)
  })

  it('is the full copy, with nothing read, for an id the journal names no file for', async () => {
    const files = { read: vi.fn() }
    const { router } = routerOf({ files })
    for (const threadId of ['a.b', 'a b', 'x'.repeat(257)]) {
      expect(await router.threadHistory(tail(threadId))).toMatchObject({ generation: 3 })
    }
    expect(files.read).not.toHaveBeenCalled()
    expect(router.snapshot().served.fullCopy['not-a-log']).toBe(3)
  })

  it('is the full copy while the log cannot be read, which is tried again only after a wait', async () => {
    logOf(CHAT, 2)
    await own()
    const { router, seedPort, timers, thread } = routerOf()
    seedPort.fail = true
    expect(await router.threadHistory(tail())).toMatchObject({ generation: 3 })
    expect(router.snapshot().fallbacks.failed).toBe(1)
    expect(thread()).toMatchObject({ status: 'failed', failures: 1, retryInMs: 1000 })
    // Waiting: neither a request, nor a nudge, nor the timer reads the log.
    expect(
      await router.historySince({ threadId: CHAT, since: { generation: 3, cursor: 0 } })
    ).toMatchObject({ generation: 3 })
    router.nudge(CHAT)
    timers.tick()
    await turn()
    expect(seedPort.asked).toBe(1)
    expect(router.snapshot().fallbacks.backoff).toBe(1)
    // An older page of the log is never the full copy's.
    await expect(
      router.threadHistory({
        ...tail(),
        before: { generation: HOST_THREAD_LOG_HISTORY_GENERATION_BASE + 1, cursor: 1 }
      })
    ).rejects.toThrow()
    // Each failure in a row doubles the wait.
    clock += 1000
    expect(await router.threadHistory(tail())).toMatchObject({ generation: 3 })
    expect(thread()).toMatchObject({ failures: 2, retryInMs: 2000 })
    clock += 2000
    seedPort.fail = false
    expect((await router.threadHistory(tail())).generation).toBeGreaterThan(3)
    expect(thread()).toMatchObject({ status: 'following', failures: 0, retryInMs: 0 })
    expect(seedPort.asked).toBe(3)
  })

  it('is the full copy for a thread that has no log, and the follower is let go', async () => {
    await own()
    const { router } = routerOf()
    expect(await router.threadHistory(tail())).toMatchObject({ generation: 3 })
    expect(router.snapshot()).toMatchObject({
      followed: 0,
      fallbacks: { absent: 1 },
      dropped: { absent: 1 }
    })
  })

  it('is the full copy while the log is slower than a request may wait, and the seed goes on', async () => {
    logOf(CHAT, 2)
    await own()
    const { router, seedPort, thread, idle } = routerOf({ requestWaitMs: 20 })
    let release!: () => void
    seedPort.hold = new Promise((resolve) => (release = resolve))
    expect(await router.threadHistory(tail())).toMatchObject({ generation: 3 })
    expect(router.snapshot().fallbacks.slow).toBe(1)
    release()
    await idle()
    expect(thread()).toMatchObject({ status: 'following' })
    expect((await router.threadHistory(tail())).generation).toBeGreaterThan(3)
    expect(seedPort.asked).toBe(1)
  })
})

describe('the followers the router keeps', () => {
  it('are polled once for each nudge, and once more for the nudges that came while one polled', async () => {
    const log = logOf(CHAT, 2)
    await own()
    const { router, thread, idle } = routerOf()
    await router.threadHistory(tail())
    const polls = vi.spyOn(HostThreadLogFollower.prototype, 'poll')
    const revision = log.say('nudged')
    router.nudge(CHAT)
    await idle()
    expect(polls).toHaveBeenCalledTimes(1)
    expect(thread()!.freshness.followedRevision).toBe(revision)
    router.nudge(CHAT)
    router.nudge(CHAT)
    router.nudge(CHAT)
    await idle()
    expect(polls).toHaveBeenCalledTimes(3)
    // Nobody has asked for this thread: a nudge follows nothing.
    router.nudge('chat-2')
    await idle()
    expect(polls).toHaveBeenCalledTimes(3)
    expect(router.snapshot()).toMatchObject({
      followed: 1,
      nudges: { followed: 4, ignored: 1 },
      polls: { nudge: 3 }
    })
  })

  it('are polled once a second without a nudge, and let go once their file goes', async () => {
    const log = logOf(CHAT, 2)
    await own()
    const { router, timers, thread, idle } = routerOf()
    await router.threadHistory(tail())
    expect(timers.handles.map((handle) => handle.ms)).toEqual([1000])
    const revision = log.say('no nudge')
    clock += 1000
    timers.tick()
    await idle()
    expect(thread()!.freshness.followedRevision).toBe(revision)
    expect(router.snapshot().polls.timer).toBe(1)
    // Polled by a nudge since: the timer leaves it.
    log.say('nudged')
    router.nudge(CHAT)
    await idle()
    clock += 100
    timers.tick()
    await idle()
    expect(router.snapshot().polls.timer).toBe(1)
    await disown()
    clock += 1000
    timers.tick()
    await until(() => router.snapshot().followed === 0, 'the follower was let go')
    expect(router.snapshot().dropped['no-file']).toBe(1)
    // Nothing left to poll: the timer stops.
    expect(timers.handles.map((handle) => handle.cleared)).toEqual([true])
  })

  it('are at most the bound, the least recently asked for let go first', async () => {
    for (const threadId of ['chat-1', 'chat-2', 'chat-3']) {
      logOf(threadId, 2)
      await own(threadId)
    }
    const closed = vi.spyOn(HostThreadLogHistory.prototype, 'close')
    const { router } = routerOf({ maxThreads: 2 })
    await router.threadHistory(tail('chat-1'))
    await router.threadHistory(tail('chat-2'))
    // A nudge is the app writing, not anyone reading: it does not keep a thread.
    router.nudge('chat-1')
    await router.threadHistory(tail('chat-3'))
    expect(router.snapshot().threads.map((thread) => thread.threadId)).toEqual(['chat-2', 'chat-3'])
    expect(router.snapshot().dropped.evicted).toBe(1)
    expect(closed).toHaveBeenCalledTimes(1)
    await router.threadHistory(tail('chat-2'))
    await router.threadHistory(tail('chat-1'))
    expect(router.snapshot().threads.map((thread) => thread.threadId)).toEqual(['chat-1', 'chat-2'])
  })

  it('are let go when their grant is released', async () => {
    logOf(CHAT, 2)
    await own()
    const { router } = routerOf()
    await router.threadHistory(tail())
    router.released(CHAT)
    expect(router.snapshot()).toMatchObject({ followed: 0, dropped: { released: 1 } })
  })

  it('report freshness and reseeds by reason, counting followers let go', async () => {
    const log = logOf(CHAT, 2)
    await own()
    const { router, thread, idle } = routerOf()
    const page = await router.threadHistory(tail())
    const served = log.record.persistenceRevision
    const head = log.say('unserved')
    router.nudge(CHAT)
    await idle()
    expect(page.generation).toBeGreaterThan(3)
    expect(thread()!.freshness).toMatchObject({
      servedRevision: served,
      followedRevision: head,
      logHeadRevision: head,
      revisionsBehind: head - served!
    })
    expect(thread()!.follower.seeds.cold).toBe(1)
    router.released(CHAT)
    await router.threadHistory(tail())
    expect(router.snapshot().seeds.cold).toBe(2)
    expect(router.snapshot().seedsAsked).toEqual({
      'older-row': 0,
      'unresolved-run': 0,
      'record-mismatch': 0
    })
  })

  it('are all let go on close, which stops the timer; the full copy answers after, with nothing read', async () => {
    logOf(CHAT, 2)
    await own()
    const files = new ThreadAuthorityFiles(profile)
    const read = vi.spyOn(files, 'read')
    const { router, timers, fullCopy } = routerOf({ files })
    await router.threadHistory(tail())
    expect(read).toHaveBeenCalledTimes(1)
    router.close()
    expect(timers.handles.map((handle) => handle.cleared)).toEqual([true])
    expect(router.snapshot()).toMatchObject({ followed: 0, dropped: { closed: 1 } })
    expect(await router.threadHistory(tail())).toMatchObject({ generation: 3 })
    expect(router.snapshot().served.fullCopy.closed).toBe(1)
    expect(fullCopy.calls).toEqual([['page', CHAT]])
    expect(read).toHaveBeenCalledTimes(1)
  })
})
