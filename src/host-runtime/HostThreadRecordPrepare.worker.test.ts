/**
 * Independent Threads M4 slice 11, contract §20.2 / §20.3 item 5: the transfer
 * worker's `prepare` request through a compiled entry. Prepare ALWAYS runs on
 * the worker: no synchronous fallback on saturation, dispatch failure, a
 * closed worker or a worker exit, and no fallback for the off-loop helper
 * when no compiled entry exists. A prepare in flight never counts toward the
 * bound that pushes a publish or read onto the synchronous path.
 */
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  hostThreadRecordNormalizedTransferId,
  prepareHostThreadRecord,
  type HostThreadRecordPrepared,
  type HostThreadRecordPrepareInput,
  type HostThreadRecordPrepareResult
} from './HostThreadRecordPrepare'
import {
  HostThreadRecordTransferError,
  hostThreadRecordTransferPath,
  publishHostThreadRecordTransfer,
  type HostThreadRecordTransferDescriptor
} from './HostThreadRecordTransfer'
import {
  handleHostThreadRecordTransferRequest,
  HostThreadRecordTransferWorker,
  prepareHostThreadRecordOffLoop,
  type HostThreadRecordTransferChannelFactory,
  type HostThreadRecordTransferWorkerReply,
  type HostThreadRecordTransferWorkerRequest
} from './HostThreadRecordTransferWorker'

const NOW = 1_760_000_000_000
const THREAD_ID = 'thread-1'
const POSIX = process.platform !== 'win32'

let directory: string
let entryPath: string
const workers: HostThreadRecordTransferWorker[] = []

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'thread-record-prepare-worker-'))
  entryPath = join(directory, 'HostThreadRecordTransferWorkerEntry.cjs')
  await build({
    entryPoints: ['src/host-runtime/HostThreadRecordTransferWorkerEntry.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: entryPath,
    logLevel: 'silent'
  })
})

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.close()))
})
afterAll(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

function fixture(workerEntry = entryPath, channel?: HostThreadRecordTransferChannelFactory) {
  const profilePath = mkdtempSync(join(directory, 'profile-'))
  const worker = channel
    ? new HostThreadRecordTransferWorker(workerEntry, channel)
    : new HostThreadRecordTransferWorker(workerEntry)
  workers.push(worker)
  return { profilePath, worker }
}

function record(title = 'Prepared on the worker'): Record<string, unknown> {
  return {
    appChatId: THREAD_ID,
    scope: 'global',
    title,
    archived: false,
    createdAt: 10,
    messages: [
      { id: 'm1', role: 'user', content: 'hello there', timestamp: '2026-09-01T00:00:00.000Z' }
    ],
    runs: [],
    updatedAt: 20
  }
}

interface Artifact {
  readonly input: HostThreadRecordPrepareInput
  readonly descriptor: HostThreadRecordTransferDescriptor
  readonly path: string
  readonly normalizedPath: string
  readonly bytes: Buffer
}

/** Publishes an artifact that prepares as a normalized new thread (revision 0). */
function artifact(profilePath: string, transferId: string, title?: string): Artifact {
  const descriptor = publishHostThreadRecordTransfer({
    profilePath,
    transferId,
    record: record(title)
  })
  const path = hostThreadRecordTransferPath(profilePath, transferId)
  return {
    input: {
      profilePath,
      threadId: THREAD_ID,
      descriptor,
      expectedRevision: 0,
      currentRevision: null,
      now: NOW
    },
    descriptor,
    path,
    normalizedPath: hostThreadRecordTransferPath(
      profilePath,
      hostThreadRecordNormalizedTransferId(transferId)
    ),
    bytes: readFileSync(path)
  }
}

/** The artifact is exactly as published: nobody verified-and-consumed or normalized it. */
function expectUntouched(item: Artifact): void {
  expect(existsSync(item.path)).toBe(true)
  expect(readFileSync(item.path).equals(item.bytes)).toBe(true)
  expect(existsSync(item.normalizedPath)).toBe(false)
}

function stripLocation(result: HostThreadRecordPrepared): Omit<
  HostThreadRecordPrepared,
  'artifact'
> & {
  artifact: Omit<HostThreadRecordPrepared['artifact'], 'path' | 'identity'>
} {
  const { path: _path, identity: _identity, ...artifactRest } = result.artifact
  return { ...result, artifact: artifactRest }
}

/** An in-process channel that records requests and replies only when told to. */
function scriptedChannel() {
  const posted: HostThreadRecordTransferWorkerRequest[] = []
  let deliver: ((reply: HostThreadRecordTransferWorkerReply) => void) | undefined
  const factory: HostThreadRecordTransferChannelFactory = () => ({
    kind: 'worker-thread',
    post: (message) => {
      posted.push(message)
    },
    onMessage: (listener) => {
      deliver = listener
    },
    onError: () => undefined,
    onExit: () => undefined,
    ref: () => undefined,
    unref: () => undefined,
    terminate: async () => undefined
  })
  return {
    factory,
    posted,
    reply: (reply: HostThreadRecordTransferWorkerReply) => {
      deliver!(reply)
    }
  }
}

async function settled(promise: Promise<unknown>): Promise<boolean> {
  const sentinel = Symbol('pending')
  const outcome = await Promise.race([
    promise.then(
      () => 'settled',
      () => 'settled'
    ),
    new Promise((resolve) => setTimeout(() => resolve(sentinel), 20))
  ])
  return outcome !== sentinel
}

describe('compiled thread-record transfer worker: prepare', () => {
  it('round-trips a prepared descriptor equal to the in-process prepare, and the artifact bytes', async () => {
    const { profilePath, worker } = fixture()
    const remote = artifact(profilePath, 'round-trip')
    const result = await worker.prepare(remote.input)
    expect(result.kind).toBe('prepared')
    const prepared = result as HostThreadRecordPrepared

    const inlineProfile = mkdtempSync(join(directory, 'profile-inline-'))
    const inline = prepareHostThreadRecord(artifact(inlineProfile, 'round-trip').input)
    expect(inline.kind).toBe('prepared')
    expect(stripLocation(prepared)).toEqual(stripLocation(inline as HostThreadRecordPrepared))
    expect(prepared.artifact).toMatchObject({
      source: 'normalized',
      byteLength: expect.any(Number)
    })
    expect(prepared.artifact.path).toBe(remote.normalizedPath)
    expect(
      readFileSync(prepared.artifact.path).equals(
        readFileSync((inline as HostThreadRecordPrepared).artifact.path)
      )
    ).toBe(true)
    const stat = lstatSync(prepared.artifact.path, { bigint: true })
    expect(prepared.artifact.identity).toEqual({ dev: String(stat.dev), ino: String(stat.ino) })
    if (POSIX) expect(Number(stat.mode) & 0o777).toBe(0o600)
    expect(existsSync(remote.path)).toBe(false)
    expect(prepared.summary).not.toBeNull()
    expect(prepared.effects.kind).toBe('modelled')
    expect(JSON.stringify(prepared)).not.toContain('"messages"')

    // A rejection round-trips as a value, not as a thrown transfer error.
    const missing = await worker.prepare({
      ...remote.input,
      descriptor: { ...remote.descriptor, transferId: 'absent' }
    })
    expect(missing).toMatchObject({
      kind: 'rejected',
      errorCode: 'thread_record_transfer_missing'
    })
  })

  it('the entry dispatches the prepare request kind to prepareHostThreadRecord', () => {
    const profilePath = mkdtempSync(join(directory, 'profile-'))
    const item = artifact(profilePath, 'in-process')
    const reply = handleHostThreadRecordTransferRequest({
      id: 3,
      kind: 'prepare',
      input: item.input
    })
    expect(reply).toMatchObject({
      id: 3,
      ok: true,
      value: { kind: 'prepared', threadId: THREAD_ID }
    })
    expect(existsSync(item.normalizedPath)).toBe(true)
    expect(existsSync(item.path)).toBe(false)
  })

  it('five prepares in flight do not push a publish onto the synchronous path', async () => {
    const kindsPath = join(directory, 'kinds.txt')
    const wrapper = join(directory, 'kinds-worker.cjs')
    writeFileSync(
      wrapper,
      `require('node:worker_threads').parentPort.on('message', (message) => require('node:fs').appendFileSync(${JSON.stringify(kindsPath)}, message.kind + '\\n')); require(${JSON.stringify(entryPath)})`
    )
    const { profilePath, worker } = fixture(wrapper)
    const items = Array.from({ length: 5 }, (_, index) =>
      artifact(profilePath, `in-flight-${index}`)
    )
    const prepares = items.map((item) => worker.prepare(item.input))
    const published = worker.publish({
      profilePath,
      transferId: 'after-five-prepares',
      record: { captured: true }
    })
    const [descriptor, ...results] = await Promise.all([published, ...prepares])
    await worker.close()

    // Every job reached the worker, in order; the synchronous publisher posts nothing.
    const kinds = readFileSync(kindsPath, 'utf8').trim().split('\n')
    expect(kinds).toEqual(['prepare', 'prepare', 'prepare', 'prepare', 'prepare', 'publish'])
    expect(results).toHaveLength(5)
    for (const result of results) expect(result.kind).toBe('prepared')
    expect(
      readFileSync(hostThreadRecordTransferPath(profilePath, descriptor.transferId), 'utf8')
    ).toBe('{"captured":true}\n')
  })

  it('never prepares inline under saturation, while a saturated publish still captures synchronously', async () => {
    const scripted = scriptedChannel()
    const { profilePath, worker } = fixture(entryPath, scripted.factory)
    const publishes = Array.from({ length: 4 }, (_, index) =>
      worker.publish({ profilePath, transferId: `fill-${index}`, record: { index } })
    )
    const items = Array.from({ length: 3 }, (_, index) =>
      artifact(profilePath, `saturated-${index}`)
    )
    const prepares = items.map((item) => worker.prepare(item.input))

    expect(scripted.posted.map((request) => request.kind)).toEqual([
      'publish',
      'publish',
      'publish',
      'publish',
      'prepare',
      'prepare',
      'prepare'
    ])
    for (const item of items) expectUntouched(item)
    expect(await Promise.all(prepares.map(settled))).toEqual([false, false, false])

    // Negative control: the record-job bound is unchanged for publishes, which
    // still capture synchronously when four are pending.
    const fifth = worker.publish({ profilePath, transferId: 'fifth', record: { fifth: true } })
    expect(readFileSync(hostThreadRecordTransferPath(profilePath, 'fifth'), 'utf8')).toBe(
      '{"fifth":true}\n'
    )
    expect(scripted.posted).toHaveLength(7)
    await fifth

    const dummy: HostThreadRecordPrepareResult = {
      kind: 'rejected',
      threadId: THREAD_ID,
      errorCode: 'thread_record_transfer_missing'
    } as HostThreadRecordPrepareResult
    for (const request of scripted.posted) {
      scripted.reply({
        id: request.id,
        ok: true,
        value:
          request.kind === 'publish'
            ? { transferId: request.input.transferId, sha256: 'scripted', byteLength: 1 }
            : dummy
      })
    }
    expect(await Promise.all(prepares)).toEqual([dummy, dummy, dummy])
    await Promise.all(publishes)
    for (const item of items) expectUntouched(item)
  })

  it('a closed worker rejects prepare and leaves the artifact alone', async () => {
    const { profilePath, worker } = fixture()
    const item = artifact(profilePath, 'closed')
    await worker.close()
    const pending = worker.prepare(item.input)
    await expect(pending).rejects.toBeInstanceOf(HostThreadRecordTransferError)
    await expect(pending).rejects.toThrow('closed')
    expectUntouched(item)
  })

  it('a transport that refuses or cannot start rejects prepare and never prepares inline', async () => {
    const refusing: HostThreadRecordTransferChannelFactory = () => ({
      kind: 'utility-process',
      post: () => {
        throw new Error('message too large for the channel')
      },
      onMessage: () => undefined,
      onError: () => undefined,
      onExit: () => undefined,
      ref: () => undefined,
      unref: () => undefined,
      terminate: async () => undefined
    })
    const refused = fixture(entryPath, refusing)
    const refusedItem = artifact(refused.profilePath, 'refused')
    const refusedPending = refused.worker.prepare(refusedItem.input)
    expect(refusedPending).toBeInstanceOf(Promise)
    await expect(refusedPending).rejects.toBeInstanceOf(HostThreadRecordTransferError)
    await expect(refusedPending).rejects.toThrow('could not be dispatched')
    expectUntouched(refusedItem)

    const unstartable = fixture(entryPath, () => {
      throw new Error('spawn failed')
    })
    const unstartableItem = artifact(unstartable.profilePath, 'unstartable')
    const unstartablePending = unstartable.worker.prepare(unstartableItem.input)
    expect(unstartablePending).toBeInstanceOf(Promise)
    await expect(unstartablePending).rejects.toBeInstanceOf(HostThreadRecordTransferError)
    expectUntouched(unstartableItem)
  })

  it('a worker that exits mid-prepare rejects, leaves the artifact, and a later prepare starts fresh', async () => {
    const wrapper = join(directory, 'crashing-prepare-worker.cjs')
    writeFileSync(wrapper, 'process.exit(7)')
    const { profilePath, worker } = fixture(wrapper)
    const first = artifact(profilePath, 'crashed-first')
    const second = artifact(profilePath, 'crashed-second')
    const outcomes = await Promise.allSettled([
      worker.prepare(first.input),
      worker.prepare(second.input)
    ])
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected'])
    for (const outcome of outcomes) {
      const reason = (outcome as PromiseRejectedResult).reason as HostThreadRecordTransferError
      expect(reason).toBeInstanceOf(HostThreadRecordTransferError)
      expect(String(reason.cause)).toContain('7')
    }
    expectUntouched(first)
    expectUntouched(second)

    writeFileSync(wrapper, `require(${JSON.stringify(entryPath)})`)
    const recovered = await worker.prepare(first.input)
    expect(recovered).toMatchObject({ kind: 'prepared', artifact: { source: 'normalized' } })
    expect(existsSync(first.normalizedPath)).toBe(true)
    expect(existsSync(first.path)).toBe(false)
    expectUntouched(second)
  })

  it('prepareHostThreadRecordOffLoop rejects with no compiled entry and never prepares inline', async () => {
    // The shared worker looks for the sibling of the worker module; in the
    // source tree no compiled entry exists, which is the case under test.
    expect(existsSync(join(__dirname, 'HostThreadRecordTransferWorkerEntry.js'))).toBe(false)
    const profilePath = mkdtempSync(join(directory, 'profile-'))
    const item = artifact(profilePath, 'off-loop')
    const pending = prepareHostThreadRecordOffLoop(item.input)
    expect(pending).toBeInstanceOf(Promise)
    await expect(pending).rejects.toBeInstanceOf(HostThreadRecordTransferError)
    expectUntouched(item)
  })
})
