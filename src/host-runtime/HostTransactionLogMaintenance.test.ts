import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HOST_TRANSACTION_LOG_FILENAME, HostTransactionLog } from './HostTransactionLog'
import { HostTransactionLogMaintenance } from './HostTransactionLogMaintenance'
import type {
  HostTransactionPrepareRecord,
  HostTransactionRecoveryInput
} from './HostTransactionManifest'

type Receipt = HostTransactionRecoveryInput['receipt']
const dirs: string[] = []
const workers: HostTransactionLogMaintenance[] = []
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-maintenance-'))
  dirs.push(dir)
  return dir
}
function prepare(commandId: string): HostTransactionPrepareRecord {
  return {
    kind: 'prepare',
    commandId,
    threadId: `thread-${commandId}`,
    epoch: { hostIncarnation: 'a'.repeat(64), deleteCounter: 0 },
    expectedRevision: 0,
    resultingRevision: 1,
    prior: null,
    resulting: { dev: '1', ino: '2', size: 10 },
    effects: { count: 1, setDigest: 'b'.repeat(64) },
    preparedAt: 1
  }
}
function receipt(status: NonNullable<Receipt>['status']): Receipt {
  return { status, recoveryState: null, commandClass: 'txn-record-persist' }
}
async function finished(log: HostTransactionLog, id: string): Promise<void> {
  await log.append(prepare(id))
  await log.append({
    kind: 'published',
    commandId: id,
    position: { generation: 1, cursor: 1 },
    at: 2
  })
}
async function until(condition: () => boolean): Promise<void> {
  const end = Date.now() + 2000
  while (!condition()) {
    if (Date.now() > end) throw new Error('maintenance did not drain')
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}
function worker(
  log: HostTransactionLog,
  receipts: () => ReadonlyMap<string, Receipt>,
  intervalMs = 30000
) {
  const result = new HostTransactionLogMaintenance({
    log,
    receipts,
    recordThreshold: 4,
    intervalMs
  })
  workers.push(result)
  return result
}

describe('production transaction log maintenance', () => {
  it('keeps the manifest when receipt sampling fails, then retries with fresh evidence', async () => {
    const log = HostTransactionLog.open({ dataDir: directory() })
    await finished(log, 'one')
    let unavailable = true
    const maintenance = worker(log, () => {
      if (unavailable) throw new Error('receipt snapshot unavailable')
      return new Map()
    })
    expect(await maintenance.sweep()).toMatchObject({ kind: 'failed' })
    expect(log.get('one')?.prepare).not.toBeNull()
    expect(log.getFailure()).toBeNull()
    unavailable = false
    expect(await maintenance.sweep()).toMatchObject({ kind: 'compacted', dropped: 1 })
  })

  it('automatically bounds repeated completed writes while preserving recovery anchors on reopen', async () => {
    const dir = directory()
    const log = HostTransactionLog.open({ dataDir: dir })
    const receipts = new Map<string, Receipt>([
      ['pending', receipt('pending')],
      ['unknown', receipt('indeterminate')]
    ])
    await log.append(prepare('pending'))
    await log.append(prepare('unknown'))
    await log.append({
      kind: 'indeterminate',
      commandId: 'unknown',
      reason: 'unknown_identity',
      at: 2
    })
    const maintenance = worker(log, () => new Map(receipts))
    maintenance.start()
    await maintenance.sweep()
    for (let n = 0; n < 30; n++) {
      const id = `finished-${n}`
      receipts.set(id, receipt('pending'))
      await finished(log, id)
      receipts.set(id, receipt('succeeded'))
    }
    await until(() => !maintenance.snapshot().running)
    // No manual compaction: append pressure bounds settled history to a small tail.
    expect(log.stats().commands).toBeLessThanOrEqual(6)
    await maintenance.sweep()
    expect(HostTransactionLog.open({ dataDir: dir }).commandIds()).toEqual(['pending', 'unknown'])
    expect(
      readFileSync(join(dir, HOST_TRANSACTION_LOG_FILENAME), 'utf8').split('\n').filter(Boolean)
    ).toHaveLength(3)
    expect(maintenance.snapshot().last).toMatchObject({ kept: 2, keptIndeterminate: 1 })
  })

  it('periodically retires receipts that settle after the last append and stops on close', async () => {
    const log = HostTransactionLog.open({ dataDir: directory() })
    let status: NonNullable<Receipt>['status'] = 'pending'
    await finished(log, 'one')
    const maintenance = worker(log, () => new Map([['one', receipt(status)]]), 10)
    maintenance.start()
    await maintenance.sweep()
    expect(log.get('one')).not.toBeNull()
    status = 'succeeded'
    await until(() => log.get('one') === null)
    await maintenance.close()
    await finished(log, 'after-close')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(log.get('after-close')).not.toBeNull()
  })

  it('coalesces sweeps, preserves concurrent appends and drains an active rewrite on close', async () => {
    const dir = directory()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let rewriting = false
    const log = HostTransactionLog.open({
      dataDir: dir,
      write: async (path, data) => {
        if (path.endsWith('.tmp')) {
          rewriting = true
          await held
        }
        await appendFile(path, data)
      }
    })
    await finished(log, 'old')
    const maintenance = worker(log, () => new Map([['during', receipt('pending')]]))
    maintenance.start()
    const first = maintenance.sweep()
    await until(() => rewriting)
    for (let n = 0; n < 100; n++) expect(maintenance.sweep()).toBe(first)
    const during = log.append(prepare('during'))
    let closed = false
    const closing = maintenance.close().then(() => {
      closed = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(closed).toBe(false)
    release()
    await first
    await during
    await closing
    expect(HostTransactionLog.open({ dataDir: dir }).commandIds()).toEqual(['during'])
  })

  it('retries pre-rename maintenance failure without poisoning durable appends', async () => {
    const dir = directory()
    let fail = true
    const log = HostTransactionLog.open({
      dataDir: dir,
      write: async (path, data) => {
        if (path.endsWith('.tmp') && fail) throw new Error('maintenance disk failure')
        await appendFile(path, data)
      }
    })
    await finished(log, 'old')
    const maintenance = worker(log, () => new Map())
    maintenance.start()
    expect(await maintenance.sweep()).toMatchObject({
      kind: 'failed',
      detail: 'maintenance disk failure'
    })
    expect(log.getFailure()).toBeNull()
    expect(await log.append(prepare('new'))).toEqual({ kind: 'durable' })
    fail = false
    expect(await maintenance.sweep()).toMatchObject({ kind: 'compacted', dropped: 2 })
  })

  it('samples receipts inside the serialized I/O turn and retains recoverable indeterminate', async () => {
    const log = HostTransactionLog.open({ dataDir: directory() })
    await finished(log, 'one')
    const receipts = vi.fn(
      () =>
        new Map<string, Receipt>([
          [
            'one',
            {
              status: 'indeterminate',
              recoveryState: 'recoverable-indeterminate',
              commandClass: 'txn-record-persist'
            }
          ]
        ])
    )
    const maintenance = worker(log, receipts)
    const sweep = maintenance.sweep()
    expect(receipts).not.toHaveBeenCalled()
    expect(await sweep).toMatchObject({ kept: 1, dropped: 0 })
    expect(receipts).toHaveBeenCalledTimes(1)
  })
})
