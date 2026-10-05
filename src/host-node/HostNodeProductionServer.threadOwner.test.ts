/**
 * The production Host builds its `thread.owner` service from its own
 * readings: the thread log authority switch once, from the injected
 * environment; the transactional persist switch as the Host already read it;
 * the welcome's boot epoch as the grants' incarnation; and the store's and
 * the domain's own facts for the Host's full copy and its runs. With the
 * switch on, the history it serves for a thread the desktop app owns comes
 * from that thread's log; off, history is the full copy's, untouched.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ThreadAuthorityFiles } from '../host-shared/thread-log/ThreadAuthorityFile'
import { THREAD_LOG_AUTHORITY_ENV } from '../host-shared/thread-log/ThreadLogAuthoritySwitch'
import { TASKWRAITH_HOST_TXN_PERSIST_ENV } from '../host-runtime/HostCommandExecutionClass'
import type { HostLocalServerOptions } from '../host-runtime/HostLocalServer'
import {
  HOST_PROFILE_CHATS_DIRECTORY,
  HostProfileDomainStore
} from '../host-runtime/HostProfileDomainStore'
import type { HostStandaloneCompositionInput } from '../host-runtime/HostStandaloneComposition'
import { HostThreadHistoryRouter } from '../host-runtime/HostThreadHistoryRouter'
import { HOST_THREAD_LOG_HISTORY_GENERATION_BASE } from '../host-runtime/HostThreadLogHistory'
import type { HostThreadOwnerService } from '../host-runtime/HostThreadOwnerService'
import { deriveChatRecordMutation } from '../main/store/ChatRecordMutation'
import { createIncrementalChatJournal } from '../main/store/IncrementalChatJournal'
import type { ChatRecord } from '../main/store/types'
import type { HostThreadHistoryPage } from '../shared/hostHistoryProtocol'
import { HostNodeInteractionRegistry } from './HostNodeInteractionRegistry'
import { HostNodeProductionServer } from './HostNodeProductionServer'

const TEMPORARY_PREFIX = 'host-node-thread-owner-'
const BOOT_EPOCH = 'f'.repeat(64)

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
  rmSync(directory, { recursive: true, force: true })
}

const profiles: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const profile of profiles.splice(0)) removeTemporaryDirectory(profile)
})

/** An environment that counts each read of the two switches. */
function counted(environment: Record<string, string>) {
  const reads = { authority: 0, transactional: 0 }
  const proxy = new Proxy(environment, {
    get(target, property, receiver) {
      if (property === THREAD_LOG_AUTHORITY_ENV) reads.authority += 1
      if (property === TASKWRAITH_HOST_TXN_PERSIST_ENV) reads.transactional += 1
      return Reflect.get(target, property, receiver)
    }
  })
  return { environment: proxy as NodeJS.ProcessEnv, reads }
}

/**
 * The production server with an injected lease, store, domain, composition
 * and listener, as `HostNodeProductionServer.txnPersist.test.ts` cuts it
 * down; the listener records the input it is built with.
 */
function harness(
  environment: NodeJS.ProcessEnv,
  extra: (profile: string) => Record<string, unknown> = () => ({})
) {
  const profile = mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
  profiles.push(profile)
  let listenerInput: HostLocalServerOptions | undefined
  let compositionInput: HostStandaloneCompositionInput | undefined
  const revisions = new Map<string, number>()
  const hostRuns = new Set<string>()
  const store = {
    threadRecordState: vi.fn((threadId: string) =>
      revisions.has(threadId) ? { revision: revisions.get(threadId)!, identity: {}, key: '' } : null
    ),
    admitCommittedThreadRecord: () => undefined
  }
  const composition = {
    authority: {},
    session: {},
    perf: {
      snapshot: vi.fn(() => ({})),
      spans: {},
      snapshotFile: null,
      identity: {
        process: 'host' as const,
        instanceId: 'host',
        generation: 0,
        pid: process.pid,
        bootEpoch: BOOT_EPOCH
      }
    },
    recoverQueuedStarts: vi.fn(async () => undefined),
    startProjectionReconciliation: vi.fn(async () => undefined),
    reconcileProjection: vi.fn(async () => undefined),
    subscribeDeltas: vi.fn(() => () => {}),
    shutdown: vi.fn(async () => undefined)
  }
  const domain = {
    setupExecutor: { execute: vi.fn() },
    snapshotDonor: vi.fn(() => ({})),
    evaluateAuthority: vi.fn(() => ({ decision: 'deny', reason: 'test' })),
    executeCommand: vi.fn(),
    acknowledgeQueuedComposerSend: vi.fn(),
    providerStatuses: vi.fn(async () => []),
    providerOffers: vi.fn(),
    providerAuthFlows: vi.fn(async () => []),
    providerAuthStatus: vi.fn(),
    threadHistory: vi.fn(),
    historySince: vi.fn(),
    hasRuntimeWorkForThread: vi.fn((threadId: string) => hostRuns.has(threadId)),
    supportsWorkspaceGit: false,
    supportsEnsembleSeatControl: false,
    gitRead: vi.fn(),
    registry: {
      supportsApprovals: false,
      supportsQuestions: false,
      providerIds: [],
      refreshOffers: vi.fn(async () => undefined)
    },
    interactions: new HostNodeInteractionRegistry(),
    runAdmissionOccupancy: vi.fn(() => ({ inflight: 0, queued: 0 })),
    shutdown: vi.fn(async () => undefined)
  }
  const server = new HostNodeProductionServer({
    profilePath: profile,
    mode: 'production',
    environment,
    domainOptions: {} as never,
    signalTarget: { once: () => undefined, removeListener: () => undefined },
    acquireLease: () => ({ path: profile, assertHeld: () => undefined, release: () => true }),
    resolveIdentity: () => ({ installId: 'a'.repeat(48), hostId: 'host', hostVersion: '1.0' }),
    createStore: () => store as never,
    createDomain: () => domain as never,
    createComposition: (input) => {
      compositionInput = input
      return composition as never
    },
    createListener: (input) => {
      listenerInput = input
      return {
        socketPath: path.join(profile, 'host.sock'),
        discoveryPath: path.join(profile, 'host.json'),
        startedAt: '2026-10-05T10:00:00.000Z',
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined)
      } as never
    },
    ...extra(profile)
  })
  return {
    server,
    profile,
    domain,
    revisions,
    hostRuns,
    owners: () => listenerInput?.threadOwners as HostThreadOwnerService | undefined,
    composition: () => compositionInput!
  }
}

const claim = (threadId: string, revision: number, claimId = 1) => ({
  action: 'claim' as const,
  threadId,
  writerId: 'desk-1',
  claimId,
  baseRevision: revision,
  headRevision: revision
})

describe('HostNodeProductionServer: thread.owner', () => {
  it('hands its listener a service that takes no claims while the switch is off', async () => {
    const { environment, reads } = counted({})
    const h = harness(environment)
    await h.server.start()
    try {
      expect(h.owners()?.mode).toBe('off')
      expect(await h.owners()!.answer(1, claim('thread-1', 3))).toMatchObject({
        reply: { granted: false, reason: 'disabled' }
      })
      expect(reads.authority).toBe(1)
    } finally {
      await h.server.stop()
    }
  })

  it('on, grants from the store’s full copy and the domain’s runs, under the welcome’s epoch', async () => {
    const { environment, reads } = counted({ [THREAD_LOG_AUTHORITY_ENV]: '1' })
    const h = harness(environment)
    await h.server.start()
    try {
      const owners = h.owners()!
      expect(owners.mode).toBe('on')
      h.revisions.set('thread-1', 3)
      h.revisions.set('thread-2', 8)
      h.hostRuns.add('thread-2')
      expect(await owners.answer(1, claim('thread-1', 3))).toMatchObject({
        reply: { granted: true, epoch: { host: BOOT_EPOCH, grant: 1 } }
      })
      expect(await owners.answer(1, claim('thread-2', 8, 2))).toMatchObject({
        reply: { granted: false, reason: 'host_run_active', revision: 8 }
      })
      expect(await owners.answer(1, claim('thread-3', 0, 3))).toMatchObject({
        reply: { granted: false, reason: 'host_behind', revision: null }
      })
      // Each switch was read once, at start.
      expect(reads).toEqual({ authority: 1, transactional: 1 })
    } finally {
      await h.server.stop()
    }
  })

  it('on, takes no claims on a Host started with transactional persists', async () => {
    const { environment, reads } = counted({
      [THREAD_LOG_AUTHORITY_ENV]: '1',
      [TASKWRAITH_HOST_TXN_PERSIST_ENV]: '1'
    })
    const h = harness(environment)
    await h.server.start()
    try {
      expect(h.owners()?.mode).toBe('off-txn-persist')
      expect(reads).toEqual({ authority: 1, transactional: 1 })
    } finally {
      await h.server.stop()
    }
  })
})

const CHAT = 'chat-1'
const AT = '2026-10-05T00:00:00.000Z'

/** A thread's full copy as the Host keeps one, with tool rows and a run. */
function sampleThread(revision: number): ChatRecord {
  return {
    appChatId: CHAT,
    title: 'Thread',
    createdAt: 1,
    updatedAt: revision,
    archived: false,
    persistenceRevision: revision,
    messages: [
      { id: 'm1', role: 'user', content: 'Read the file', timestamp: AT },
      { id: 'm2', role: 'assistant', content: 'Reading it.', timestamp: AT, runId: 'r1' },
      {
        id: 'm3',
        role: 'tool',
        content: '',
        timestamp: AT,
        toolActivities: [
          {
            id: 't1',
            toolName: 'Read',
            displayName: 'Read src/a.ts',
            category: 'read',
            status: 'success',
            filePath: 'src/a.ts'
          }
        ]
      } as ChatRecord['messages'][number],
      { id: 'm4', role: 'user', content: 'Thanks', timestamp: AT },
      { id: 'm5', role: 'assistant', content: 'Done.', timestamp: AT, runId: 'r1' }
    ],
    runs: [
      {
        runId: 'r1',
        startedAt: AT,
        status: 'completed',
        toolActivities: [{ id: 'h1', name: 'Read', category: 'read', status: 'success' }]
      } as unknown as ChatRecord['runs'][number]
    ]
  }
}

/** A real profile store over the thread's full copy, for the domain to answer history with. */
function fullCopyStore(profile: string): HostProfileDomainStore {
  const chats = path.join(profile, 'full-copy', HOST_PROFILE_CHATS_DIRECTORY)
  mkdirSync(chats, { recursive: true, mode: 0o700 })
  writeFileSync(path.join(chats, `${CHAT}.json`), `${JSON.stringify(sampleThread(7))}\n`, {
    mode: 0o600
  })
  return new HostProfileDomainStore({
    profilePath: path.join(profile, 'full-copy'),
    authority: { assertProfileAuthority: () => {} },
    now: () => 0,
    idFactory: () => 'unused'
  })
}

/** The thread's log, as the app writes it, `messages` messages past its first record. */
function writeLog(profile: string, messages: number): ChatRecord {
  const journal = createIncrementalChatJournal(path.join(profile, 'chat-journal-v2'), {
    noteDurabilityDebt: () => {},
    syncDirectory: () => Promise.resolve(),
    canRepairOnRead: () => false,
    repairTornTailBeforeAppend: true
  })
  let record: ChatRecord = { ...sampleThread(1), messages: [], runs: [] }
  journal.initialize(CHAT, record)
  for (let index = 0; index < messages; index += 1) {
    const revision = (record.persistenceRevision ?? 0) + 1
    const next = {
      ...record,
      updatedAt: revision,
      persistenceRevision: revision,
      messages: [
        ...record.messages,
        {
          id: `log-${revision}`,
          role: 'user' as const,
          content: `from the log ${revision}`,
          timestamp: AT
        }
      ]
    }
    journal.append(deriveChatRecordMutation(record, next, { savedAt: AT }))
    record = next
  }
  return record
}

/** The app's own load, as a seed. */
function appLoadSeed(profile: string) {
  return {
    seed: async ({ chatId }: { chatId: string }) =>
      createIncrementalChatJournal(path.join(profile, 'chat-journal-v2'), {
        noteDurabilityDebt: () => {},
        canWrite: () => false
      }).replay(chatId).record as never
  }
}

async function own(profile: string, writerId = 'desk-1'): Promise<void> {
  await new ThreadAuthorityFiles(profile).write({
    threadId: CHAT,
    writer: { writerId, pid: process.pid },
    epoch: { host: 'e'.repeat(64), grant: 1 },
    grantedAtRevision: 1,
    grantedAt: 1
  })
}

/**
 * What the providers answered over the full copy, captured from the Host as
 * it was before history could come from a log (3c801bce9): the sha256 of the
 * answers' JSON, two pages, two `history.since` and two refusals.
 */
const FULL_COPY_GOLDEN = '107107a07f957d944ade1c194788b7925e320724b1b3386ae5f4361fd722b497'

describe('HostNodeProductionServer: thread history', () => {
  it('off, hands history to the full copy untouched, and adds no perf section', async () => {
    const { environment, reads } = counted({})
    const h = harness(environment)
    const store = fullCopyStore(h.profile)
    h.domain.threadHistory.mockImplementation((request) => store.threadHistory(request))
    h.domain.historySince.mockImplementation((request) => store.historySince(request))
    // A file naming a live writer is no concern of a Host with the switch off.
    await own(h.profile)
    await h.server.start()
    try {
      const input = h.composition()
      const answers: unknown[] = []
      const tail = input.threadHistoryProvider!({ threadId: CHAT, limit: 2 })
      // The domain's own answer, as it gave it: not a promise, not a copy.
      expect(tail).toBe(h.domain.threadHistory.mock.results[0]!.value)
      const page = tail as HostThreadHistoryPage
      answers.push(page)
      answers.push(
        input.threadHistoryProvider!({ threadId: CHAT, limit: 2, before: page.nextBefore })
      )
      answers.push(
        input.historySinceProvider!({
          threadId: CHAT,
          since: { generation: page.generation, cursor: page.cursor }
        })
      )
      answers.push(
        input.historySinceProvider!({ threadId: CHAT, since: { generation: 1, cursor: 0 } })
      )
      for (const request of [
        { threadId: 'chat-2', limit: 2 },
        { threadId: CHAT, limit: 2, before: { generation: 99, cursor: 1 } }
      ]) {
        try {
          answers.push(input.threadHistoryProvider!(request))
        } catch (error) {
          answers.push({ error: (error as Error).message })
        }
      }
      expect(createHash('sha256').update(JSON.stringify(answers)).digest('hex')).toBe(
        FULL_COPY_GOLDEN
      )
      expect(Object.keys(input.perf!.instrumentation!.snapshot().sections)).toEqual(['workSpans'])
      expect(reads.authority).toBe(1)
    } finally {
      await h.server.stop()
    }
  })

  it('on, serves a thread whose file names a live writer from its log, and the rest from the full copy', async () => {
    const { environment } = counted({ [THREAD_LOG_AUTHORITY_ENV]: '1' })
    const h = harness(environment, (profile) => ({ threadLogSeedPort: appLoadSeed(profile) }))
    expect(writeLog(h.profile, 3).persistenceRevision).toBe(4)
    h.domain.threadHistory.mockImplementation((request: { threadId: string }) => ({
      threadId: request.threadId,
      generation: 3,
      cursor: 0,
      entries: []
    }))
    await own(h.profile)
    await h.server.start()
    try {
      const input = h.composition()
      const page = await input.threadHistoryProvider!({ threadId: CHAT, limit: 2 })
      expect(page.generation).toBeGreaterThanOrEqual(HOST_THREAD_LOG_HISTORY_GENERATION_BASE)
      expect(page.entries.map((entry) => entry.entryId)).toEqual(['log-3', 'log-4'])
      expect(await input.threadHistoryProvider!({ threadId: 'chat-2', limit: 2 })).toMatchObject({
        generation: 3
      })
      const sections = () =>
        input.perf!.instrumentation!.snapshot().sections as Record<string, Record<string, unknown>>
      expect(sections().threadLogHistory).toMatchObject({
        followed: 1,
        served: { log: 1, fullCopy: { 'no-file': 1 } }
      })
      expect(sections().threadOwners).toMatchObject({ mode: 'on' })
      // The writer's `advanced` nudges the thread's follower; its release lets the follower go.
      h.revisions.set(CHAT, 1)
      const owners = h.owners()!
      const claimed = await owners.answer(1, {
        action: 'claim',
        threadId: CHAT,
        writerId: 'desk-1',
        claimId: 1,
        baseRevision: 1,
        headRevision: 4
      })
      expect(claimed).toMatchObject({ reply: { granted: true } })
      const epoch = (claimed as { reply: { epoch: { host: string; grant: number } } }).reply.epoch
      await owners.answer(1, { action: 'advanced', threadId: CHAT, epoch, revision: 5 })
      expect(sections().threadLogHistory).toMatchObject({ nudges: { followed: 1 } })
      await owners.answer(1, { action: 'release', threadId: CHAT, epoch, revision: 5 })
      expect(sections().threadLogHistory).toMatchObject({ followed: 0, dropped: { released: 1 } })
    } finally {
      await h.server.stop()
    }
  })

  it('on, with nothing to seed a log from, serves every thread from the full copy, and says so', async () => {
    const { environment } = counted({ [THREAD_LOG_AUTHORITY_ENV]: '1' })
    const lines: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((text) => {
      lines.push(String(text))
      return true
    })
    const h = harness(environment)
    writeLog(h.profile, 3)
    await own(h.profile)
    await h.server.start()
    try {
      const input = h.composition()
      const answer = input.threadHistoryProvider!({ threadId: CHAT, limit: 2 })
      expect(answer).toBe(h.domain.threadHistory.mock.results[0]!.value)
      const sections = input.perf!.instrumentation!.snapshot().sections
      expect(Object.keys(sections).sort()).toEqual(['threadOwners', 'workSpans'])
      expect(lines).toContainEqual(expect.stringContaining('served from the full copy'))
    } finally {
      await h.server.stop()
    }
  })

  it('on, lets every follower go when it stops', async () => {
    const { environment } = counted({ [THREAD_LOG_AUTHORITY_ENV]: '1' })
    const h = harness(environment, (profile) => ({ threadLogSeedPort: appLoadSeed(profile) }))
    writeLog(h.profile, 3)
    await own(h.profile)
    const closed = vi.spyOn(HostThreadHistoryRouter.prototype, 'close')
    await h.server.start()
    const input = h.composition()
    await input.threadHistoryProvider!({ threadId: CHAT, limit: 2 })
    expect(closed).not.toHaveBeenCalled()
    await h.server.stop()
    expect(closed).toHaveBeenCalledTimes(1)
  })
})
