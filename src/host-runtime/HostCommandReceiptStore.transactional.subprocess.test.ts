import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  HostCommandReceiptStore,
  HOST_COMMAND_RECEIPT_CHECKPOINT_FILENAME,
  HOST_COMMAND_RECEIPT_JOURNAL_FILENAME,
  type HostCommandReceiptRecord
} from './HostCommandReceiptStore'

// M4 slice 9 (design §17.2), the subprocess cut: a real Node writer begins
// one transactional receipt and one unclassified receipt through the
// production store, then SIGKILLs itself with both pending. The parent's
// reopen must leave the transactional one to the manifest recovery (slice 14)
// and promote the other exactly as today. Process-crash recovery only; not a
// power-loss test.

const NOW = '2026-09-25T10:00:00.000Z'
const actor = { actorId: 'crash-actor', clientId: 'crash-client', clientClass: 'desktop' as const }
const base = {
  commandName: 'thread.record.persist' as const,
  actor,
  target: { kind: 'thread', id: 'crash-thread' },
  authority: { decision: 'allowed' as const }
}
const TXN = {
  ...base,
  commandId: 'crash-txn',
  idempotencyKey: 'crash-txn-key',
  commandFingerprint: 'a'.repeat(64),
  commandClass: 'txn-record-persist' as const
}
const PLAIN = {
  ...base,
  commandId: 'crash-plain',
  idempotencyKey: 'crash-plain-key',
  commandFingerprint: 'b'.repeat(64)
}

describe('HostCommandReceiptStore transactional receipts across a process crash', () => {
  let root: string
  let executable: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'host-receipt-txn-crash-'))
    executable = join(root, 'writer.cjs')
    buildSync({
      stdin: {
        contents: `
          const { writeFileSync } = require('node:fs');
          const { join } = require('node:path');
          const { HostCommandReceiptStore } =
            require(${JSON.stringify(join(__dirname, 'HostCommandReceiptStore.ts'))});
          const [dataDir] = process.argv.slice(2);
          let clock = Date.parse(${JSON.stringify(NOW)});
          const store = new HostCommandReceiptStore({
            dataDir,
            now: () => new Date(clock++).toISOString(),
            getPosition: () => ({ generation: 1, cursor: 7 }),
            compactAfterRecords: 1000,
            scheduleCompaction: () => { throw new Error('nothing here is due for compaction'); }
          });
          const txn = store.begin(${JSON.stringify(TXN)});
          if (txn.kind !== 'created') throw new Error('txn begin: ' + JSON.stringify(txn));
          const plain = store.begin(${JSON.stringify(PLAIN)});
          if (plain.kind !== 'created') throw new Error('plain begin: ' + JSON.stringify(plain));
          writeFileSync(join(dataDir, 'cut-reached'), 'pending');
          process.kill(process.pid, 'SIGKILL');
          throw new Error('kill did not stop writer');
        `,
        resolveDir: process.cwd(),
        sourcefile: 'host-receipt-txn-crash-writer.cjs',
        loader: 'js'
      },
      outfile: executable,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent'
    })
  })

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  function killWriter(name: string): string {
    const dataDir = join(root, name)
    mkdirSync(dataDir)
    const killed = spawnSync(process.execPath, [executable, dataDir], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000
    })
    expect(killed.error).toBeUndefined()
    expect(killed.stderr).toBe('')
    expect(readFileSync(join(dataDir, 'cut-reached'), 'utf8')).toBe('pending')
    if (process.platform === 'win32') {
      expect(killed.signal === 'SIGKILL' || killed.status === 1).toBe(true)
    } else {
      expect(killed.signal).toBe('SIGKILL')
    }
    return dataDir
  }

  function reopen(dataDir: string): HostCommandReceiptStore {
    let clock = Date.parse('2026-09-25T11:00:00.000Z')
    return new HostCommandReceiptStore({
      dataDir,
      now: () => new Date(clock++).toISOString(),
      getPosition: () => ({ generation: 2, cursor: 9 }),
      compactAfterRecords: 1000
    })
  }

  const journalPath = (dataDir: string) => join(dataDir, HOST_COMMAND_RECEIPT_JOURNAL_FILENAME)
  const checkpointPath = (dataDir: string) =>
    join(dataDir, HOST_COMMAND_RECEIPT_CHECKPOINT_FILENAME)
  const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : null)

  function byId(store: HostCommandReceiptStore, commandId: string): HostCommandReceiptRecord {
    const record = store.list().find((entry) => entry.commandId === commandId)
    if (!record) throw new Error(`receipt ${commandId} is not listed`)
    return record
  }

  it('a writer killed with a transactional receipt pending reopens with it still pending and the other promoted', () => {
    const dataDir = killWriter('pending-pair')

    // Both begins were durable before the kill: two upserts, both pending.
    const journalBefore = read(journalPath(dataDir)) as string
    const events = journalBefore
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { op: string; record: Record<string, unknown> })
    expect(events.map((event) => [event.op, event.record.commandId, event.record.status])).toEqual([
      ['upsert', 'crash-txn', 'pending'],
      ['upsert', 'crash-plain', 'pending']
    ])
    expect(events[0]!.record.commandClass).toBe('txn-record-persist')
    expect(events[1]!.record).not.toHaveProperty('commandClass')
    expect(existsSync(checkpointPath(dataDir))).toBe(false)

    const reopened = reopen(dataDir)

    const txn = byId(reopened, 'crash-txn')
    expect(txn.status).toBe('pending')
    expect(txn.commandClass).toBe('txn-record-persist')
    expect(txn).not.toHaveProperty('recoveryState')
    expect(txn).not.toHaveProperty('errorCode')
    expect(txn).not.toHaveProperty('completedAt')
    expect(txn.updatedAt).toBe(txn.createdAt)

    const plain = byId(reopened, 'crash-plain')
    expect(plain.status).toBe('indeterminate')
    expect(plain.recoveryState).toBe('recoverable-indeterminate')
    expect(plain).not.toHaveProperty('commandClass')
    expect(plain).not.toHaveProperty('completedAt')

    expect(reopened.getAnchorCounts()).toEqual({
      pending: 1,
      indeterminate: 1,
      transactionalPending: 1
    })

    // Exactly one promotion was appended, after the writer's durable prefix.
    const journalAfter = read(journalPath(dataDir)) as string
    expect(journalAfter.startsWith(journalBefore)).toBe(true)
    const appended = journalAfter
      .slice(journalBefore.length)
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { op: string; record: Record<string, unknown> })
    expect(
      appended.map((event) => [event.op, event.record.commandId, event.record.status])
    ).toEqual([['upsert', 'crash-plain', 'indeterminate']])

    // The actor still finds its transactional receipt pending.
    const lookup = reopened.getByCommandId('crash-txn', actor)
    expect(lookup.kind).toBe('found')
    if (lookup.kind === 'found') expect(lookup.receipt.status).toBe('pending')

    // A second reopen changes nothing.
    const listedAfterFirst = reopened.list()
    const checkpointAfterFirst = read(checkpointPath(dataDir))
    const second = reopen(dataDir)
    expect(second.list()).toEqual(listedAfterFirst)
    expect(read(journalPath(dataDir))).toBe(journalAfter)
    expect(read(checkpointPath(dataDir))).toBe(checkpointAfterFirst)
    expect(byId(second, 'crash-txn').status).toBe('pending')
    expect(byId(second, 'crash-plain').status).toBe('indeterminate')
    expect(second.getAnchorCounts()).toEqual({
      pending: 1,
      indeterminate: 1,
      transactionalPending: 1
    })
  })
})
