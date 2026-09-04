import * as fs from 'fs'
import * as path from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { createApprovalLedgerRecord } from '../ApprovalLedger'
import { ApprovalLedgerEventStore, approvalLedgerEventStorePaths } from './ApprovalLedgerEventStore'
import type { ApprovalLedgerRecord } from './types'

const roots: string[] = []

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'taskwraith-approval-event-store-'))
  roots.push(root)
  return root
}

function pending(approvalId: string, requestedAt = '2026-09-04T12:00:00.000Z') {
  return createApprovalLedgerRecord(
    {
      approvalId,
      provider: 'codex',
      service: 'shellCommands',
      method: 'codex-mcp/run_shell_command',
      title: `Approve ${approvalId}`,
      actions: ['accept', 'decline'],
      runId: 'run-1',
      chatId: 'chat-1',
      workspacePath: '/repo'
    },
    requestedAt
  )
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('ApprovalLedgerEventStore', () => {
  it('imports the legacy array once and keeps hot put/resolve writes in the event journal', () => {
    const root = makeRoot()
    const paths = approvalLedgerEventStorePaths(root)
    const legacy = [pending('legacy-1')]
    fs.writeFileSync(paths.legacy, JSON.stringify(legacy, null, 2), 'utf8')
    const legacyBefore = fs.readFileSync(paths.legacy, 'utf8')
    let eventNumber = 0
    const store = new ApprovalLedgerEventStore({
      userDataPath: root,
      now: () => new Date('2026-09-04T13:00:00.000Z'),
      idFactory: () => `event-${++eventNumber}`
    })

    store.put({
      approvalId: 'new-1',
      provider: 'claude',
      service: 'fileChanges',
      method: 'claude-mcp/write_file',
      title: 'Approve write',
      actions: ['accept', 'decline']
    })
    const resolved = store.resolve('new-1', 'accept')

    expect(resolved?.status).toBe('approved')
    expect(store.getRecords().map((record) => record.approvalId)).toEqual(['legacy-1', 'new-1'])
    expect(fs.readFileSync(paths.legacy, 'utf8')).toBe(legacyBefore)
    expect(fs.readFileSync(paths.events, 'utf8')).toContain('"kind":"put"')
    expect(fs.readFileSync(paths.events, 'utf8')).toContain('"kind":"resolve"')
    expect(store.stats()).toMatchObject({ appends: 2, importedLegacyRecords: 1, sequence: 2 })
  })

  it('replays events and rejects a second decision for the same approval', () => {
    const root = makeRoot()
    const first = new ApprovalLedgerEventStore({ userDataPath: root })
    first.put(pending('approval-1'))
    first.resolve('approval-1', 'decline', 'system', { autoDeniedByTimeout: true })

    const reopened = new ApprovalLedgerEventStore({ userDataPath: root })
    expect(reopened.getRecords()[0]).toMatchObject({
      approvalId: 'approval-1',
      status: 'denied',
      decision: 'autoDeny',
      decisionSource: 'system',
      metadata: { autoDeniedByTimeout: true }
    })
    expect(reopened.resolve('approval-1', 'accept')).toBeNull()
    expect(reopened.stats()).toMatchObject({ replayedEvents: 2, sequence: 2 })
  })

  it('recovers a torn final JSON fragment without losing prior durable events', () => {
    const root = makeRoot()
    const paths = approvalLedgerEventStorePaths(root)
    const first = new ApprovalLedgerEventStore({ userDataPath: root })
    first.put(pending('approval-1'))
    const validBytes = fs.statSync(paths.events).size
    fs.appendFileSync(paths.events, '\n{"format":"taskwraith-approval-ledger-event"', 'utf8')

    const reopened = new ApprovalLedgerEventStore({ userDataPath: root })

    expect(reopened.getRecords().map((record) => record.approvalId)).toEqual(['approval-1'])
    expect(reopened.stats().recoveredTornTails).toBe(1)
    expect(fs.statSync(paths.events).size).toBe(validBytes + 1)
  })

  it('isolates a torn append from a later durable retry', () => {
    const root = makeRoot()
    const paths = approvalLedgerEventStorePaths(root)
    const first = new ApprovalLedgerEventStore({ userDataPath: root })
    first.put(pending('approval-1'))
    fs.appendFileSync(paths.events, '\n{"torn":', 'utf8')
    first.put(pending('approval-2'))

    const reopened = new ApprovalLedgerEventStore({ userDataPath: root })

    expect(reopened.getRecords().map((record) => record.approvalId)).toEqual([
      'approval-1',
      'approval-2'
    ])
    expect(reopened.stats().recoveredTornTails).toBe(1)
  })

  it('fails closed when a durable event hash is changed', () => {
    const root = makeRoot()
    const paths = approvalLedgerEventStorePaths(root)
    const first = new ApprovalLedgerEventStore({ userDataPath: root })
    first.put(pending('approval-1'))
    const raw = fs.readFileSync(paths.events, 'utf8')
    fs.writeFileSync(
      paths.events,
      raw.replace(/"hash":"[a-f0-9]{64}"/, `"hash":"${'0'.repeat(64)}"`)
    )

    expect(() => new ApprovalLedgerEventStore({ userDataPath: root })).toThrow(
      'event hash is invalid'
    )
  })

  it('fails closed when valid hash-chained events are reordered', () => {
    const root = makeRoot()
    const paths = approvalLedgerEventStorePaths(root)
    const first = new ApprovalLedgerEventStore({ userDataPath: root })
    first.put(pending('approval-1'))
    first.put(pending('approval-2'))
    const lines = fs.readFileSync(paths.events, 'utf8').split('\n').filter(Boolean)
    fs.writeFileSync(paths.events, `\n${lines.reverse().join('\n')}`, 'utf8')

    expect(() => new ApprovalLedgerEventStore({ userDataPath: root })).toThrow(
      'sequence or hash chain is invalid'
    )
  })

  it('compacts snapshot-before-WAL-reset and refreshes the legacy rollback mirror', () => {
    const root = makeRoot()
    const paths = approvalLedgerEventStorePaths(root)
    const store = new ApprovalLedgerEventStore({ userDataPath: root })
    store.put(pending('approval-1'))
    store.resolve('approval-1', 'accept')

    const compacted = store.compact()

    expect(fs.readFileSync(paths.events, 'utf8')).toBe('')
    expect(JSON.parse(fs.readFileSync(paths.legacy, 'utf8'))).toEqual(compacted)
    const reopened = new ApprovalLedgerEventStore({ userDataPath: root })
    expect(reopened.getRecords()).toEqual(compacted)
    expect(reopened.stats()).toMatchObject({ replayedEvents: 0, sequence: 2 })
  })

  it('replays safely when a crash lands after snapshot publication but before WAL reset', () => {
    const root = makeRoot()
    const paths = approvalLedgerEventStorePaths(root)
    const store = new ApprovalLedgerEventStore({
      userDataPath: root,
      afterSnapshotWrite: () => {
        throw new Error('injected crash')
      }
    })
    store.put(pending('approval-1'))
    const walBefore = fs.readFileSync(paths.events, 'utf8')

    expect(() => store.compact()).toThrow('injected crash')
    expect(fs.readFileSync(paths.events, 'utf8')).toBe(walBefore)
    expect(new ApprovalLedgerEventStore({ userDataPath: root }).getRecords()).toEqual(
      store.getRecords()
    )
  })

  it('durably replaces a projection and purges v2, legacy, temp and corrupt artifacts', () => {
    const root = makeRoot()
    const paths = approvalLedgerEventStorePaths(root)
    const store = new ApprovalLedgerEventStore({ userDataPath: root })
    store.put(pending('remove-me'))
    const keep = pending('keep-me')
    expect(store.replaceProjection([keep]).map((record) => record.approvalId)).toEqual(['keep-me'])
    expect(
      new ApprovalLedgerEventStore({ userDataPath: root })
        .getRecords()
        .map((record) => record.approvalId)
    ).toEqual(['keep-me'])

    fs.writeFileSync(`${paths.legacy}.corrupt-1`, 'secret', 'utf8')
    fs.writeFileSync(`${paths.events}.claimed-1`, 'secret', 'utf8')
    fs.writeFileSync(`${paths.snapshot}.1.tmp`, 'secret', 'utf8')
    store.purge()

    expect(store.getRecords()).toEqual([])
    expect(fs.readdirSync(root).filter((name) => name.startsWith('approval-ledger'))).toEqual([])
    const afterPurge = store.put(pending('after-purge'))
    expect(afterPurge.approvalId).toBe('after-purge')
    expect(fs.existsSync(paths.snapshot)).toBe(true)
    expect(fs.existsSync(paths.events)).toBe(true)
  })

  it('returns detached record copies so callers cannot mutate the cached projection', () => {
    const root = makeRoot()
    const store = new ApprovalLedgerEventStore({ userDataPath: root })
    store.put(pending('approval-1'))
    const copy = store.getRecords() as ApprovalLedgerRecord[]
    copy[0].title = 'mutated outside the store'

    expect(store.getRecords()[0].title).toBe('Approve approval-1')
  })
})
