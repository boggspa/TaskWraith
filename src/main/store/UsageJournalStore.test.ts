import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash } from 'crypto'
import type { UsageRecord } from './types'
import { UsageJournalStore } from './UsageJournalStore'
import { USAGE_ROTATION_RETENTION_MS } from './usageRotation'

function usageRecord(id: string, timestamp: number): UsageRecord {
  return {
    id,
    timestamp,
    workspaceId: 'workspace',
    chatId: 'chat',
    runId: `run-${id}`,
    usageKind: 'run',
    model: 'model',
    provider: 'claude',
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
    durationMs: 10
  } as UsageRecord
}

function ownedUsageRecord(
  id: string,
  timestamp: number,
  overrides: Partial<UsageRecord>
): UsageRecord {
  return {
    ...usageRecord(id, timestamp),
    promptText: `prompt-${id}`,
    responseText: `response-${id}`,
    ...overrides
  }
}

describe('UsageJournalStore', () => {
  let directory: string
  let checkpointPath: string
  let journalPath: string
  let archivePath: string
  let stores: UsageJournalStore[]
  const now = Date.parse('2026-07-19T00:00:00.000Z')

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-usage-journal-'))
    checkpointPath = path.join(directory, 'usage.json')
    journalPath = path.join(directory, 'usage-journal.jsonl')
    archivePath = path.join(directory, 'usage-archive.jsonl')
    stores = []
  })

  afterEach(() => {
    for (const store of stores) store.dispose()
    vi.useRealTimers()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  function createStore(
    overrides: Partial<ConstructorParameters<typeof UsageJournalStore>[0]> = {}
  ): UsageJournalStore {
    const store = new UsageJournalStore({
      checkpointPath,
      journalPath,
      archivePath,
      compactAfterRecords: 100,
      compactAfterBytes: 1024 * 1024,
      compactionDelayMs: 60_000,
      now: () => now,
      logger: { error: vi.fn(), warn: vi.fn() },
      ...overrides
    })
    stores.push(store)
    return store
  }

  it('fsyncs an append journal without rewriting the usage.json checkpoint', () => {
    const checkpointRecord = usageRecord('checkpoint', now - 2)
    const appendedRecord = usageRecord('appended', now - 1)
    fs.writeFileSync(checkpointPath, JSON.stringify([checkpointRecord], null, 2))
    const before = fs.readFileSync(checkpointPath, 'utf8')

    const store = createStore()
    store.append(appendedRecord)

    expect(fs.readFileSync(checkpointPath, 'utf8')).toBe(before)
    expect(fs.readFileSync(journalPath, 'utf8')).toContain('"id":"appended"')
    expect(store.getRecords().map((record) => record.id)).toEqual(['checkpoint', 'appended'])
  })

  it('does not read checkpoint or journal history on the completion append path', () => {
    fs.writeFileSync(checkpointPath, JSON.stringify([usageRecord('checkpoint', now - 1)]))
    const readTextFile = vi.fn(() => {
      throw new Error('append must not replay durable history')
    })
    const store = createStore({ readTextFile })

    store.append(usageRecord('first', now))
    store.append(usageRecord('second', now + 1))

    expect(readTextFile).not.toHaveBeenCalled()
    expect(fs.readFileSync(journalPath, 'utf8')).toContain('"id":"first"')
    expect(fs.readFileSync(journalPath, 'utf8')).toContain('"id":"second"')
  })

  it('recovers a journal claimed immediately before a process crash', () => {
    const record = usageRecord('claimed-before-crash', now)
    const firstProcess = createStore()
    firstProcess.append(record)
    const claimedPath = `${journalPath}.claimed-crashed-process`
    fs.renameSync(journalPath, claimedPath)

    const restarted = createStore()
    expect(restarted.getRecords().map((item) => item.id)).toEqual([record.id])
    expect(restarted.compact()).toBe(true)
    expect(JSON.parse(fs.readFileSync(checkpointPath, 'utf8'))).toEqual([record])
    expect(fs.existsSync(claimedPath)).toBe(false)
  })

  it('dedupes replay when a crash happens after checkpoint commit but before cleanup', () => {
    const checkpointRecord = usageRecord('already-checkpointed', now - 1)
    const journalRecord = usageRecord('new-journal-record', now)
    fs.writeFileSync(checkpointPath, JSON.stringify([checkpointRecord]))
    fs.writeFileSync(
      `${journalPath}.claimed-crashed-process`,
      `\n${JSON.stringify(checkpointRecord)}\n${JSON.stringify(journalRecord)}`
    )

    const store = createStore()
    expect(store.getRecords().map((record) => record.id)).toEqual([
      'already-checkpointed',
      'new-journal-record'
    ])
    expect(store.compact()).toBe(true)
    expect(
      (JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as UsageRecord[]).map(
        (record) => record.id
      )
    ).toEqual(['already-checkpointed', 'new-journal-record'])
  })

  it('does not let a torn append consume the next complete record', () => {
    const first = usageRecord('first', now - 1)
    const second = usageRecord('second', now)
    const store = createStore()
    store.append(first)
    fs.appendFileSync(journalPath, '\n{"id":"torn"')

    store.append(second)

    expect(store.getRecords().map((record) => record.id)).toEqual(['first', 'second'])
  })

  it('uses an immutable spill instead of blocking when another process holds the lock', () => {
    fs.writeFileSync(
      `${journalPath}.lock`,
      JSON.stringify({ token: 'other-process', pid: 1, createdAt: now })
    )
    const record = usageRecord('spill', now)
    const store = createStore()

    store.append(record)

    expect(fs.existsSync(journalPath)).toBe(false)
    expect(
      fs.readdirSync(directory).some((name) => name.startsWith('usage-journal.jsonl.spill-'))
    ).toBe(true)
    expect(store.getRecords().map((item) => item.id)).toEqual([record.id])

    fs.unlinkSync(`${journalPath}.lock`)
    expect(store.compact()).toBe(true)
    expect(store.getRecords().map((item) => item.id)).toEqual([record.id])
  })

  it('never replays or claims an in-progress spill temp file', () => {
    const tempPath = `${journalPath}.spill-other-process.partial.tmp`
    fs.writeFileSync(tempPath, JSON.stringify(usageRecord('not-committed', now)))
    const store = createStore()

    expect(store.getRecords()).toEqual([])
    expect(store.compact()).toBe(true)
    expect(fs.existsSync(tempPath)).toBe(true)
    expect(fs.existsSync(checkpointPath)).toBe(false)
  })

  it('retains replay inputs when the archive cannot be committed', () => {
    const old = usageRecord('old', now - USAGE_ROTATION_RETENTION_MS - 1)
    const fresh = usageRecord('fresh', now)
    fs.writeFileSync(checkpointPath, JSON.stringify([old]))
    fs.mkdirSync(archivePath)
    const store = createStore()
    store.append(fresh)

    expect(store.compact()).toBe(false)
    expect(store.getRecords().map((record) => record.id)).toEqual(['old', 'fresh'])

    fs.rmSync(archivePath, { recursive: true })
    expect(store.compact()).toBe(true)
    expect(
      (JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as UsageRecord[]).map(
        (record) => record.id
      )
    ).toEqual(['fresh'])
    expect(fs.readFileSync(archivePath, 'utf8')).toContain('"id":"old"')
  })

  it('recovers the archive-before-checkpoint crash window without duplicating hot records', () => {
    const old = usageRecord('old-before-crash', now - USAGE_ROTATION_RETENTION_MS - 1)
    const fresh = usageRecord('fresh-after-restart', now)
    // This is the durable state after archive fsync but before checkpoint
    // rename: the old record exists in both places and must remain replayable.
    fs.writeFileSync(checkpointPath, JSON.stringify([old]))
    fs.writeFileSync(archivePath, `${JSON.stringify(old)}\n`)
    const store = createStore()
    store.append(fresh)

    expect(store.compact()).toBe(true)

    expect(store.getRecords().map((record) => record.id)).toEqual([fresh.id])
    const archivedIds = fs
      .readFileSync(archivePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as UsageRecord).id)
    expect(archivedIds.filter((id) => id === old.id)).toHaveLength(1)
  })

  it('compacts on an idle timer only after the configured append threshold', () => {
    vi.useFakeTimers()
    const store = createStore({ compactAfterRecords: 2, compactionDelayMs: 10 })
    store.append(usageRecord('one', now - 1))
    expect(fs.existsSync(checkpointPath)).toBe(false)

    store.append(usageRecord('two', now))
    expect(fs.existsSync(checkpointPath)).toBe(false)
    vi.advanceTimersByTime(10)

    expect(
      (JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as UsageRecord[]).map(
        (record) => record.id
      )
    ).toEqual(['one', 'two'])
    expect(fs.existsSync(journalPath)).toBe(false)
  })

  it('bounds sparse journals with a daily idle checkpoint', () => {
    vi.useFakeTimers()
    const checkpointRecord = usageRecord('checkpoint', now - 1_000)
    fs.writeFileSync(checkpointPath, JSON.stringify([checkpointRecord]))
    const firstProcess = createStore({
      compactAfterRecords: 100,
      compactAfterMs: 24 * 60 * 60 * 1000,
      compactionDelayMs: 10
    })
    firstProcess.append(usageRecord('sparse', now))
    firstProcess.dispose()
    const oldMtime = new Date(now - 24 * 60 * 60 * 1000 - 1)
    fs.utimesSync(journalPath, oldMtime, oldMtime)
    const store = createStore({
      compactAfterRecords: 100,
      compactAfterMs: 24 * 60 * 60 * 1000,
      compactionDelayMs: 10
    })

    store.getRecords()
    vi.advanceTimersByTime(0)

    expect(
      (JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as UsageRecord[]).map(
        (record) => record.id
      )
    ).toEqual(['checkpoint', 'sparse'])
    expect(fs.existsSync(journalPath)).toBe(false)
  })

  it('checkpoints a low-traffic journal at its age bound without another read or append', () => {
    vi.useFakeTimers()
    const store = createStore({ compactAfterRecords: 100, compactAfterMs: 50 })
    store.append(usageRecord('only-record', now))

    vi.advanceTimersByTime(49)
    expect(fs.existsSync(checkpointPath)).toBe(false)
    vi.advanceTimersByTime(1)

    expect(
      (JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as UsageRecord[]).map(
        (record) => record.id
      )
    ).toEqual(['only-record'])
    expect(fs.existsSync(journalPath)).toBe(false)
  })

  it('daily-checkpoints an aged fresh-install journal with no usage.json yet', () => {
    vi.useFakeTimers()
    const record = usageRecord('fresh-install-journal', now - 24 * 60 * 60 * 1000 - 1)
    fs.writeFileSync(journalPath, `\n${JSON.stringify(record)}`)
    const oldMtime = new Date(now - 24 * 60 * 60 * 1000 - 1)
    fs.utimesSync(journalPath, oldMtime, oldMtime)
    const store = createStore({
      compactAfterRecords: 100,
      compactAfterMs: 24 * 60 * 60 * 1000,
      compactionDelayMs: 10
    })

    expect(store.getRecords().map((item) => item.id)).toEqual([record.id])
    vi.advanceTimersByTime(10)

    expect(
      (JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as UsageRecord[]).map((item) => item.id)
    ).toEqual([record.id])
    expect(fs.existsSync(journalPath)).toBe(false)
  })

  it('aborts compaction without overwriting a corrupt checkpoint', () => {
    const corrupt = '{not-json'
    fs.writeFileSync(checkpointPath, corrupt)
    fs.writeFileSync(journalPath, `\n${JSON.stringify(usageRecord('journal', now))}`)
    const store = createStore()

    expect(store.compact()).toBe(false)

    expect(fs.readFileSync(checkpointPath, 'utf8')).toBe(corrupt)
    expect(
      fs.readdirSync(directory).some((name) => name.startsWith('usage-journal.jsonl.claimed-'))
    ).toBe(true)
  })

  it('quarantines exact malformed journal bytes before compacting valid rows', () => {
    const checkpoint = usageRecord('checkpoint', now - 1)
    const validJournalA = usageRecord('valid-journal-a', now)
    const validJournalB = usageRecord('valid-journal-b', now + 1)
    fs.writeFileSync(checkpointPath, JSON.stringify([checkpoint]))
    const rawJournal = Buffer.concat([
      Buffer.from(`\n${JSON.stringify(validJournalA)}\n`, 'utf8'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from(`\n${JSON.stringify(validJournalB)}\n{torn`, 'utf8')
    ])
    fs.writeFileSync(journalPath, rawJournal)
    const store = createStore()

    expect(store.compact()).toBe(true)

    expect(
      (JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as UsageRecord[]).map(
        (record) => record.id
      )
    ).toEqual(['checkpoint', 'valid-journal-a', 'valid-journal-b'])
    expect(
      fs.readdirSync(directory).some((name) => name.startsWith('usage-journal.jsonl.claimed-'))
    ).toBe(false)
    const quarantine = fs
      .readdirSync(directory)
      .find((name) => name.startsWith('usage-journal.jsonl.quarantine-'))
    expect(quarantine).toBeTruthy()
    expect(fs.readFileSync(path.join(directory, quarantine!))).toEqual(rawJournal)
  })

  it('preserves an invalid-UTF8 checkpoint from its original bytes', () => {
    const corruptBytes = Buffer.from([0x5b, 0xff, 0xfe, 0x5d])
    fs.writeFileSync(checkpointPath, corruptBytes)
    fs.writeFileSync(journalPath, `\n${JSON.stringify(usageRecord('journal', now))}`)
    const store = createStore()

    expect(store.compact()).toBe(false)

    expect(fs.readFileSync(checkpointPath)).toEqual(corruptBytes)
    const digest = createHash('sha256').update(corruptBytes).digest('hex')
    expect(fs.readFileSync(`${checkpointPath}.corrupt-${now}-${digest}`)).toEqual(corruptBytes)
    expect(
      fs.readdirSync(directory).some((name) => name.startsWith('usage-journal.jsonl.claimed-'))
    ).toBe(true)
  })

  it('preserves distinct corrupt checkpoint generations from the same millisecond', () => {
    const firstBytes = Buffer.from([0x5b, 0xff, 0x5d])
    const secondBytes = Buffer.from([0x5b, 0xfe, 0x5d])
    const store = createStore()

    fs.writeFileSync(checkpointPath, firstBytes)
    store.getRecords()
    fs.writeFileSync(checkpointPath, secondBytes)
    store.getRecords()

    const firstDigest = createHash('sha256').update(firstBytes).digest('hex')
    const secondDigest = createHash('sha256').update(secondBytes).digest('hex')
    expect(fs.readFileSync(`${checkpointPath}.corrupt-${now}-${firstDigest}`)).toEqual(firstBytes)
    expect(fs.readFileSync(`${checkpointPath}.corrupt-${now}-${secondDigest}`)).toEqual(secondBytes)
  })

  it('does not mint a corrupt-checkpoint backup behind a pending history sweep', () => {
    const corruptBytes = Buffer.from([0x5b, 0xff, 0x5d])
    fs.writeFileSync(checkpointPath, corruptBytes)
    const store = createStore()
    const hold = store.beginHistoryMutation({
      operationId: 'pending-before-corrupt-read',
      kind: 'global',
      chatIds: [],
      runIds: []
    })

    expect(store.getRecords()).toEqual([])
    expect(fs.readdirSync(directory).some((name) => name.startsWith('usage.json.corrupt-'))).toBe(
      false
    )

    store.purgeHistoryStrict(hold)
    expect(store.endHistoryMutation(hold)).toBe(true)
  })

  it('restarts idempotently after quarantine commit but before checkpoint commit', () => {
    const validJournal = usageRecord('valid-journal', now)
    const rawJournal = Buffer.from(`\n${JSON.stringify(validJournal)}\n{torn`, 'utf8')
    const claimedPath = `${journalPath}.claimed-crashed-process`
    const digest = createHash('sha256').update(rawJournal).digest('hex')
    const quarantinePath = `${journalPath}.quarantine-${digest}.jsonl`
    fs.writeFileSync(claimedPath, rawJournal)
    fs.writeFileSync(quarantinePath, rawJournal)
    const restarted = createStore()

    expect(restarted.compact()).toBe(true)

    expect(
      (JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as UsageRecord[]).map(
        (record) => record.id
      )
    ).toEqual(['valid-journal'])
    expect(fs.existsSync(claimedPath)).toBe(false)
    expect(fs.readFileSync(quarantinePath)).toEqual(rawJournal)
  })

  it('preserves a malformed input when quarantine persistence fails, then retries safely', () => {
    const validJournal = usageRecord('valid-journal', now)
    const rawJournal = Buffer.from(`\n${JSON.stringify(validJournal)}\n{torn`, 'utf8')
    const digest = createHash('sha256').update(rawJournal).digest('hex')
    const quarantinePath = `${journalPath}.quarantine-${digest}.jsonl`
    fs.writeFileSync(journalPath, rawJournal)
    fs.mkdirSync(quarantinePath)
    const store = createStore()

    expect(store.compact()).toBe(false)
    expect(
      fs.readdirSync(directory).some((name) => name.startsWith('usage-journal.jsonl.claimed-'))
    ).toBe(true)
    expect(fs.existsSync(checkpointPath)).toBe(false)

    fs.rmSync(quarantinePath, { recursive: true })
    expect(store.compact()).toBe(true)
    expect(fs.readFileSync(quarantinePath)).toEqual(rawJournal)
    expect(
      (JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as UsageRecord[]).map(
        (record) => record.id
      )
    ).toEqual(['valid-journal'])
  })

  it('aborts compaction and preserves inputs on an injected journal EIO', () => {
    const checkpoint = usageRecord('checkpoint', now - 1)
    const journal = usageRecord('journal', now)
    fs.writeFileSync(checkpointPath, JSON.stringify([checkpoint]))
    fs.writeFileSync(journalPath, `\n${JSON.stringify(journal)}`)
    const before = fs.readFileSync(checkpointPath, 'utf8')
    const eio = Object.assign(new Error('injected read failure'), { code: 'EIO' })
    const store = createStore({
      readTextFile: (filePath) => {
        if (filePath.startsWith(`${journalPath}.claimed-`)) throw eio
        return fs.readFileSync(filePath, 'utf8')
      }
    })

    expect(store.compact()).toBe(false)

    expect(fs.readFileSync(checkpointPath, 'utf8')).toBe(before)
    expect(
      fs.readdirSync(directory).some((name) => name.startsWith('usage-journal.jsonl.claimed-'))
    ).toBe(true)
  })

  it('aborts compaction when a listed journal reports ENOENT', () => {
    fs.writeFileSync(journalPath, `\n${JSON.stringify(usageRecord('journal', now))}`)
    const missing = Object.assign(new Error('injected missing journal'), { code: 'ENOENT' })
    const store = createStore({
      readTextFile: (filePath) => {
        if (filePath.startsWith(`${journalPath}.claimed-`)) throw missing
        return fs.readFileSync(filePath, 'utf8')
      }
    })

    expect(store.compact()).toBe(false)

    const claimed = fs
      .readdirSync(directory)
      .find((name) => name.startsWith('usage-journal.jsonl.claimed-'))
    expect(claimed).toBeTruthy()
    expect(fs.readFileSync(path.join(directory, claimed!), 'utf8')).toContain('"id":"journal"')
    expect(fs.existsSync(checkpointPath)).toBe(false)
  })

  it('aborts compaction and preserves inputs on an injected checkpoint EIO', () => {
    const checkpoint = usageRecord('checkpoint', now - 1)
    const journal = usageRecord('journal', now)
    fs.writeFileSync(checkpointPath, JSON.stringify([checkpoint]))
    fs.writeFileSync(journalPath, `\n${JSON.stringify(journal)}`)
    const before = fs.readFileSync(checkpointPath, 'utf8')
    const eio = Object.assign(new Error('injected checkpoint read failure'), { code: 'EIO' })
    const store = createStore({
      readTextFile: (filePath) => {
        if (filePath === checkpointPath) throw eio
        return fs.readFileSync(filePath, 'utf8')
      }
    })

    expect(store.compact()).toBe(false)

    expect(fs.readFileSync(checkpointPath, 'utf8')).toBe(before)
    expect(
      fs.readdirSync(directory).some((name) => name.startsWith('usage-journal.jsonl.claimed-'))
    ).toBe(true)
  })

  it('retries a read when compaction commits and deletes between checkpoint and journal reads', () => {
    const checkpoint = usageRecord('checkpoint', now - 1)
    const journal = usageRecord('journal', now)
    fs.writeFileSync(checkpointPath, JSON.stringify([checkpoint]))
    fs.writeFileSync(journalPath, `\n${JSON.stringify(journal)}`)
    let crossedCompaction = false
    const store = createStore({
      readTextFile: (filePath) => {
        if (filePath === journalPath && !crossedCompaction) {
          crossedCompaction = true
          fs.writeFileSync(checkpointPath, JSON.stringify([checkpoint, journal]))
          fs.unlinkSync(journalPath)
        }
        return fs.readFileSync(filePath, 'utf8')
      }
    })

    expect(store.getRecords().map((record) => record.id)).toEqual(['checkpoint', 'journal'])
    expect(crossedCompaction).toBe(true)
  })

  it('retries a transient journal EIO before accepting a stable usage snapshot', () => {
    const checkpoint = usageRecord('checkpoint', now - 1)
    const journal = usageRecord('journal', now)
    fs.writeFileSync(checkpointPath, JSON.stringify([checkpoint]))
    fs.writeFileSync(journalPath, `\n${JSON.stringify(journal)}`)
    const eio = Object.assign(new Error('transient journal EIO'), { code: 'EIO' })
    let journalReadAttempts = 0
    const warn = vi.fn()
    const store = createStore({
      logger: { error: vi.fn(), warn },
      readTextFile: (filePath) => {
        if (filePath === journalPath) {
          journalReadAttempts += 1
          if (journalReadAttempts === 1) throw eio
        }
        return fs.readFileSync(filePath, 'utf8')
      }
    })

    expect(store.getRecords().map((record) => record.id)).toEqual(['checkpoint', 'journal'])
    expect(journalReadAttempts).toBe(2)
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('did not stabilize'))
  })

  it('warns only after bounded retries when every journal read returns EIO', () => {
    const checkpoint = usageRecord('checkpoint', now - 1)
    fs.writeFileSync(checkpointPath, JSON.stringify([checkpoint]))
    fs.writeFileSync(journalPath, `\n${JSON.stringify(usageRecord('journal', now))}`)
    const eio = Object.assign(new Error('persistent journal EIO'), { code: 'EIO' })
    let journalReadAttempts = 0
    const warn = vi.fn()
    const store = createStore({
      logger: { error: vi.fn(), warn },
      readTextFile: (filePath) => {
        if (filePath === journalPath) {
          journalReadAttempts += 1
          throw eio
        }
        return fs.readFileSync(filePath, 'utf8')
      }
    })

    expect(store.getRecords().map((record) => record.id)).toEqual(['checkpoint'])
    expect(journalReadAttempts).toBe(3)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not stabilize'))
  })

  it('aborts compaction if an external writer changes the checkpoint generation', () => {
    const checkpoint = usageRecord('checkpoint', now - 2)
    const external = usageRecord('external', now - 1)
    const journal = usageRecord('journal', now)
    fs.writeFileSync(checkpointPath, JSON.stringify([checkpoint]))
    fs.writeFileSync(journalPath, `\n${JSON.stringify(journal)}`)
    let changedCheckpoint = false
    const store = createStore({
      readTextFile: (filePath) => {
        if (filePath.startsWith(`${journalPath}.claimed-`) && !changedCheckpoint) {
          changedCheckpoint = true
          fs.writeFileSync(checkpointPath, JSON.stringify([checkpoint, external]))
        }
        return fs.readFileSync(filePath, 'utf8')
      }
    })

    expect(store.compact()).toBe(false)

    expect(
      (JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as UsageRecord[]).map(
        (record) => record.id
      )
    ).toEqual(['checkpoint', 'external'])
    expect(
      fs.readdirSync(directory).some((name) => name.startsWith('usage-journal.jsonl.claimed-'))
    ).toBe(true)
  })

  it('retries a failed compaction with bounded backoff', () => {
    vi.useFakeTimers()
    fs.writeFileSync(journalPath, `\n${JSON.stringify(usageRecord('journal', now))}`)
    fs.writeFileSync(
      `${journalPath}.lock`,
      JSON.stringify({ token: 'other-process', pid: 1, createdAt: now })
    )
    const store = createStore()

    expect(store.compact()).toBe(false)
    fs.unlinkSync(`${journalPath}.lock`)
    vi.advanceTimersByTime(999)
    expect(fs.existsSync(checkpointPath)).toBe(false)
    vi.advanceTimersByTime(1)

    expect(
      (JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as UsageRecord[]).map(
        (record) => record.id
      )
    ).toEqual(['journal'])
  })

  it('caps automatic compaction retries after persistent read failures', () => {
    vi.useFakeTimers()
    fs.writeFileSync(checkpointPath, JSON.stringify([usageRecord('checkpoint', now - 1)]))
    fs.writeFileSync(journalPath, `\n${JSON.stringify(usageRecord('journal', now))}`)
    const eio = Object.assign(new Error('persistent checkpoint EIO'), { code: 'EIO' })
    let checkpointReadAttempts = 0
    const store = createStore({
      readTextFile: (filePath) => {
        if (filePath === checkpointPath) {
          checkpointReadAttempts += 1
          throw eio
        }
        return fs.readFileSync(filePath, 'utf8')
      }
    })

    expect(store.compact()).toBe(false)
    vi.advanceTimersByTime(120_000)
    const attemptsAfterBackoff = checkpointReadAttempts
    vi.advanceTimersByTime(120_000)

    expect(attemptsAfterBackoff).toBe(7)
    expect(checkpointReadAttempts).toBe(attemptsAfterBackoff)
  })

  it.each(['journal', 'lock'] as const)(
    'refuses a pre-existing symlinked %s target without following it',
    (targetKind) => {
      if (process.platform === 'win32') return
      const targetPath = path.join(directory, `${targetKind}-sentinel`)
      fs.writeFileSync(targetPath, `sentinel-${targetKind}`)
      const managedPath = targetKind === 'journal' ? journalPath : `${journalPath}.lock`
      fs.symlinkSync(targetPath, managedPath)
      const store = createStore()

      expect(() => store.append(usageRecord(`blocked-${targetKind}`, now))).toThrow(
        /Unsafe usage-store path/
      )
      expect(fs.readFileSync(targetPath, 'utf8')).toBe(`sentinel-${targetKind}`)
      expect(
        fs.readdirSync(directory).some((name) => name.startsWith('usage-journal.jsonl.spill-'))
      ).toBe(false)
    }
  )

  it.each(['checkpoint', 'archive'] as const)(
    'allows an append while a symlinked %s target is untouched, then compaction fails closed',
    (targetKind) => {
      if (process.platform === 'win32') return
      const targetPath = path.join(directory, `${targetKind}-sentinel`)
      fs.writeFileSync(targetPath, `sentinel-${targetKind}`)
      const managedPath = targetKind === 'checkpoint' ? checkpointPath : archivePath
      fs.symlinkSync(targetPath, managedPath)
      const store = createStore()

      store.append(usageRecord(`durable-${targetKind}`, now))

      expect(fs.readFileSync(journalPath, 'utf8')).toContain(`"id":"durable-${targetKind}"`)
      expect(store.compact()).toBe(false)
      expect(fs.readFileSync(targetPath, 'utf8')).toBe(`sentinel-${targetKind}`)
      expect(fs.lstatSync(managedPath).isSymbolicLink()).toBe(true)
    }
  )

  it.each(['journal', 'lock'] as const)(
    'refuses a pre-existing hardlinked %s target without mutating its sentinel alias',
    (targetKind) => {
      const targetPath = path.join(directory, `${targetKind}-hardlink-sentinel`)
      const sentinel = Buffer.from(`hardlink-sentinel-${targetKind}`, 'utf8')
      fs.writeFileSync(targetPath, sentinel)
      const managedPath = targetKind === 'journal' ? journalPath : `${journalPath}.lock`
      fs.linkSync(targetPath, managedPath)
      const store = createStore()

      expect(() => store.append(usageRecord(`blocked-${targetKind}`, now))).toThrow(/hard-link/)
      expect(fs.readFileSync(targetPath)).toEqual(sentinel)
      expect(fs.readFileSync(managedPath)).toEqual(sentinel)
    }
  )

  it.each(['checkpoint', 'archive'] as const)(
    'journals while a hardlinked %s is untouched, then compaction rejects the alias inode',
    (targetKind) => {
      const targetPath = path.join(directory, `${targetKind}-hardlink-sentinel`)
      const sentinel = Buffer.from(`hardlink-sentinel-${targetKind}`, 'utf8')
      fs.writeFileSync(targetPath, sentinel)
      const managedPath = targetKind === 'checkpoint' ? checkpointPath : archivePath
      fs.linkSync(targetPath, managedPath)
      const store = createStore()

      store.append(usageRecord(`durable-${targetKind}`, now))

      expect(store.compact()).toBe(false)
      expect(fs.readFileSync(targetPath)).toEqual(sentinel)
      expect(fs.readFileSync(managedPath)).toEqual(sentinel)
      expect(fs.readFileSync(journalPath, 'utf8')).toContain(`"id":"durable-${targetKind}"`)
    }
  )

  it('refuses a hardlinked quarantine target and preserves the claimed source', () => {
    const rawJournal = Buffer.from(
      `\n${JSON.stringify(usageRecord('valid-journal', now))}\n{torn`,
      'utf8'
    )
    const digest = createHash('sha256').update(rawJournal).digest('hex')
    const quarantinePath = `${journalPath}.quarantine-${digest}.jsonl`
    const sentinelPath = path.join(directory, 'quarantine-hardlink-sentinel')
    const sentinel = Buffer.from('quarantine-hardlink-sentinel', 'utf8')
    fs.writeFileSync(journalPath, rawJournal)
    fs.writeFileSync(sentinelPath, sentinel)
    fs.linkSync(sentinelPath, quarantinePath)
    const store = createStore()

    expect(store.compact()).toBe(false)

    expect(fs.readFileSync(sentinelPath)).toEqual(sentinel)
    expect(fs.readFileSync(quarantinePath)).toEqual(sentinel)
    expect(
      fs.readdirSync(directory).some((name) => name.startsWith('usage-journal.jsonl.claimed-'))
    ).toBe(true)
  })

  it('does not unlink a claimed journal that gains a hardlink before cleanup', () => {
    fs.writeFileSync(checkpointPath, '[]')
    const rawJournal = Buffer.from(`\n${JSON.stringify(usageRecord('journal', now))}`, 'utf8')
    fs.writeFileSync(journalPath, rawJournal)
    const aliasPath = path.join(directory, 'claimed-hardlink-sentinel')
    let checkpointReads = 0
    let claimedPath = ''
    const store = createStore({
      readTextFile: (filePath) => {
        if (filePath === checkpointPath) {
          checkpointReads += 1
          if (checkpointReads === 2) {
            const claimedName = fs
              .readdirSync(directory)
              .find((name) => name.startsWith('usage-journal.jsonl.claimed-'))
            claimedPath = path.join(directory, claimedName!)
            fs.linkSync(claimedPath, aliasPath)
          }
        }
        return fs.readFileSync(filePath, 'utf8')
      }
    })

    expect(store.compact()).toBe(true)

    expect(fs.readFileSync(aliasPath)).toEqual(rawJournal)
    expect(fs.readFileSync(claimedPath)).toEqual(rawJournal)
    expect(fs.lstatSync(aliasPath).nlink).toBe(2)
    expect(
      (JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as UsageRecord[]).map(
        (record) => record.id
      )
    ).toEqual(['journal'])
  })

  it('retains a replacement swapped between cleanup validation and atomic retirement', () => {
    fs.writeFileSync(checkpointPath, '[]')
    const rawJournal = Buffer.from(`\n${JSON.stringify(usageRecord('journal', now))}`, 'utf8')
    const replacement = Buffer.from('replacement-must-not-be-deleted', 'utf8')
    const preservedOriginalPath = path.join(directory, 'preserved-original-journal')
    fs.writeFileSync(journalPath, rawJournal)
    let swapped = false
    const store = createStore({
      beforeRetireRename: (filePath) => {
        if (swapped || !filePath.startsWith(`${journalPath}.claimed-`)) return
        swapped = true
        fs.renameSync(filePath, preservedOriginalPath)
        fs.writeFileSync(filePath, replacement)
      }
    })

    expect(store.compact()).toBe(true)

    expect(swapped).toBe(true)
    expect(fs.readFileSync(preservedOriginalPath)).toEqual(rawJournal)
    const retirementDirectory = fs.readdirSync(directory).find((name) => name.includes('.retire-'))
    expect(retirementDirectory).toBeTruthy()
    expect(fs.readFileSync(path.join(directory, retirementDirectory!, 'artifact'))).toEqual(
      replacement
    )
    expect(
      (JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as UsageRecord[]).map(
        (record) => record.id
      )
    ).toEqual(['journal'])
  })

  it('retains a lock replacement swapped after token and inode validation', () => {
    const preservedOriginalPath = path.join(directory, 'preserved-original-lock')
    const replacement = Buffer.from('replacement-lock-must-not-be-deleted', 'utf8')
    let swapped = false
    const store = createStore({
      beforeRetireRename: (filePath) => {
        if (swapped || filePath !== `${journalPath}.lock`) return
        swapped = true
        fs.renameSync(filePath, preservedOriginalPath)
        fs.writeFileSync(filePath, replacement)
      }
    })

    store.append(usageRecord('journal', now))

    expect(swapped).toBe(true)
    expect(fs.existsSync(preservedOriginalPath)).toBe(true)
    const retirementDirectory = fs.readdirSync(directory).find((name) => name.includes('.retire-'))
    expect(retirementDirectory).toBeTruthy()
    expect(fs.readFileSync(path.join(directory, retirementDirectory!, 'artifact'))).toEqual(
      replacement
    )
    expect(fs.readFileSync(journalPath, 'utf8')).toContain('"id":"journal"')
  })

  it('strictly removes a scoped owner from checkpoint, live, claimed, spill, archive, and valid forensic copies', () => {
    const targetCheckpoint = ownedUsageRecord('target-checkpoint', now - 8, {
      chatId: 'chat-target',
      runId: 'run-target-checkpoint'
    })
    const siblingCheckpoint = ownedUsageRecord('sibling-checkpoint', now - 7, {
      workspaceId: 'workspace-sibling',
      chatId: 'chat-sibling',
      runId: 'run-sibling-checkpoint'
    })
    fs.writeFileSync(checkpointPath, JSON.stringify([targetCheckpoint, siblingCheckpoint]))
    const targetLive = ownedUsageRecord('target-live', now - 6, {
      chatId: 'chat-target',
      runId: 'run-target-live'
    })
    fs.writeFileSync(journalPath, `\n${JSON.stringify(targetLive)}`)
    const targetClaimed = ownedUsageRecord('target-claimed', now - 5, {
      chatId: 'chat-other',
      runId: 'run-target-alias'
    })
    const siblingClaimed = ownedUsageRecord('sibling-claimed', now - 4, {
      workspaceId: 'workspace-sibling',
      chatId: 'chat-sibling',
      runId: 'run-sibling-claimed'
    })
    fs.writeFileSync(
      `${journalPath}.claimed-crash`,
      `${JSON.stringify(targetClaimed)}\n${JSON.stringify(siblingClaimed)}\n`
    )
    const targetSpill = ownedUsageRecord('target-spill', now - 3, {
      chatId: 'chat-target',
      runId: 'run-target-spill'
    })
    fs.writeFileSync(`${journalPath}.spill-crash`, `${JSON.stringify(targetSpill)}\n`)
    const targetArchive = ownedUsageRecord('target-archive', now - 2, {
      chatId: 'chat-target',
      runId: 'run-target-archive'
    })
    const siblingArchive = ownedUsageRecord('sibling-archive', now - 1, {
      workspaceId: 'workspace-sibling',
      chatId: 'chat-sibling',
      runId: 'run-sibling-archive'
    })
    fs.writeFileSync(
      archivePath,
      `${JSON.stringify(targetArchive)}\n${JSON.stringify(siblingArchive)}\n`
    )
    const quarantinePath = `${journalPath}.quarantine-${'a'.repeat(64)}.jsonl`
    fs.writeFileSync(
      quarantinePath,
      `${JSON.stringify(targetArchive)}\n${JSON.stringify(siblingArchive)}\n`
    )
    const corruptCheckpointPath = `${checkpointPath}.corrupt-${now}-${'b'.repeat(64)}`
    fs.writeFileSync(corruptCheckpointPath, JSON.stringify([targetCheckpoint, siblingCheckpoint]))
    const store = createStore()
    const hold = store.beginHistoryMutation({
      operationId: 'delete-chat-target',
      kind: 'chat',
      chatIds: ['chat-target'],
      runIds: ['run-target-alias']
    })

    expect(() =>
      store.append(
        ownedUsageRecord('late-target', now, {
          chatId: 'chat-target',
          runId: 'late-target-run'
        })
      )
    ).toThrow('Usage append is blocked')
    expect(store.getRecords().map((record) => record.id)).toEqual([
      'sibling-checkpoint',
      'sibling-claimed'
    ])

    const report = store.purgeHistoryStrict(hold)
    expect(report.removedRecords).toBeGreaterThanOrEqual(7)
    expect(store.endHistoryMutation(hold)).toBe(true)
    expect(store.getRecords().map((record) => record.id)).toEqual([
      'sibling-checkpoint',
      'sibling-claimed'
    ])
    expect(fs.existsSync(quarantinePath)).toBe(false)
    expect(fs.existsSync(corruptCheckpointPath)).toBe(false)
    const rewrittenQuarantine = fs
      .readdirSync(directory)
      .find((name) => name.startsWith('usage-journal.jsonl.quarantine-'))
    const rewrittenCorruptCheckpoint = fs
      .readdirSync(directory)
      .find((name) => name.startsWith(`usage.json.corrupt-${now}-`))
    expect(rewrittenQuarantine).toBeTruthy()
    expect(rewrittenCorruptCheckpoint).toBeTruthy()
    for (const filePath of [archivePath, path.join(directory, rewrittenQuarantine!)]) {
      const text = fs.readFileSync(filePath, 'utf8')
      expect(text).not.toContain('target-')
      expect(text).not.toContain('prompt-target')
      expect(text).toContain('sibling-archive')
    }
    const preservedForensic = JSON.parse(
      fs.readFileSync(path.join(directory, rewrittenCorruptCheckpoint!), 'utf8')
    ) as UsageRecord[]
    expect(preservedForensic.map((record) => record.id)).toEqual(['sibling-checkpoint'])
    expect(fs.existsSync(`${journalPath}.history-mutation-v1.json`)).toBe(false)
  })

  it('purges workspace-owned rows even when chat/run ids are absent and preserves siblings', () => {
    const target = ownedUsageRecord('workspace-target', now - 1, {
      workspaceId: 'workspace-target',
      chatId: 'legacy-chat',
      runId: 'legacy-run'
    })
    const sibling = ownedUsageRecord('workspace-sibling', now, {
      workspaceId: 'workspace-sibling',
      chatId: 'sibling-chat',
      runId: 'sibling-run'
    })
    fs.writeFileSync(checkpointPath, JSON.stringify([target, sibling]))
    const store = createStore()
    const hold = store.beginHistoryMutation({
      operationId: 'delete-workspace-target',
      kind: 'workspace',
      workspaceId: 'workspace-target',
      chatIds: [],
      runIds: []
    })

    store.purgeHistoryStrict(hold)
    expect(store.endHistoryMutation(hold)).toBe(true)

    expect(store.getRecords().map((record) => record.id)).toEqual(['workspace-sibling'])
  })

  it('migrates exact legacy corrupt-checkpoint backups while removing scoped rows', () => {
    const target = ownedUsageRecord('legacy-forensic-target', now - 1, {
      chatId: 'chat-target',
      runId: 'run-target'
    })
    const sibling = ownedUsageRecord('legacy-forensic-sibling', now, {
      workspaceId: 'workspace-sibling',
      chatId: 'chat-sibling',
      runId: 'run-sibling'
    })
    const legacyPath = `${checkpointPath}.corrupt-${now}`
    fs.writeFileSync(legacyPath, JSON.stringify([target, sibling]))
    const store = createStore()
    const hold = store.beginHistoryMutation({
      operationId: 'delete-legacy-forensic-target',
      kind: 'chat',
      chatIds: ['chat-target'],
      runIds: []
    })

    store.purgeHistoryStrict(hold)
    expect(store.endHistoryMutation(hold)).toBe(true)

    expect(fs.existsSync(legacyPath)).toBe(false)
    const replacements = fs
      .readdirSync(directory)
      .filter((name) => new RegExp(`^usage\\.json\\.corrupt-${now}-[0-9a-f]{64}$`).test(name))
    expect(replacements).toHaveLength(1)
    expect(
      (
        JSON.parse(fs.readFileSync(path.join(directory, replacements[0]), 'utf8')) as UsageRecord[]
      ).map((record) => record.id)
    ).toEqual(['legacy-forensic-sibling'])
  })

  it('globally removes managed usage artifacts including malformed forensic copies', () => {
    fs.writeFileSync(checkpointPath, JSON.stringify([usageRecord('checkpoint', now)]))
    fs.writeFileSync(journalPath, '{"id":"torn"')
    fs.writeFileSync(`${journalPath}.claimed-crash`, 'malformed claimed bytes')
    fs.writeFileSync(`${journalPath}.spill-crash`, 'malformed spill bytes')
    fs.writeFileSync(archivePath, 'malformed archive bytes')
    fs.writeFileSync(`${journalPath}.quarantine-${'a'.repeat(64)}.jsonl`, 'raw prompt secret')
    fs.writeFileSync(`${checkpointPath}.corrupt-${now}-${'b'.repeat(64)}`, 'raw response secret')
    const legacyCorruptPath = `${checkpointPath}.corrupt-${now + 1}`
    const legacyTempPath = `${checkpointPath}.1234.${now}.tmp`
    fs.writeFileSync(legacyCorruptPath, 'legacy raw response secret')
    fs.writeFileSync(legacyTempPath, 'legacy uncommitted prompt secret')
    fs.writeFileSync(
      `${journalPath}.spill-1-deadbeef.1.123e4567-e89b-12d3-a456-426614174000.tmp`,
      'uncommitted prompt secret'
    )
    const store = createStore()
    const hold = store.beginHistoryMutation({
      operationId: 'delete-all-usage',
      kind: 'global',
      chatIds: [],
      runIds: []
    })

    expect(() => store.append(usageRecord('late', now + 1))).toThrow('Usage append is blocked')
    store.purgeHistoryStrict(hold)
    expect(store.endHistoryMutation(hold)).toBe(true)

    expect(
      fs
        .readdirSync(directory)
        .filter(
          (name) =>
            name === 'usage.json' ||
            name === 'usage-archive.jsonl' ||
            name.startsWith('usage-journal.jsonl') ||
            name.startsWith('usage.json.corrupt-')
        )
    ).toEqual([])
    expect(fs.existsSync(legacyCorruptPath)).toBe(false)
    expect(fs.existsSync(legacyTempPath)).toBe(false)
    expect(store.getRecords()).toEqual([])
  })

  it.each(['checkpoint', 'journals', 'archive', 'verified', 'completed'] as const)(
    'recovers idempotently after a crash at the %s purge boundary',
    (crashStep) => {
      const target = ownedUsageRecord(`target-${crashStep}`, now - 1, {
        chatId: 'chat-target',
        runId: `run-target-${crashStep}`
      })
      const sibling = ownedUsageRecord(`sibling-${crashStep}`, now, {
        workspaceId: 'workspace-sibling',
        chatId: 'chat-sibling',
        runId: `run-sibling-${crashStep}`
      })
      fs.writeFileSync(checkpointPath, JSON.stringify([target, sibling]))
      fs.writeFileSync(journalPath, `${JSON.stringify(target)}\n${JSON.stringify(sibling)}\n`)
      fs.writeFileSync(archivePath, `${JSON.stringify(target)}\n${JSON.stringify(sibling)}\n`)
      let crashed = false
      const first = createStore({
        afterHistoryMutationStep: (step) => {
          if (!crashed && step === crashStep) {
            crashed = true
            throw new Error(`simulated crash after ${step}`)
          }
        }
      })
      const firstHold = first.beginHistoryMutation({
        operationId: `crash-${crashStep}`,
        kind: 'chat',
        chatIds: ['chat-target'],
        runIds: []
      })

      expect(() => first.purgeHistoryStrict(firstHold)).toThrow(
        `simulated crash after ${crashStep}`
      )
      first.dispose()

      const restarted = createStore()
      const recovered = restarted.recoverPendingHistoryMutationStrict()
      expect(recovered).not.toBeNull()
      expect(restarted.getRecords().map((record) => record.id)).toEqual([`sibling-${crashStep}`])
      expect(fs.readFileSync(archivePath, 'utf8')).not.toContain(`target-${crashStep}`)
      expect(fs.existsSync(`${journalPath}.history-mutation-v1.json`)).toBe(false)
    },
    30_000
  )

  it('recovers bytes isolated by a crash after the retirement rename', () => {
    const target = ownedUsageRecord('retirement-crash-target', now, {
      chatId: 'chat-target',
      runId: 'run-target'
    })
    fs.writeFileSync(checkpointPath, JSON.stringify([target]))
    let crashed = false
    const first = createStore({
      afterRetireRename: (filePath) => {
        if (!crashed && filePath === checkpointPath) {
          crashed = true
          throw new Error('simulated crash after retirement rename')
        }
      }
    })
    const hold = first.beginHistoryMutation({
      operationId: 'retirement-rename-crash',
      kind: 'global',
      chatIds: [],
      runIds: []
    })

    expect(() => first.purgeHistoryStrict(hold)).toThrow('simulated crash after retirement rename')
    expect(fs.existsSync(checkpointPath)).toBe(false)
    expect(fs.readdirSync(directory).some((name) => name.startsWith('.usage.json.retire-'))).toBe(
      true
    )
    first.dispose()

    const restarted = createStore()
    expect(restarted.recoverPendingHistoryMutationStrict()).not.toBeNull()
    expect(fs.readdirSync(directory).some((name) => name.startsWith('.usage.json.retire-'))).toBe(
      false
    )
    expect(fs.existsSync(`${journalPath}.history-mutation-v1.json`)).toBe(false)
  })

  it('finishes an empty managed retirement left after unlink but before directory removal', () => {
    const retirementDirectory = path.join(
      directory,
      '.usage.json.retire-1234-123e4567-e89b-12d3-a456-426614174000'
    )
    fs.mkdirSync(retirementDirectory, { mode: 0o700 })

    createStore()

    expect(fs.existsSync(retirementDirectory)).toBe(false)
  })

  it('recovers a durable prepare whose caller crashed before receiving its hold', () => {
    const target = ownedUsageRecord('target-before-hold', now, {
      chatId: 'chat-target',
      runId: 'run-target'
    })
    fs.writeFileSync(checkpointPath, JSON.stringify([target]))
    let crashed = false
    const first = createStore({
      afterHistoryMutationStep: (step) => {
        if (!crashed && step === 'intent-prepared') {
          crashed = true
          throw new Error('simulated prepare crash')
        }
      }
    })

    expect(() =>
      first.beginHistoryMutation({
        operationId: 'crash-before-hold',
        kind: 'chat',
        chatIds: ['chat-target'],
        runIds: []
      })
    ).toThrow('simulated prepare crash')
    first.dispose()

    const restarted = createStore()
    expect(restarted.recoverPendingHistoryMutationStrict()).not.toBeNull()
    expect(restarted.getRecords()).toEqual([])
  })

  it('fails scoped deletion closed on unparseable forensic bytes and succeeds after remediation', () => {
    const target = ownedUsageRecord('target-forensic', now, {
      chatId: 'chat-target',
      runId: 'run-target'
    })
    fs.writeFileSync(checkpointPath, JSON.stringify([target]))
    const quarantinePath = `${journalPath}.quarantine-${'c'.repeat(64)}.jsonl`
    fs.writeFileSync(quarantinePath, 'raw prompt without provable ownership')
    const store = createStore()
    const hold = store.beginHistoryMutation({
      operationId: 'forensic-fail-closed',
      kind: 'chat',
      chatIds: ['chat-target'],
      runIds: []
    })

    expect(() => store.purgeHistoryStrict(hold)).toThrow()
    expect(fs.existsSync(`${journalPath}.history-mutation-v1.json`)).toBe(true)
    expect(() =>
      store.append(
        ownedUsageRecord('late-forensic', now + 1, {
          chatId: 'chat-target',
          runId: 'run-late'
        })
      )
    ).toThrow('Usage append is blocked')

    fs.unlinkSync(quarantinePath)
    store.purgeHistoryStrict(hold)
    expect(store.endHistoryMutation(hold)).toBe(true)
    expect(store.getRecords()).toEqual([])
  })

  it('fails scoped deletion closed on an unparseable legacy corrupt-checkpoint backup', () => {
    const legacyPath = `${checkpointPath}.corrupt-${now}`
    fs.writeFileSync(legacyPath, 'legacy prompt bytes without provable ownership')
    const store = createStore()
    const hold = store.beginHistoryMutation({
      operationId: 'legacy-forensic-fail-closed',
      kind: 'chat',
      chatIds: ['chat-target'],
      runIds: []
    })

    expect(() => store.purgeHistoryStrict(hold)).toThrow()
    expect(fs.existsSync(legacyPath)).toBe(true)
    expect(fs.existsSync(`${journalPath}.history-mutation-v1.json`)).toBe(true)

    fs.unlinkSync(legacyPath)
    store.purgeHistoryStrict(hold)
    expect(store.endHistoryMutation(hold)).toBe(true)
  })
})
