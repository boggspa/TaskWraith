import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  HostThreadRecordTransferIntegrityError,
  HostThreadRecordTransferMissingError,
  hostThreadRecordTransferPath,
  publishHostThreadRecordTransfer,
  removeHostThreadRecordTransfer
} from './HostThreadRecordTransfer'
import { HostThreadRecordTransferWorker } from './HostThreadRecordTransferWorker'
import { HostProfileDomainStore } from './HostProfileDomainStore'
import { HostProfileRecordCommandExecutor } from './HostProfileRecordCommandExecutor'
import {
  HOST_PROTOCOL_VERSION,
  TASKWRAITH_DESKTOP_HOST_ACTOR,
  type HostCommand
} from '../shared/hostProtocol'

let directory: string
let entryPath: string
const workers: HostThreadRecordTransferWorker[] = []

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'checkpoint-worker-'))
  entryPath = join(directory, 'HostThreadRecordTransferWorkerEntry.cjs')
  await build({
    entryPoints: ['src/host-runtime/HostThreadRecordTransferWorkerEntry.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: entryPath,
    logLevel: 'silent'
  })
})

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.close()))
})
afterAll(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

function fixture(workerEntry = entryPath) {
  const profilePath = mkdtempSync(join(directory, 'profile-'))
  const worker = new HostThreadRecordTransferWorker(workerEntry)
  workers.push(worker)
  return { profilePath, worker }
}

function persistCommand(
  descriptor: { transferId: string; sha256: string; byteLength: number },
  expectedRevision: number
): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: '11111111-1111-4111-8111-111111111111',
    idempotencyKey: `persist:${descriptor.transferId}`,
    actor: { ...TASKWRAITH_DESKTOP_HOST_ACTOR },
    name: 'thread.record.persist',
    target: { threadId: 'thread-1' },
    arguments: { ...descriptor, expectedRevision },
    issuedAt: '2026-09-20T00:00:00.000Z'
  }
}

describe('compiled thread-record transfer worker', () => {
  it('captures at dispatch, produces canonical bytes and returns the full decoded record', async () => {
    const { profilePath, worker } = fixture()
    const record = {
      appChatId: 'thread-1',
      optional: undefined,
      messages: [{ content: 'Unicode 🎉\ntext', value: NaN, nested: [null, undefined, -0] }]
    }
    const expected = Buffer.from(`${JSON.stringify(record)}\n`)
    const unrelatedSmallBuffer = Buffer.from('keep the shared Buffer pool intact')
    const pending = worker.publish({ profilePath, transferId: 'canonical', record })
    record.messages[0].content = 'caller changed after dispatch'
    const descriptor = await pending
    const syncDescriptor = publishHostThreadRecordTransfer({
      profilePath,
      transferId: 'sync',
      record: JSON.parse(expected.toString())
    })
    expect(readFileSync(hostThreadRecordTransferPath(profilePath, descriptor.transferId))).toEqual(
      expected
    )
    expect(descriptor.sha256).toBe(syncDescriptor.sha256)
    expect(descriptor.byteLength).toBe(expected.byteLength)
    expect(unrelatedSmallBuffer.toString()).toBe('keep the shared Buffer pool intact')
    const decoded = await worker.read({ profilePath, descriptor })
    expect(decoded.record).toEqual(JSON.parse(expected.toString()))
    expect(decoded).not.toHaveProperty('body')
    expect(decoded.identity.dev).toEqual(expect.any(String))
  })

  it('preserves canonical JSON for Buffers, custom toJSON and accessors', async () => {
    const { profilePath, worker } = fixture()
    let getterCalls = 0
    const record = {
      bytes: Buffer.from([0, 127, 255]),
      custom: { toJSON: () => ({ serialized: true }) },
      get content() {
        getterCalls++
        return 'read once'
      }
    }
    const descriptor = await worker.publish({ profilePath, transferId: 'exotic', record })
    expect(getterCalls).toBe(1)
    expect(readFileSync(hostThreadRecordTransferPath(profilePath, 'exotic'), 'utf8')).toBe(
      '{"bytes":{"type":"Buffer","data":[0,127,255]},"custom":{"serialized":true},"content":"read once"}\n'
    )
    expect((await worker.read({ profilePath, descriptor })).record).toEqual({
      bytes: { type: 'Buffer', data: [0, 127, 255] },
      custom: { serialized: true },
      content: 'read once'
    })
  })

  it('reuses one worker and close waits for all durable publications', async () => {
    const startsPath = join(directory, 'starts.txt')
    const wrapper = join(directory, 'counted-worker.cjs')
    writeFileSync(
      wrapper,
      `require('node:fs').appendFileSync(${JSON.stringify(startsPath)}, 'start\\n'); require(${JSON.stringify(entryPath)})`
    )
    const { profilePath, worker } = fixture(wrapper)
    const pending = Array.from({ length: 4 }, (_, index) =>
      worker.publish({
        profilePath,
        transferId: `queued-${index}`,
        record: { index, text: 'x'.repeat(50_000) }
      })
    )
    await worker.close()
    const descriptors = await Promise.all(pending)
    expect(readFileSync(startsPath, 'utf8')).toBe('start\n')
    for (const [index, descriptor] of descriptors.entries()) {
      expect(
        JSON.parse(
          readFileSync(hostThreadRecordTransferPath(profilePath, descriptor.transferId), 'utf8')
        ).index
      ).toBe(index)
    }
    await expect(worker.publish({ profilePath, transferId: 'closed', record: {} })).rejects.toThrow(
      'closed'
    )
  })

  it('bounds cloned submissions while saturated calls still capture and persist immediately', async () => {
    const requestsPath = join(directory, 'bounded-requests.txt')
    const wrapper = join(directory, 'bounded-worker.cjs')
    writeFileSync(
      wrapper,
      `require('node:worker_threads').parentPort.on('message', () => require('node:fs').appendFileSync(${JSON.stringify(requestsPath)}, 'job\\n')); require(${JSON.stringify(entryPath)})`
    )
    const { profilePath, worker } = fixture(wrapper)
    const records = Array.from({ length: 6 }, (_, index) => ({ index, content: 'captured' }))
    const pending = records.map((record, index) =>
      worker.publish({ profilePath, transferId: `bounded-${index}`, record })
    )
    for (const record of records) record.content = 'later mutation'
    expect(existsSync(hostThreadRecordTransferPath(profilePath, 'bounded-5'))).toBe(true)
    const descriptors = await Promise.all(pending)
    await worker.close()
    expect(readFileSync(requestsPath, 'utf8').trim().split('\n')).toHaveLength(4)
    for (const descriptor of descriptors) {
      expect(
        JSON.parse(
          readFileSync(hostThreadRecordTransferPath(profilePath, descriptor.transferId), 'utf8')
        ).content
      ).toBe('captured')
    }
  })

  it('preserves typed missing, digest and JSON integrity failures', async () => {
    const { profilePath, worker } = fixture()
    const descriptor = await worker.publish({ profilePath, transferId: 'bad-digest', record: {} })
    await expect(
      worker.read({ profilePath, descriptor: { ...descriptor, sha256: 'f'.repeat(64) } })
    ).rejects.toBeInstanceOf(HostThreadRecordTransferIntegrityError)
    expect(existsSync(hostThreadRecordTransferPath(profilePath, descriptor.transferId))).toBe(false)
    await expect(worker.read({ profilePath, descriptor })).rejects.toBeInstanceOf(
      HostThreadRecordTransferMissingError
    )
    const body = Buffer.from('{bad json}\n')
    const transferId = 'bad-json'
    writeFileSync(hostThreadRecordTransferPath(profilePath, transferId), body, { mode: 0o600 })
    await expect(
      worker.read({
        profilePath,
        descriptor: {
          transferId,
          byteLength: body.length,
          sha256: createHash('sha256').update(body).digest('hex')
        }
      })
    ).rejects.toBeInstanceOf(HostThreadRecordTransferIntegrityError)
    expect(existsSync(hostThreadRecordTransferPath(profilePath, transferId))).toBe(false)
  })

  it('fails outstanding jobs on worker exit and a later call starts a fresh worker', async () => {
    const wrapper = join(directory, 'crashing-worker.cjs')
    writeFileSync(wrapper, 'process.exit(7)')
    const { profilePath, worker } = fixture(wrapper)
    const failed = await Promise.allSettled([
      worker.publish({ profilePath, transferId: 'first', record: {} }),
      worker.publish({ profilePath, transferId: 'second', record: {} })
    ])
    expect(failed.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    writeFileSync(wrapper, `require(${JSON.stringify(entryPath)})`)
    const descriptor = await worker.publish({
      profilePath,
      transferId: 'recovered',
      record: { recovered: true }
    })
    expect((await worker.read({ profilePath, descriptor })).record).toEqual({ recovered: true })
  })

  it('allows main-loop work during a large warm-worker checkpoint', async () => {
    const { profilePath, worker } = fixture()
    await worker.publish({ profilePath, transferId: 'warm', record: {} })
    const record = {
      messages: Array.from({ length: 1_500 }, (_, index) => ({
        index,
        content: 'x'.repeat(16_000)
      }))
    }
    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
    }, 1)
    try {
      const descriptor = await worker.publish({ profilePath, transferId: 'large', record })
      expect(descriptor.byteLength).toBeGreaterThan(24_000_000)
      expect(ticks).toBeGreaterThan(0)
      ticks = 0
      const decoded = await worker.read({ profilePath, descriptor })
      expect((decoded.record.messages as unknown[]).length).toBe(1_500)
      expect(ticks).toBeGreaterThan(0)
    } finally {
      clearInterval(timer)
    }
  })

  it('keeps full Host validation, CAS and inode-bound adoption after worker verification', async () => {
    const { profilePath, worker } = fixture()
    const store = new HostProfileDomainStore({
      profilePath,
      authority: { assertProfileAuthority() {} },
      now: () => 10
    })
    const initial = {
      appChatId: 'thread-1',
      scope: 'global',
      title: 'Initial',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      runs: [],
      messages: []
    }
    store.persistThreadRecord({ threadId: 'thread-1', record: initial, expectedRevision: 0 })
    const executor = new HostProfileRecordCommandExecutor({
      profilePath,
      store,
      readTransfer: (input) => worker.read(input)
    })
    const record = { ...initial, title: 'Updated', persistenceRevision: 1 }
    const descriptor = await worker.publish({ profilePath, transferId: 'adopted', record })
    expect(await executor.execute(persistCommand(descriptor, 0))).toEqual({
      status: 'succeeded',
      resultSummary: 'thread_record_persisted'
    })
    expect(readFileSync(join(profilePath, 'chats', 'thread-1.json'), 'utf8')).toBe(
      `${JSON.stringify(record)}\n`
    )
    const stale = await worker.publish({ profilePath, transferId: 'stale', record })
    expect(await executor.execute(persistCommand(stale, 0))).toMatchObject({
      errorCode: 'thread_record_revision_conflict'
    })
    const invalid = await worker.publish({
      profilePath,
      transferId: 'invalid',
      record: { ...record, messages: 'invalid' }
    })
    expect(await executor.execute(persistCommand(invalid, 1))).toMatchObject({
      errorCode: 'thread_record_invalid'
    })

    const replace = await worker.publish({
      profilePath,
      transferId: 'replace',
      record: { ...record, persistenceRevision: 2 }
    })
    const verified = await worker.read({ profilePath, descriptor: replace })
    const replacement = `${verified.path}.replacement`
    writeFileSync(replacement, 'foreign bytes', { mode: 0o600 })
    renameSync(replacement, verified.path)
    const racingExecutor = new HostProfileRecordCommandExecutor({
      profilePath,
      store,
      readTransfer: async () => verified
    })
    expect(await racingExecutor.execute(persistCommand(replace, 1))).toMatchObject({
      errorCode: 'thread_record_persist_failed'
    })
    expect(
      removeHostThreadRecordTransfer({
        profilePath,
        transferId: replace.transferId,
        expectedIdentity: verified.identity
      })
    ).toBe(false)
    expect(readFileSync(verified.path, 'utf8')).toBe('foreign bytes')
    expect(store.getThread('thread-1')?.persistenceRevision).toBe(1)
  })
})
