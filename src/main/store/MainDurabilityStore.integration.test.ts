import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ports = vi.hoisted(() => ({
  shutdown: vi.fn(async () => {}),
  snapshot: vi.fn(() => ({ runEvents: { mode: 'legacy' }, journal: { attached: true } })),
  drainSync: vi.fn(),
  retireSync: vi.fn(),
  clearHeads: vi.fn(),
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
