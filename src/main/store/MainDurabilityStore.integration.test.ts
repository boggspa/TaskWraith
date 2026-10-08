import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_AUDIT_RETENTION } from './slices/auditRetentionNormalizers'

// This file proves the main durability binding of the pre-barrier path (its
// enrolled detail owner and checkpoint ports): the path the store takes with
// barrier durability off. Barrier durability is on by default and the store
// reads its switch once, at load, so it is pinned off here with the exact
// token `0` before the store is imported. Detail under the switch, erasure
// included, is proven in ThreadBarrierDurability.integration.test.ts.
vi.hoisted(() => {
  vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '0')
})
afterAll(() => {
  vi.unstubAllEnvs()
})

const ports = vi.hoisted(() => ({
  shutdown: vi.fn(async () => {}),
  snapshot: vi.fn(() => ({ runEvents: { mode: 'legacy' }, journal: { attached: true } })),
  drainSync: vi.fn(),
  retireSync: vi.fn(),
  clearHeads: vi.fn(),
  detailRetire: vi.fn(),
  detailAppend: vi.fn(),
  open: vi.fn(() => {
    throw new Error('Constructor opened a resource')
  }),
  acquire: vi.fn(() => {
    throw new Error('Constructor acquired a resource')
  }),
  participant: undefined as
    | undefined
    | { fence(): void; drainSync(): void; retire(): Promise<void> }
}))

vi.mock('electron', () => ({
  app: { getPath: () => `/tmp/taskwraith-durability-store-${process.pid}` }
}))
vi.mock('./MainDurabilityRuntime', async () => {
  const { RunEventLedgerWriter } = await import('./RunEventLedgerWriter')
  return {
    createMainDurabilityRuntime: (options: { runEventsDir: string; runArtifactsDir: string }) => ({
      writer: Object.assign(new RunEventLedgerWriter(options), {
        retireSync: ports.retireSync,
        clearHeads: ports.clearHeads
      }),
      snapshot: ports.snapshot,
      shutdown: ports.shutdown,
      attachDetail: (create: (bindings: unknown) => object) => {
        const participant = create({ flusher: { drainSync: ports.drainSync }, directoryLeases: {} })
        Object.assign(participant, { retireForErasureSync: ports.detailRetire })
        Object.assign(participant, { append: ports.detailAppend })
        return true
      },
      attachCatalogue: () => false,
      attachJournal: (create: (bindings: unknown) => typeof ports.participant) => {
        ports.participant = create({
          flusher: {
            open: ports.open,
            drainSync: ports.drainSync,
            forget: async () => {},
            forgetSync: () => {}
          },
          directoryLeases: { acquire: ports.acquire }
        })
        return true
      }
    })
  }
})

import { AppStore } from '../store'

describe('Store main durability binding', () => {
  it('injects the enrolled detail owner on saves before and after global artifact erasure', () => {
    const flush = vi.fn()
    ports.detailAppend.mockImplementation((filePath: string, bytes: Buffer) => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.appendFileSync(filePath, bytes)
      return { flushSync: flush, awaitDurable: async () => {}, journalDependencies: () => [] }
    })
    const makeChat = (chatId: string, runId: string): import('./types').ChatRecord => ({
      appChatId: chatId,
      scope: 'global',
      chatKind: 'single',
      provider: 'codex',
      title: 'Details',
      createdAt: 1,
      updatedAt: 2,
      archived: false,
      messages: [
        {
          id: 'message',
          role: 'tool',
          content: '',
          timestamp: '2026-09-04T00:00:00Z',
          runId,
          toolActivities: [
            {
              id: 'tool',
              toolName: 'run_shell_command',
              displayName: 'Ran command',
              category: 'shell',
              status: 'success',
              endedAt: '2026-09-04T00:00:01Z',
              rawResultEvent: { output: 'x'.repeat(70_000) }
            }
          ]
        }
      ],
      runs: [{ runId, startedAt: '2026-09-04T00:00:00Z', status: 'running' }]
    })
    ports.detailAppend.mockClear()
    const first = AppStore.saveChat(
      makeChat('33333333-3333-4333-8333-333333333333', 'detail-before')
    )
    expect(ports.detailAppend).toHaveBeenCalledOnce()
    expect(first.messages[0].toolActivities?.[0].detailRef).toBeDefined()
    expect(flush).toHaveBeenCalled()
    const store = AppStore as unknown as {
      executeHistoryDeletionStep(intent: { kind: string; runIds: string[] }, step: string): void
    }
    store.executeHistoryDeletionStep({ kind: 'global', runIds: [] }, 'run-artifacts')
    const second = AppStore.saveChat(
      makeChat('44444444-4444-4444-8444-444444444444', 'detail-after')
    )
    expect(ports.detailAppend).toHaveBeenCalledTimes(2)
    expect(second.messages[0].toolActivities?.[0].detailRef).toBeDefined()
    expect(JSON.stringify(second)).not.toContain('awaitDurable')
  })

  it('forensic retention refuses both ledger and artifact unlink when detail retirement fails', () => {
    const profile = `/tmp/taskwraith-durability-store-${process.pid}`
    const events = path.join(profile, 'run-events')
    const artifacts = path.join(profile, 'run-artifacts', 'retention-target')
    fs.mkdirSync(events, { recursive: true })
    fs.mkdirSync(artifacts, { recursive: true })
    const ledger = path.join(events, 'retention-target.jsonl')
    fs.writeFileSync(ledger, '{}\n')
    fs.utimesSync(ledger, new Date('2020-01-01'), new Date('2020-01-01'))
    ports.detailRetire.mockImplementationOnce((scopes) => {
      expect(scopes).toEqual([artifacts])
      expect(fs.existsSync(ledger)).toBe(true)
      throw new Error('retention detail close failed')
    })
    const result = AppStore.purgeAuditRetentionEvidence({
      dryRun: false,
      now: '2027-01-01T00:00:00Z',
      policy: { ...DEFAULT_AUDIT_RETENTION, enabled: true }
    })
    expect(result.ok).toBe(false)
    expect(fs.existsSync(ledger)).toBe(true)
    expect(fs.existsSync(artifacts)).toBe(true)
    fs.rmSync(ledger, { force: true })
    fs.rmSync(artifacts, { recursive: true, force: true })
  })

  it('retires exact detail scopes before artifact removal and refuses unlink on retirement failure', () => {
    const directory = `/tmp/taskwraith-durability-store-${process.pid}/run-artifacts`
    const target = path.join(directory, 'detail-target')
    const sibling = path.join(directory, 'detail-sibling')
    fs.mkdirSync(target, { recursive: true })
    fs.mkdirSync(sibling, { recursive: true })
    fs.writeFileSync(path.join(target, 'detail.log'), 'pending')
    const store = AppStore as unknown as {
      executeHistoryDeletionStep(intent: { kind: string; runIds: string[] }, step: string): void
    }
    ports.detailRetire.mockImplementationOnce((scopes) => {
      expect(scopes).toEqual([target])
      expect(fs.existsSync(target)).toBe(true)
      throw new Error('detail join failed')
    })
    expect(() =>
      store.executeHistoryDeletionStep({ kind: 'chat', runIds: ['detail-target'] }, 'run-artifacts')
    ).toThrow('detail join failed')
    expect(fs.existsSync(target)).toBe(true)
    ports.detailRetire.mockImplementationOnce((scopes) => {
      expect(scopes).toEqual([target])
    })
    store.executeHistoryDeletionStep({ kind: 'chat', runIds: ['detail-target'] }, 'run-artifacts')
    expect(fs.existsSync(target)).toBe(false)
    expect(fs.existsSync(sibling)).toBe(true)
    ports.detailRetire.mockImplementationOnce((scopes) => {
      expect(scopes).toBeUndefined()
    })
    store.executeHistoryDeletionStep({ kind: 'global', runIds: [] }, 'run-artifacts')
    // Erasure does not call the participant's permanent shutdown fence.
    fs.mkdirSync(target, { recursive: true })
    store.executeHistoryDeletionStep({ kind: 'chat', runIds: ['detail-target'] }, 'run-artifacts')
    expect(fs.existsSync(target)).toBe(false)
  })

  it('retires scoped history descriptors before unlinking their ledger', () => {
    const directory = `/tmp/taskwraith-durability-store-${process.pid}/run-events`
    fs.mkdirSync(directory, { recursive: true })
    const ledger = path.join(directory, 'retirement-order.jsonl')
    fs.writeFileSync(ledger, 'pending\n')
    ports.retireSync.mockImplementationOnce((ids) => {
      expect(ids).toEqual(['retirement-order'])
      expect(fs.existsSync(ledger)).toBe(true)
    })
    // Exercise the real deletion step with its frozen, already-quiesced scope.
    const store = AppStore as unknown as {
      executeHistoryDeletionStep(intent: { kind: string; runIds: string[] }, step: string): void
    }
    store.executeHistoryDeletionStep({ kind: 'chat', runIds: ['retirement-order'] }, 'run-events')
    expect(fs.existsSync(ledger)).toBe(false)
  })

  it('joins a pending descriptor before closing it and clearing cached heads on reset', () => {
    const order: string[] = []
    let pending = true
    let closed = false
    ports.retireSync.mockImplementationOnce(() => {
      expect(pending).toBe(true)
      expect(closed).toBe(false)
      order.push('join')
      pending = false
      order.push('close')
      closed = true
    })
    ports.clearHeads.mockImplementationOnce(() => {
      expect(pending).toBe(false)
      expect(closed).toBe(true)
      order.push('clear')
    })
    AppStore.resetTransientDeletionGuardsForTests()
    expect(order).toEqual(['join', 'close', 'clear'])
  })

  it('does not clear cached heads if descriptor retirement fails', () => {
    ports.clearHeads.mockClear()
    ports.retireSync.mockImplementationOnce(() => {
      throw new Error('join failed')
    })
    expect(() => AppStore.resetTransientDeletionGuardsForTests()).toThrow('join failed')
    expect(ports.clearHeads).not.toHaveBeenCalled()
  })

  it('constructs the attached journal participant without opening resources', () => {
    expect(ports.participant).toBeDefined()
    expect(ports.open).not.toHaveBeenCalled()
    expect(ports.acquire).not.toHaveBeenCalled()
  })

  it('exposes actual runtime diagnostics and shutdown and drains the shared journal port', async () => {
    expect(AppStore.getMainDurabilitySnapshot()).toEqual(ports.snapshot())
    ports.participant!.drainSync()
    expect(ports.drainSync).toHaveBeenCalledOnce()
    await AppStore.shutdownMainDurability()
    expect(ports.shutdown).toHaveBeenCalledOnce()
  })
})
