import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createHostStandaloneComposition } from './HostStandaloneComposition'
import { HostRuntimeBootstrap } from './HostRuntimeBootstrap'
import { HostTransactionLog } from './HostTransactionLog'
import { HOST_TRANSACTION_LOG_COMPACT_RECORDS } from './HostTransactionLogMaintenance'
import type { HostTransactionPrepareRecord } from './HostTransactionManifest'

function prepare(commandId: string): HostTransactionPrepareRecord {
  return {
    kind: 'prepare',
    commandId,
    threadId: 'thread-' + commandId,
    epoch: { hostIncarnation: 'a'.repeat(64), deleteCounter: 0 },
    expectedRevision: 0,
    resultingRevision: 1,
    prior: null,
    resulting: { dev: '1', ino: '2', size: 10 },
    effects: { count: 1, setDigest: 'b'.repeat(64) },
    preparedAt: 1
  }
}
async function finished(log: HostTransactionLog, id: string): Promise<void> {
  expect(await log.append(prepare(id))).toEqual({ kind: 'durable' })
  expect(
    await log.append({
      kind: 'published',
      commandId: id,
      position: { generation: 1, cursor: 1 },
      at: 2
    })
  ).toEqual({ kind: 'durable' })
}

describe('composition production transaction manifest maintenance', () => {
  it('starts after flag-off recovery, bounds settled history and drains/unsubscribes before shutdown flush', async () => {
    const profilePath = mkdtempSync(join(tmpdir(), 'composition-maintenance-'))
    const runtimePath = join(profilePath, 'host-data')
    mkdirSync(runtimePath)
    const historical = HostTransactionLog.open({ dataDir: runtimePath })
    await finished(historical, 'historical')
    const original = HostTransactionLog.prototype.compact
    const flush = vi.spyOn(HostRuntimeBootstrap.prototype, 'flush')
    let live: HostTransactionLog | undefined
    let hold: Promise<void> | undefined
    let release: (() => void) | undefined
    let unsubscribeCalled = false
    const subscribe = HostTransactionLog.prototype.subscribeDurableAppends
    const subscription = vi
      .spyOn(HostTransactionLog.prototype, 'subscribeDurableAppends')
      .mockImplementation(function (this: HostTransactionLog, listener) {
        const unsubscribe = subscribe.call(this, listener)
        return () => {
          unsubscribeCalled = true
          unsubscribe()
        }
      })
    const compact = vi
      .spyOn(HostTransactionLog.prototype, 'compact')
      .mockImplementation(async function (this: HostTransactionLog, receipts) {
        live = this
        if (hold) await hold
        return original.call(this, receipts)
      })
    const composition = createHostStandaloneComposition({
      runtimePath,
      profilePath,
      lease: { assertHeld: () => undefined },
      host: { hostId: 'metrics-host', hostVersion: '1' },
      hostCapabilityOffer: ['bootstrap', 'snapshot', 'deltas', 'commands', 'receipts', 'health'],
      bootEpochFactory: () => 'a'.repeat(64),
      snapshotDonor: () => ({
        health: { hostStatus: 'ok', connectionPhase: 'live', supervised: false, freshness: 'live' },
        workspaces: [],
        threads: [],
        runs: [],
        missions: [],
        rounds: [],
        participants: [],
        providers: [],
        questions: [],
        approvals: [],
        schedules: [],
        usage: { availability: 'unavailable' },
        artifacts: [],
        warnings: []
      }),
      authorityEvaluator: () => ({ decision: 'allowed' }),
      commandExecutor: () => ({ status: 'succeeded' }),
      healthProvider: () => ({
        hostStatus: 'ok',
        connectionPhase: 'live',
        supervised: false,
        freshness: 'live'
      })
    })
    try {
      expect(compact).not.toHaveBeenCalled()
      expect(composition.markThreadRecord).toBeUndefined()
      expect(composition.perf.snapshot().sections.transactionLog).toEqual({ available: false })
      await composition.recoverTransactions()
      await vi.waitFor(() => expect(live?.commandIds()).toEqual([]))
      expect(subscription).toHaveBeenCalledTimes(1)
      expect(compact).toHaveBeenCalledTimes(1)
      const log = live!
      // An unfinished prepare without a terminal is a durable recovery anchor.
      await log.append(prepare('pending-anchor'))
      await Promise.all(
        Array.from({ length: HOST_TRANSACTION_LOG_COMPACT_RECORDS / 2 + 2 }, (_, i) =>
          finished(log, 'settled-' + i)
        )
      )
      await vi.waitFor(() => expect(log.stats().commands).toBeLessThan(10))
      expect(log.get('pending-anchor')?.prepare).not.toBeNull()
      hold = new Promise<void>((resolve) => {
        release = resolve
      })
      // Trigger a fresh threshold sweep and hold it before its real rewrite.
      const before = compact.mock.calls.length
      await Promise.all(
        Array.from({ length: HOST_TRANSACTION_LOG_COMPACT_RECORDS }, (_, i) =>
          log.append(prepare('shutdown-' + i))
        )
      )
      await vi.waitFor(() => expect(compact.mock.calls.length).toBeGreaterThan(before))
      let shutdownDone = false
      const shutdown = composition.shutdown().then(() => {
        shutdownDone = true
      })
      await vi.waitFor(() => expect(unsubscribeCalled).toBe(true))
      expect(shutdownDone).toBe(false)
      expect(flush).not.toHaveBeenCalled()
      release!()
      await shutdown
      expect(flush).toHaveBeenCalledTimes(1)
      const count = compact.mock.calls.length
      // A stale append observer would schedule another sweep after shutdown.
      await Promise.all(
        Array.from({ length: HOST_TRANSACTION_LOG_COMPACT_RECORDS / 2 }, (_, i) =>
          finished(log, 'after-close-' + i)
        )
      )
      expect(compact).toHaveBeenCalledTimes(count)
      const reopened = HostTransactionLog.open({ dataDir: runtimePath })
      expect(reopened.get('pending-anchor')?.prepare).not.toBeNull()
      expect(reopened.get('after-close-0')?.terminal?.kind).toBe('published')
    } finally {
      release?.()
      await composition.shutdown()
      compact.mockRestore()
      subscription.mockRestore()
      flush.mockRestore()
      rmSync(profilePath, { recursive: true, force: true })
    }
  }, 15_000)
})
