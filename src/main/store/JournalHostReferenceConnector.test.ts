import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { JournalHostReferenceConnector } from './JournalHostReferenceConnector'
import { HostThreadRecordPersistClient } from '../host/HostThreadRecordPersistCommand'
import type { HostCommand, HostCommandReceipt } from '../../shared/hostProtocol'
import { createIncrementalChatJournal } from './IncrementalChatJournal'
import { hostThreadRecordTransferPath } from '../../host-runtime/HostThreadRecordTransfer'
import type { ChatRecord } from './types'
import type {
  CheckpointPreparationSource,
  PreparedCheckpoint
} from './CheckpointPreparationProtocol'

describe('production journal Host reference connector', () => {
  it('forwards actual lane deadline refusal to the observer without changing cancellation or slot custody', () => {
    const observed: string[] = []
    const connector = new JournalHostReferenceConnector({
      workerEntryPath: '/unused/worker.js',
      capture: () => null,
      owns: () => true,
      residualObserver: (counter) => {
        observed.push(counter)
        throw new Error('telemetry failed')
      }
    })
    connector.lane.enqueue(
      { chatId: 'chat', revision: 1, generation: 1, purpose: 'publication' },
      0
    )
    connector.lane.advance(0)
    expect(connector.lane.advance(300)).toEqual([
      { type: 'cancel', id: 1, reason: 'deadline' },
      { type: 'refused', id: 1, reason: 'deadline' }
    ])
    expect(observed).toEqual(['preparationRefusals'])
    expect(connector.lane.stats().active).toBe(1)
    connector.lane.finishCancellation(1)
    expect(connector.lane.stats().active).toBe(0)
  })
  it('joins real journal bytes through Host staging and an exact successful receipt without record transfer', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-host-e2e-'))
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
      title: 'exact R7',
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      runs: [],
      persistenceRevision: 7
    } as ChatRecord
    journal.initialize('chat', record)
    let eraseDuringCapture = false
    const connector = new JournalHostReferenceConnector({
      workerEntryPath: entry,
      owns: (_id, revision) => revision === 7,
      capture: (id, revision) => {
        const lease = journal.captureSource?.(id, revision) ?? null
        if (eraseDuringCapture) connector.cancelChat(id)
        return lease
      }
    })
    let submissions = 0
    const client = new HostThreadRecordPersistClient({
      profilePath: root,
      referenceStaging: connector,
      transfer: {
        publish: () => {
          throw new Error('Full-record transfer forbidden')
        },
        remove: () => false
      },
      broker: {
        submitCommand: async (command: HostCommand) => {
          submissions++
          const transferId = String(command.arguments.transferId)
          const bytes = fs.readFileSync(hostThreadRecordTransferPath(root, transferId))
          expect(createHash('sha256').update(bytes).digest('hex')).toBe(command.arguments.sha256)
          expect(bytes).toEqual(Buffer.from(JSON.stringify(record)))
          expect(bytes.byteLength).toBe(command.arguments.byteLength)
          expect(JSON.parse(bytes.toString()).persistenceRevision).toBe(7)
          expect(JSON.parse(bytes.toString()).title).toBe('exact R7')
          expect(command.arguments.expectedRevision).toBe(6)
          expect(connector.snapshot().retainedArtifacts).toBe(1)
          return {
            ok: true as const,
            receipt: {
              type: 'host.receipt',
              protocolVersion: command.protocolVersion,
              commandId: command.commandId,
              idempotencyKey: command.idempotencyKey,
              name: command.name,
              actor: command.actor,
              authority: { decision: 'allow' },
              status: 'succeeded',
              commandFingerprint: 'f'.repeat(64),
              generation: 1,
              cursor: 1,
              createdAt: '2026-10-02T00:00:00Z',
              updatedAt: '2026-10-02T00:00:00Z'
            } satisfies HostCommandReceipt
          }
        },
        lookupReceipt: async () => {
          throw new Error('Unexpected receipt lookup')
        }
      }
    })
    try {
      await client.persist({ chatId: 'chat', record, expectedRevision: 6 })
      expect(submissions).toBe(1)
      expect(connector.snapshot().retainedArtifacts).toBe(0)
      expect(connector.snapshot().credits.jobs).toBe(0)
      eraseDuringCapture = true
      await expect(
        client.persist({ chatId: 'chat', record, expectedRevision: 6 })
      ).rejects.toMatchObject({ code: 'artifact_publish_failed' })
      expect(submissions).toBe(1)
      const exitDeadline = Date.now() + 2000
      while (connector.snapshot().active && Date.now() < exitDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(connector.snapshot().active).toBe(false)
      expect(connector.snapshot().credits.jobs).toBe(0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

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
