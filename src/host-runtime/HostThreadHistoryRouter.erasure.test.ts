/**
 * The erasure fence around the history router: an erasure lets a followed
 * thread's follower go, the fence keeps it from being seeded or followed
 * again (the full copy answers instead), in-flight polls are awaited, and a
 * finished erasure lifts the fence.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThreadAuthorityFiles } from '../host-shared/thread-log/ThreadAuthorityFile'
import {
  createIncrementalChatJournal,
  type IncrementalChatJournal
} from '../main/store/IncrementalChatJournal'
import type { ChatRecord } from '../main/store/types'
import type { HostHistorySinceResult, HostThreadHistoryPage } from '../shared/hostHistoryProtocol'
import {
  HostThreadHistoryRouter,
  type HostThreadHistoryRouterTimers
} from './HostThreadHistoryRouter'
import type { HostThreadLogRecord, HostThreadLogSeedPort } from './HostThreadLogFollower'
import { threadLogDirectory } from './HostThreadOwnerService'

const TEMPORARY_PREFIX = 'host-history-router-erasure-'

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

const CHAT = 'chat-erasure-1'
const OTHER = 'chat-erasure-2'

let profile = ''
let directory = ''
let clock = 0
const routers: HostThreadHistoryRouter[] = []

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let turns = 0; !condition(); turns += 1) {
    if (turns > 2000) throw new Error(`never: ${what}`)
    await turn()
  }
}

beforeEach(() => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
  directory = threadLogDirectory(profile)
  fs.mkdirSync(directory, { recursive: true })
  clock = 1_000_000
})

afterEach(() => {
  for (const router of routers.splice(0)) router.close()
  vi.restoreAllMocks()
  removeTemporaryDirectory(profile)
})

/** A minimal record: enough for a seed to replay from. */
function seededRecord(chatId: string): { journal: IncrementalChatJournal; record: ChatRecord } {
  const record: ChatRecord = {
    appChatId: chatId,
    title: 'Thread',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    persistenceRevision: 1,
    messages: [],
    runs: []
  }
  const journal = createIncrementalChatJournal(directory, {
    noteDurabilityDebt: () => {},
    syncDirectory: () => Promise.resolve(),
    maxJournalBytes: 64 * 1024 * 1024,
    canRepairOnRead: () => false,
    repairTornTailBeforeAppend: true
  })
  journal.initialize(chatId, record)
  return { journal, record }
}

function seedPortOf(): HostThreadLogSeedPort & { asked: number; hold: Promise<void> | null } {
  const port = {
    asked: 0,
    hold: null as Promise<void> | null,
    async seed({ chatId }: { chatId: string }): Promise<HostThreadLogRecord | null> {
      port.asked += 1
      await turn()
      if (port.hold) await port.hold
      return createIncrementalChatJournal(directory, {
        noteDurabilityDebt: () => {},
        canWrite: () => false
      }).replay(chatId).record as unknown as HostThreadLogRecord | null
    }
  }
  return port
}

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

function timersOf(): HostThreadHistoryRouterTimers {
  return {
    setInterval: () => ({}),
    clearInterval: () => undefined
  }
}

async function own(threadId: string, writerId: string): Promise<void> {
  await new ThreadAuthorityFiles(profile).write({
    threadId,
    writer: { writerId, pid: process.pid },
    epoch: { host: 'f'.repeat(64), grant: 1 },
    grantedAtRevision: 1,
    grantedAt: 1
  })
}

function routerOf(
  parts: {
    fullCopy?: ReturnType<typeof fullCopyOf>
    seedPort?: ReturnType<typeof seedPortOf>
  } = {}
) {
  const fullCopy = parts.fullCopy ?? fullCopyOf()
  const seedPort = parts.seedPort ?? seedPortOf()
  const router = new HostThreadHistoryRouter({
    profilePath: profile,
    fullCopy,
    seedPort,
    liveness: () => 'alive',
    now: () => clock,
    timers: timersOf()
  })
  routers.push(router)
  return { router, fullCopy, seedPort }
}

const tail = (threadId = CHAT) => ({ threadId, limit: 10 })

describe('the history router’s erasure fence', () => {
  it('lets a followed thread go and answers from the full copy while fenced', async () => {
    seededRecord(CHAT)
    await own(CHAT, 'desk-1')
    const { router, fullCopy, seedPort } = routerOf()
    expect((await router.threadHistory(tail())).generation).toBeGreaterThan(3)
    expect(router.snapshot().followed).toBe(1)
    const asked = seedPort.asked
    await router.erasing(CHAT)
    const snapshot = router.snapshot()
    expect(snapshot.followed).toBe(0)
    expect(snapshot.dropped.erased).toBe(1)
    // The full copy answers; nothing is seeded or followed again.
    expect(await router.threadHistory(tail())).toMatchObject({ generation: 3 })
    expect(
      await router.historySince({ threadId: CHAT, since: { generation: 3, cursor: 0 } })
    ).toMatchObject({
      generation: 3
    })
    expect(router.snapshot().followed).toBe(0)
    expect(seedPort.asked).toBe(asked)
    expect(fullCopy.calls).toEqual([
      ['page', CHAT],
      ['since', CHAT]
    ])
    expect(router.snapshot().served.fullCopy.erased).toBe(2)
  })

  it('follows the thread again once the fence lifts', async () => {
    seededRecord(CHAT)
    await own(CHAT, 'desk-1')
    const { router, seedPort } = routerOf()
    expect((await router.threadHistory(tail())).generation).toBeGreaterThan(3)
    await router.erasing(CHAT)
    router.forgetErased(CHAT)
    expect((await router.threadHistory(tail())).generation).toBeGreaterThan(3)
    expect(router.snapshot().followed).toBe(1)
    expect(seedPort.asked).toBe(2)
  })

  it('awaits a poll already in flight before the fence returns', async () => {
    seededRecord(CHAT)
    await own(CHAT, 'desk-1')
    const seedPort = seedPortOf()
    let releaseSeed: (() => void) | null = null
    seedPort.hold = new Promise<void>((resolve) => {
      releaseSeed = resolve
    })
    const { router } = routerOf({ seedPort })
    const request = router.threadHistory(tail())
    await until(() => seedPort.asked > 0, 'the seed was asked')
    let quiesced = false
    const erasing = router.erasing(CHAT).then(() => {
      quiesced = true
    })
    await turn()
    await turn()
    expect(quiesced).toBe(false)
    releaseSeed!()
    await erasing
    expect(quiesced).toBe(true)
    // The request the poll belonged to falls back to the full copy.
    expect(await request).toMatchObject({ generation: 3 })
    expect(router.snapshot().followed).toBe(0)
  })

  it('a global fence covers every followed thread and lifts at once', async () => {
    seededRecord(CHAT)
    seededRecord(OTHER)
    await own(CHAT, 'desk-1')
    await own(OTHER, 'desk-2')
    const { router } = routerOf()
    expect((await router.threadHistory(tail(CHAT))).generation).toBeGreaterThan(3)
    expect((await router.threadHistory(tail(OTHER))).generation).toBeGreaterThan(3)
    expect(router.snapshot().followed).toBe(2)
    await router.erasing()
    expect(router.snapshot().followed).toBe(0)
    expect(router.snapshot().dropped.erased).toBe(2)
    expect(await router.threadHistory(tail(CHAT))).toMatchObject({ generation: 3 })
    expect(await router.threadHistory(tail(OTHER))).toMatchObject({ generation: 3 })
    router.forgetErased()
    expect((await router.threadHistory(tail(CHAT))).generation).toBeGreaterThan(3)
    expect((await router.threadHistory(tail(OTHER))).generation).toBeGreaterThan(3)
    expect(router.snapshot().followed).toBe(2)
  })
})
