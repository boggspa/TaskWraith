/**
 * Independent Threads M4 slice 13f1 (design §23.15, test 1): the private
 * transfer-worker pool behind the public window seed.
 *
 * `createHostThreadRecordModelPool` builds N private `HostThreadRecordTransferWorker`s
 * over a channel factory and sends each `model` job to the least-pending
 * worker, ties to the lowest index. `close()` waits for the jobs in flight,
 * terminates every channel and refuses jobs after. Without a compiled entry it
 * returns `undefined`. It never touches the shared worker.
 *
 * Most tests drive a fake channel factory so no compiled entry is needed: the
 * entry path only has to exist. One test compiles the real entry and models a
 * real profile file through `worker_threads`.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { HostProfileDomainStore } from './HostProfileDomainStore'
import { HostThreadRecordTransferError } from './HostThreadRecordTransfer'
import {
  configureHostThreadRecordTransferChannel,
  createWorkerThreadTransferChannel,
  hostThreadRecordTransferChannelFactory,
  type HostThreadRecordTransferChannelFactory,
  type HostThreadRecordTransferWorkerReply,
  type HostThreadRecordTransferWorkerRequest
} from './HostThreadRecordTransferWorker'
import {
  createHostThreadRecordModelPool,
  HOST_THREAD_RECORD_MODEL_POOL_SIZE,
  type HostThreadRecordModelPool
} from './HostThreadRecordModelPool'

const NOW = 1_760_000_000_000
const TIMEOUT = 15_000
/** Any existing file: the fake channels never load it. */
const EXISTING_ENTRY = __filename

let directory: string
let compiledEntry: string
const pools: HostThreadRecordModelPool[] = []

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'thread-record-model-pool-'))
  compiledEntry = join(directory, 'HostThreadRecordTransferWorkerEntry.cjs')
  await build({
    entryPoints: ['src/host-runtime/HostThreadRecordTransferWorkerEntry.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: compiledEntry,
    logLevel: 'silent'
  })
}, 60_000)

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()))
})
afterAll(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

interface FakeChannel {
  readonly entryPath: string
  readonly posted: HostThreadRecordTransferWorkerRequest[]
  terminated: number
  reply(reply: HostThreadRecordTransferWorkerReply): void
  exit(code: number): void
}

/** In-process channels that record requests and reply only when told to. */
function fakeChannels() {
  const channels: FakeChannel[] = []
  const factory: HostThreadRecordTransferChannelFactory = (entryPath) => {
    let deliver: ((reply: HostThreadRecordTransferWorkerReply) => void) | undefined
    let exited: ((code: number) => void) | undefined
    const channel: FakeChannel = {
      entryPath,
      posted: [],
      terminated: 0,
      reply: (reply) => deliver!(reply),
      exit: (code) => exited?.(code)
    }
    channels.push(channel)
    return {
      kind: 'worker-thread',
      post: (message) => {
        channel.posted.push(message)
      },
      onMessage: (listener) => {
        deliver = listener
      },
      onError: () => undefined,
      onExit: (listener) => {
        exited = listener
      },
      ref: () => undefined,
      unref: () => undefined,
      terminate: async () => {
        channel.terminated += 1
      }
    }
  }
  return { channels, factory }
}

function track(pool: HostThreadRecordModelPool | undefined): HostThreadRecordModelPool {
  if (!pool) throw new Error('expected a pool')
  pools.push(pool)
  return pool
}

/** Resolves 'pending' when the promise has not settled within a short grace period. */
async function settledWithin<T>(promise: Promise<T>, ms = 30): Promise<T | 'pending'> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'pending'>((resolve) => {
    timer = setTimeout(() => resolve('pending'), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const input = (threadId: string) => ({ profilePath: '/nowhere', threadId })

/** A job's posted request, on the channel it went to. */
function lastRequest(channel: FakeChannel): HostThreadRecordTransferWorkerRequest {
  const request = channel.posted.at(-1)
  if (!request) throw new Error('nothing posted')
  return request
}

/** The thread id of a posted model request; any other kind is a failure. */
function threadIdOf(request: HostThreadRecordTransferWorkerRequest): string {
  if (request.kind !== 'model') throw new Error(`expected a model request, got ${request.kind}`)
  return request.input.threadId
}

describe('HostThreadRecordModelPool (M4 slice 13f1, test 1)', () => {
  it(
    'returns undefined without a compiled entry: a missing path, and the default sibling in the source tree',
    () => {
      const { factory, channels } = fakeChannels()
      expect(
        createHostThreadRecordModelPool({
          entryPath: join(directory, 'missing-entry.js'),
          channel: factory
        })
      ).toBeUndefined()
      // The default entry is the compiled sibling of the worker module; in the
      // source tree it does not exist.
      expect(existsSync(join(__dirname, 'HostThreadRecordTransferWorkerEntry.js'))).toBe(false)
      expect(createHostThreadRecordModelPool({ channel: factory })).toBeUndefined()
      expect(createHostThreadRecordModelPool()).toBeUndefined()
      expect(channels).toEqual([])
    },
    TIMEOUT
  )

  it(
    'size defaults to two, honours the option, and is floored at one',
    () => {
      const { factory } = fakeChannels()
      expect(HOST_THREAD_RECORD_MODEL_POOL_SIZE).toBe(2)
      const byDefault = track(
        createHostThreadRecordModelPool({ entryPath: EXISTING_ENTRY, channel: factory })
      )
      expect(byDefault.size).toBe(2)
      const three = track(
        createHostThreadRecordModelPool({ entryPath: EXISTING_ENTRY, channel: factory, size: 3 })
      )
      expect(three.size).toBe(3)
      const floored = track(
        createHostThreadRecordModelPool({ entryPath: EXISTING_ENTRY, channel: factory, size: 0 })
      )
      expect(floored.size).toBe(1)
    },
    TIMEOUT
  )

  it(
    'sends each job to the least-pending worker, ties to the lowest index, and each job resolves with its own reply',
    async () => {
      const { factory, channels } = fakeChannels()
      const pool = track(
        createHostThreadRecordModelPool({ entryPath: EXISTING_ENTRY, channel: factory, size: 3 })
      )
      // Workers start their channel on their first job: creation order is index order.
      const job1 = pool.model(input('t1'))
      expect(channels.map((channel) => channel.posted.length)).toEqual([1])
      const job2 = pool.model(input('t2'))
      expect(channels.map((channel) => channel.posted.length)).toEqual([1, 1])
      const job3 = pool.model(input('t3'))
      expect(channels.map((channel) => channel.posted.length)).toEqual([1, 1, 1])
      // All tied at one pending: the lowest index takes it.
      const job4 = pool.model(input('t4'))
      expect(channels.map((channel) => channel.posted.length)).toEqual([2, 1, 1])
      for (const channel of channels) expect(channel.entryPath).toBe(EXISTING_ENTRY)
      for (const channel of channels) {
        for (const request of channel.posted) {
          expect(request.kind).toBe('model')
          expect(request.kind === 'model' ? request.input : null).toEqual(
            input(threadIdOf(request))
          )
        }
      }

      // Worker 1 answers its job: pending 2, 0, 1, so the next job goes to it.
      channels[1]!.reply({ id: lastRequest(channels[1]!).id, ok: true, value: { kind: 'absent' } })
      expect(await job2).toEqual({ kind: 'absent' })
      const job5 = pool.model(input('t5'))
      expect(channels.map((channel) => channel.posted.length)).toEqual([2, 2, 1])
      // Pending 2, 1, 1: the tie between 1 and 2 goes to 1.
      const job6 = pool.model(input('t6'))
      expect(channels.map((channel) => channel.posted.length)).toEqual([2, 3, 1])
      expect(channels[1]!.posted.map((request) => threadIdOf(request))).toEqual(['t2', 't5', 't6'])

      // Each reply settles exactly the job it names, on the channel it went to.
      const answers = new Map<string, 'absent' | 'invalid'>([
        ['t1', 'invalid'],
        ['t3', 'absent'],
        ['t4', 'absent'],
        ['t5', 'invalid'],
        ['t6', 'invalid']
      ])
      for (const channel of channels) {
        for (const request of channel.posted) {
          if (threadIdOf(request) === 't2') continue
          channel.reply({
            id: request.id,
            ok: true,
            value: { kind: answers.get(threadIdOf(request))! }
          })
        }
      }
      expect(await Promise.all([job1, job3, job4, job5, job6])).toEqual([
        { kind: 'invalid' },
        { kind: 'absent' },
        { kind: 'absent' },
        { kind: 'invalid' },
        { kind: 'invalid' }
      ])
      // Every job settled: the next one starts at the lowest index again.
      const job7 = pool.model(input('t7'))
      expect(channels.map((channel) => channel.posted.length)).toEqual([3, 3, 1])
      channels[0]!.reply({ id: lastRequest(channels[0]!).id, ok: true, value: { kind: 'absent' } })
      expect(await job7).toEqual({ kind: 'absent' })
    },
    TIMEOUT
  )

  it(
    'a rejected reply rejects that job only and frees its worker',
    async () => {
      const { factory, channels } = fakeChannels()
      const pool = track(
        createHostThreadRecordModelPool({ entryPath: EXISTING_ENTRY, channel: factory, size: 2 })
      )
      const first = pool.model(input('t1'))
      const second = pool.model(input('t2'))
      channels[0]!.reply({
        id: lastRequest(channels[0]!).id,
        ok: false,
        error: { name: 'Error', message: 'modelling failed on the worker' }
      })
      await expect(first).rejects.toBeInstanceOf(HostThreadRecordTransferError)
      await expect(first).rejects.toThrow('modelling failed on the worker')
      expect(await settledWithin(second)).toBe('pending')
      // Worker 0 has nothing pending again; worker 1 still has one.
      const third = pool.model(input('t3'))
      expect(channels.map((channel) => channel.posted.length)).toEqual([2, 1])
      channels[1]!.reply({ id: lastRequest(channels[1]!).id, ok: true, value: { kind: 'absent' } })
      expect(await second).toEqual({ kind: 'absent' })
      channels[0]!.reply({ id: lastRequest(channels[0]!).id, ok: true, value: { kind: 'invalid' } })
      expect(await third).toEqual({ kind: 'invalid' })
    },
    TIMEOUT
  )

  it(
    'a worker that exits rejects its own jobs only, and its next job starts a fresh channel',
    async () => {
      const { factory, channels } = fakeChannels()
      const pool = track(
        createHostThreadRecordModelPool({ entryPath: EXISTING_ENTRY, channel: factory, size: 2 })
      )
      // t1 to worker 0, t2 to worker 1, t3 to the tie's lowest index: worker 0.
      const first = pool.model(input('t1'))
      const surviving = pool.model(input('t2'))
      const third = pool.model(input('t3'))
      const dying = [first, third]
      expect(channels.map((channel) => channel.posted.length)).toEqual([2, 1])
      expect(channels[0]!.posted.map((request) => threadIdOf(request))).toEqual(['t1', 't3'])
      channels[0]!.exit(7)
      const outcomes = await Promise.allSettled(dying)
      expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected'])
      for (const outcome of outcomes) {
        const reason = (outcome as PromiseRejectedResult).reason as HostThreadRecordTransferError
        expect(reason).toBeInstanceOf(HostThreadRecordTransferError)
        expect(String(reason.cause)).toContain('7')
      }
      expect(await settledWithin(surviving)).toBe('pending')
      // Worker 0 is idle again and lowest: it takes the next job on a new channel.
      const next = pool.model(input('t4'))
      expect(channels).toHaveLength(3)
      expect(channels[2]!.posted.map((request) => threadIdOf(request))).toEqual(['t4'])
      channels[2]!.reply({ id: lastRequest(channels[2]!).id, ok: true, value: { kind: 'absent' } })
      channels[1]!.reply({ id: lastRequest(channels[1]!).id, ok: true, value: { kind: 'invalid' } })
      expect(await next).toEqual({ kind: 'absent' })
      expect(await surviving).toEqual({ kind: 'invalid' })
    },
    TIMEOUT
  )

  it(
    'close waits for the jobs in flight, terminates every channel once, is idempotent, and refuses jobs after',
    async () => {
      const { factory, channels } = fakeChannels()
      const pool = track(
        createHostThreadRecordModelPool({ entryPath: EXISTING_ENTRY, channel: factory, size: 3 })
      )
      const first = pool.model(input('t1'))
      const second = pool.model(input('t2'))
      expect(channels).toHaveLength(2)
      const closing = pool.close()
      expect(pool.close()).toBe(closing)
      expect(await settledWithin(closing)).toBe('pending')
      expect(channels.map((channel) => channel.terminated)).toEqual([0, 0])

      channels[0]!.reply({ id: lastRequest(channels[0]!).id, ok: true, value: { kind: 'absent' } })
      expect(await settledWithin(closing)).toBe('pending')
      channels[1]!.reply({ id: lastRequest(channels[1]!).id, ok: true, value: { kind: 'absent' } })
      await closing
      expect(await Promise.all([first, second])).toEqual([{ kind: 'absent' }, { kind: 'absent' }])
      // The third worker never started a channel, so there is nothing to terminate for it.
      expect(channels.map((channel) => channel.terminated)).toEqual([1, 1])

      await expect(pool.model(input('t3'))).rejects.toThrow(/closed/)
      expect(channels).toHaveLength(2)
      expect(channels.map((channel) => channel.posted.length)).toEqual([1, 1])
      await pool.close()
      expect(channels.map((channel) => channel.terminated)).toEqual([1, 1])
    },
    TIMEOUT
  )

  it(
    'with nothing in flight, close resolves at once',
    async () => {
      const { factory, channels } = fakeChannels()
      const pool = track(
        createHostThreadRecordModelPool({ entryPath: EXISTING_ENTRY, channel: factory, size: 2 })
      )
      expect(await settledWithin(pool.close())).toBeUndefined()
      expect(channels).toEqual([])
    },
    TIMEOUT
  )

  it(
    'never the shared worker: without a channel option it builds its own private channels through the configured factory',
    async () => {
      const previous = hostThreadRecordTransferChannelFactory()
      const { factory, channels } = fakeChannels()
      configureHostThreadRecordTransferChannel(factory)
      try {
        const pool = track(createHostThreadRecordModelPool({ entryPath: EXISTING_ENTRY, size: 2 }))
        const jobs = [pool.model(input('t1')), pool.model(input('t2'))]
        // Two jobs, two private channels: the shared worker is one FIFO thread
        // and would have taken both on one channel.
        expect(channels).toHaveLength(2)
        expect(channels.map((channel) => channel.posted.length)).toEqual([1, 1])
        for (const channel of channels) {
          channel.reply({ id: lastRequest(channel).id, ok: true, value: { kind: 'absent' } })
        }
        await Promise.all(jobs)
        await pool.close()
        expect(channels.map((channel) => channel.terminated)).toEqual([1, 1])
        // Closing the pool retires only its own channels; the factory is untouched.
        expect(hostThreadRecordTransferChannelFactory()).toBe(factory)
      } finally {
        configureHostThreadRecordTransferChannel(previous)
        expect(hostThreadRecordTransferChannelFactory()).toBe(previous)
      }
    },
    TIMEOUT
  )

  it('compiled entry: models a real profile file on a real worker thread, absent for an unknown thread', async () => {
    const profilePath = mkdtempSync(join(directory, 'profile-'))
    const store = new HostProfileDomainStore({
      profilePath,
      authority: { assertProfileAuthority: () => undefined },
      now: () => NOW,
      idFactory: () => 'seeded-thread'
    })
    const created = store.createThread({ scope: 'global', title: 'Modelled on the pool' })
    store.configureThread({ threadId: created.appChatId, providerId: 'codex' })
    const revision = store.threadRecordState(created.appChatId)!.revision

    const pool = track(
      createHostThreadRecordModelPool({
        entryPath: compiledEntry,
        channel: createWorkerThreadTransferChannel,
        size: 2
      })
    )
    const [modelled, absent] = await Promise.all([
      pool.model({ profilePath, threadId: created.appChatId }),
      pool.model({ profilePath, threadId: 'nobody' })
    ])
    expect(modelled).toMatchObject({
      kind: 'modelled',
      revision,
      effects: { kind: 'modelled', threadId: created.appChatId }
    })
    expect(absent).toEqual({ kind: 'absent' })
    await pool.close()
    await expect(pool.model({ profilePath, threadId: created.appChatId })).rejects.toThrow(/closed/)
  }, 30_000)
})
