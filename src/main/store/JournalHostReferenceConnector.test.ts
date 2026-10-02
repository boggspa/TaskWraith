import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { JournalHostReferenceConnector } from './JournalHostReferenceConnector'
import { createIncrementalChatJournal } from './IncrementalChatJournal'
import { hostThreadRecordTransferPath } from '../../host-runtime/HostThreadRecordTransfer'
import type { ChatRecord } from './types'
import type {
  CheckpointPreparationSource,
  PreparedCheckpoint
} from './CheckpointPreparationProtocol'

describe('production journal Host reference connector', () => {
  it('rejects queued erased publication instead of triggering record fallback', async () => {
    let reject!: (error: Error) => void
    const result = new Promise<PreparedCheckpoint>((_resolve, fail) => {
      reject = fail
    })
    const connector = new JournalHostReferenceConnector({
      workerEntryPath: '/unused.js',
      owns: () => true,
      capture: () => null
    })
    const maintenance = connector.checkpointPort({
      start: () => ({ output: {} as never, result, cancel: () => {}, release: () => {} })
    })
    const job = maintenance.start({
      chatId: 'maintenance',
      revision: 1
    } as CheckpointPreparationSource)!
    const settled = job.result.catch(() => {})
    await Promise.resolve()
    const queued = connector.stage({
      profilePath: '/unused',
      transferId: 'erased-transfer',
      persist: { chatId: 'erased-chat', revision: 1, expectedRevision: 0 }
    })
    connector.erase('erased-chat')
    await expect(queued).rejects.toThrow('lifecycle fence')
    reject(new Error('exit'))
    await settled
  })

  it('releases an immediately erased pre-spawn maintenance slot and admits the next chat', async () => {
    let constructions = 0
    const connector = new JournalHostReferenceConnector({
      workerEntryPath: '/unused.js',
      owns: () => false,
      capture: () => null
    })
    const port = connector.checkpointPort({
      start: () => {
        constructions++
        throw new Error('next worker constructed')
      }
    })
    const erased = port.start({ chatId: 'erased', revision: 1 } as CheckpointPreparationSource)!
    const erasedFailure = erased.result.catch((error) => error)
    connector.erase('erased')
    const next = port.start({ chatId: 'next', revision: 1 } as CheckpointPreparationSource)!
    await expect(next.result).rejects.toThrow('next worker constructed')
    expect((await erasedFailure).message).toContain('cancelled before admission')
    await Promise.resolve()
    await Promise.resolve()
    expect(constructions).toBe(1)
    expect(connector.snapshot().active).toBe(false)
  })

  it('handles synchronous maintenance construction failure and admits the next ticket', async () => {
    const connector = new JournalHostReferenceConnector({
      workerEntryPath: '/unused.js',
      owns: () => false,
      capture: () => null
    })
    const port = connector.checkpointPort({
      start: () => {
        throw new Error('construction failed')
      }
    })
    const job = port.start({ chatId: 'maintenance', revision: 1 } as CheckpointPreparationSource)!
    await expect(job.result).rejects.toThrow('construction failed')
    await Promise.resolve()
    await Promise.resolve()
    expect(connector.snapshot().active).toBe(false)
    const next = port.start({ chatId: 'next', revision: 1 } as CheckpointPreparationSource)!
    await expect(next.result).rejects.toThrow('construction failed')
  })

  it('expires queued publication without capturing while an executor awaits exit', async () => {
    let reject!: (error: Error) => void
    const exited = new Promise<PreparedCheckpoint>((_resolve, fail) => {
      reject = fail
    })
    const connector = new JournalHostReferenceConnector({
      workerEntryPath: '/unused.js',
      owns: () => true,
      capture: () => {
        throw new Error('Queued source must not be captured')
      }
    })
    const maintenance = connector.checkpointPort({
      start: () => ({ output: {} as never, result: exited, cancel: () => {}, release: () => {} })
    })
    const job = maintenance.start({
      chatId: 'maintenance',
      revision: 1
    } as CheckpointPreparationSource)!
    const failure = job.result.catch((error) => error)
    await Promise.resolve()
    const queued = connector.stage({
      profilePath: '/unused',
      transferId: 'queued',
      persist: { chatId: 'chat', revision: 1, expectedRevision: 0 }
    })
    await expect(queued).resolves.toBeNull()
    expect(connector.snapshot().active).toBe(true)
    reject(new Error('executor exit'))
    await failure
    await Promise.resolve()
    await Promise.resolve()
    expect(connector.snapshot().active).toBe(false)
  })

  it('cancels maintenance at its deadline and holds the lane until actual executor exit', async () => {
    let reject!: (error: Error) => void
    const exited = new Promise<PreparedCheckpoint>((_resolve, fail) => {
      reject = fail
    })
    let cancelled = false
    let released = false
    const connector = new JournalHostReferenceConnector({
      workerEntryPath: '/unused.js',
      owns: () => false,
      capture: () => null
    })
    const base = connector.checkpointPort({
      start: () => ({
        output: { path: '/unused', identity: {} } as never,
        result: exited,
        cancel: () => {
          cancelled = true
        },
        release: () => {
          released = true
        }
      })
    })
    const job = base.start({ chatId: 'maintenance', revision: 1 } as CheckpointPreparationSource)!
    const rejection = expect(job.result).rejects.toThrow('executor closed')
    await new Promise((resolve) => setTimeout(resolve, 340))
    expect(cancelled).toBe(true)
    expect(connector.snapshot().active).toBe(true)
    expect(released).toBe(false)
    reject(new Error('executor closed'))
    await rejection
    await Promise.resolve()
    await Promise.resolve()
    expect(connector.snapshot().active).toBe(false)
    expect(released).toBe(true)
  })

  it('runs a genuine thread from admitted journal capture and holds credit until Host acknowledgement', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-host-connector-'))
    const entry = path.join(root, 'worker.cjs')
    await build({
      entryPoints: ['src/main/store/JournalPublicationPreparationWorker.ts'],
      outfile: entry,
      platform: 'node',
      format: 'cjs',
      bundle: true,
      target: 'node22'
    })
    const journal = createIncrementalChatJournal(path.join(root, 'journal'))
    const record = {
      appChatId: 'chat',
      title: 'exact record',
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      runs: [],
      persistenceRevision: 1
    } as ChatRecord
    journal.initialize('chat', record)
    let captures = 0
    let releases = 0
    const connector = new JournalHostReferenceConnector({
      workerEntryPath: entry,
      owns: (_id, revision) => revision === 1,
      capture: (id, revision) => {
        captures++
        const lease = journal.captureSource?.(id, revision)
        if (!lease) return null
        return {
          ...lease,
          release: () => {
            releases++
            lease.release()
          }
        }
      }
    })
    try {
      const descriptor = await connector.stage({
        profilePath: root,
        transferId: 'transfer-one',
        persist: { chatId: 'chat', revision: 1, expectedRevision: 0 }
      })
      expect(descriptor?.transferId).toBe('transfer-one')
      expect(
        JSON.parse(fs.readFileSync(hostThreadRecordTransferPath(root, 'transfer-one'), 'utf8'))
          .title
      ).toBe('exact record')
      expect(captures).toBe(1)
      expect(releases).toBe(0)
      const second = await connector.stage({
        profilePath: root,
        transferId: 'transfer-two',
        persist: { chatId: 'chat', revision: 1, expectedRevision: 0 }
      })
      expect(second?.transferId).toBe('transfer-two')
      expect(captures).toBe(2)
      expect(releases).toBe(0)
      connector.erase('chat')
      expect(connector.snapshot().retainedArtifacts).toBe(2)
      expect(releases).toBe(0)
      connector.acknowledgeTransfer('unrelated-transfer')
      expect(releases).toBe(0)
      connector.acknowledgeTransfer('transfer-one')
      expect(releases).toBe(1)
      connector.acknowledgeTransfer('transfer-two')
      expect(releases).toBe(2)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('declines unresolved ownership without capturing or serializing a record', () => {
    const connector = new JournalHostReferenceConnector({
      workerEntryPath: '/not-used.js',
      owns: () => false,
      capture: () => {
        throw new Error('unadmitted capture')
      }
    })
    expect(
      connector.stage({
        profilePath: '/profile',
        transferId: 'declined',
        persist: { chatId: 'chat', revision: 1, expectedRevision: 0 }
      })
    ).toBeNull()
    expect(connector.counters.unavailable).toBe(1)
  })
})
