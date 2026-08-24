import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { deriveChatRecordMutation } from './ChatRecordMutation'
import { createIncrementalChatJournal, type IncrementalChatJournal } from './IncrementalChatJournal'
import type { ChatRecord } from './types'

function chat(chatId = 'chat-1', revision = 1, content = 'initial'): ChatRecord {
  return {
    appChatId: chatId,
    title: chatId,
    createdAt: 1,
    updatedAt: revision,
    archived: false,
    persistenceRevision: revision,
    messages: [
      {
        id: `${chatId}-message`,
        role: 'assistant',
        content,
        timestamp: '2026-08-16T00:00:00.000Z'
      }
    ],
    runs: []
  }
}

function advance(source: ChatRecord, content: string): ChatRecord {
  const next = structuredClone(source)
  next.messages[0].content = content
  next.persistenceRevision = (source.persistenceRevision ?? 0) + 1
  next.updatedAt += 1
  return next
}

function snapshotTree(root: string): unknown[] {
  const rows: unknown[] = []
  const visit = (current: string): void => {
    if (!fs.existsSync(current)) return
    const stat = fs.lstatSync(current)
    rows.push({
      relative: path.relative(root, current) || '.',
      kind: stat.isDirectory() ? 'directory' : 'file',
      mode: stat.mode,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ...(stat.isFile() ? { contents: fs.readFileSync(current).toString('base64') } : {})
    })
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current).sort()) visit(path.join(current, entry))
    }
  }
  visit(root)
  return rows
}

describe('IncrementalChatJournal', () => {
  it('does not create a missing directory when dynamic write authority is false', () => {
    const baseDir = path.join(os.tmpdir(), `incremental-chat-readonly-${Date.now()}`)
    const journal = createIncrementalChatJournal(baseDir, { canWrite: () => false })
    expect(journal.replay('chat-1')).toMatchObject({ record: null })
    expect(fs.existsSync(baseDir)).toBe(false)
    expect(() => journal.clear()).toThrow('read-only')
  })

  it('replays a torn valid prefix without repair and rejects every mutator before side effects', () => {
    const before = chat()
    const after = advance(before, 'complete mutation')
    const batch = deriveChatRecordMutation(before, after)
    journal.initialize('chat-1', before)
    journal.append(batch)
    fs.appendFileSync(path.join(baseDir, 'chat-1.mutations.jsonl'), '{"torn":')
    const treeBefore = snapshotTree(baseDir)
    const readOnly = createIncrementalChatJournal(baseDir, { canWrite: () => false })

    expect(readOnly.replay('chat-1')).toMatchObject({
      record: after,
      recoveredTornTail: false
    })
    for (const mutate of [
      () => readOnly.initialize('chat-1', before),
      () => readOnly.append(batch),
      () => readOnly.replaceAuthoritativeCheckpoint('chat-1', after),
      () => readOnly.checkpoint('chat-1', 'manual'),
      () => readOnly.checkpointIdle(),
      () => readOnly.checkpointAll(),
      () => readOnly.drainDeferredDurability(),
      () => readOnly.delete('chat-1'),
      () => readOnly.purge('chat-1'),
      () => readOnly.clear()
    ]) {
      expect(mutate).toThrow('read-only')
    }
    expect(snapshotTree(baseDir)).toEqual(treeBefore)
  })
  let baseDir: string
  let journal: IncrementalChatJournal
  let nowMs: number

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-incremental-chat-'))
    nowMs = Date.parse('2026-08-16T00:00:00.000Z')
    journal = createIncrementalChatJournal(baseDir, { now: () => nowMs })
  })

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true })
  })

  describe('deferred durability (D1 streaming appends)', () => {
    interface CapturedFsync {
      fd: number
      done: (error?: NodeJS.ErrnoException | null) => void
    }

    function deferredJournal(): { journal: IncrementalChatJournal; captured: CapturedFsync[] } {
      const captured: CapturedFsync[] = []
      const instance = createIncrementalChatJournal(baseDir, {
        now: () => nowMs,
        scheduleFsync: (fd, done) => {
          captured.push({ fd, done })
        }
      })
      return { journal: instance, captured }
    }

    it('writes the bytes immediately but leaves the fsync to the scheduler', () => {
      const { journal: deferred, captured } = deferredJournal()
      const before = chat()
      const after = advance(before, 'initial streamed')
      deferred.initialize('chat-1', before)
      deferred.append(deriveChatRecordMutation(before, after), { durability: 'deferred' })

      // The write is visible to replay before the flush lands…
      expect(deferred.replay('chat-1').record).toEqual(after)
      // …and exactly one fsync was scheduled instead of blocking the caller.
      expect(captured).toHaveLength(1)
      expect(deferred.stats()).toMatchObject({ deferredAppends: 1, deferredFsyncFailures: 0 })
      captured[0].done(null)
    })

    it('keeps default appends synchronously fsynced', () => {
      const { journal: deferred, captured } = deferredJournal()
      const before = chat()
      deferred.initialize('chat-1', before)
      deferred.append(deriveChatRecordMutation(before, advance(before, 'barrier state')))

      expect(captured).toHaveLength(0)
      expect(deferred.stats().deferredAppends).toBe(0)
    })

    it('drains pending deferred flushes on demand', () => {
      const { journal: deferred, captured } = deferredJournal()
      const before = chat()
      const after = advance(before, 'streamed')
      deferred.initialize('chat-1', before)
      deferred.append(deriveChatRecordMutation(before, after), { durability: 'deferred' })
      expect(captured).toHaveLength(1)

      expect(deferred.drainDeferredDurability()).toBe(1)
      // Draining again with nothing pending is a no-op.
      expect(deferred.drainDeferredDurability()).toBe(0)
      captured[0].done(null)
      expect(deferred.stats().drainedDeferredFsyncs).toBe(1)
    })

    it('escalates the next append to a synchronous fsync after a deferred failure', () => {
      const { journal: deferred, captured } = deferredJournal()
      const before = chat()
      const second = advance(before, 'streamed one')
      const third = advance(second, 'streamed one two')
      const fourth = advance(third, 'streamed one two three')
      deferred.initialize('chat-1', before)
      deferred.append(deriveChatRecordMutation(before, second), { durability: 'deferred' })
      expect(captured).toHaveLength(1)
      captured[0].done(Object.assign(new Error('EIO'), { code: 'EIO' }))

      // The failure forces the NEXT deferred request through the sync path…
      deferred.append(deriveChatRecordMutation(second, third), { durability: 'deferred' })
      expect(captured).toHaveLength(1)
      expect(deferred.stats().deferredFsyncFailures).toBe(1)
      // …and once that sync write lands, deferral resumes.
      deferred.append(deriveChatRecordMutation(third, fourth), { durability: 'deferred' })
      expect(captured).toHaveLength(2)
      captured[1].done(null)
    })

    it('drains deferred flushes before a shutdown checkpoint', () => {
      const { journal: deferred, captured } = deferredJournal()
      const before = chat()
      const after = advance(before, 'streamed')
      deferred.initialize('chat-1', before)
      deferred.append(deriveChatRecordMutation(before, after), { durability: 'deferred' })
      expect(captured).toHaveLength(1)

      expect(deferred.checkpointAll('shutdown')).toBe(1)
      expect(deferred.stats().drainedDeferredFsyncs).toBe(1)
      captured[0].done(null)
    })
  })

  it('appends mutation-only JSONL and replays exact state from the checkpoint', () => {
    const before = chat('chat-1', 1, 'x'.repeat(5_000))
    const after = advance(before, `${before.messages[0].content} plus a streamed suffix`)
    const batch = deriveChatRecordMutation(before, after)

    journal.initialize(before.appChatId, before)
    journal.append(batch)

    const journalPath = path.join(baseDir, 'chat-1.mutations.jsonl')
    const line = fs.readFileSync(journalPath, 'utf8')
    expect(line).not.toContain('"record"')
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThan(
      Buffer.byteLength(JSON.stringify(after), 'utf8')
    )
    expect(journal.replay('chat-1')).toMatchObject({
      record: after,
      revision: 2,
      appliedBatches: 1,
      skippedBatches: 0
    })
  })

  it('materializes a terminal checkpoint and removes the replayed tail', () => {
    const before = chat()
    const after = advance(before, 'terminal result')
    journal.initialize('chat-1', before)
    journal.append(deriveChatRecordMutation(before, after))

    expect(journal.checkpoint('chat-1', 'terminal')).toBe(true)

    expect(fs.existsSync(path.join(baseDir, 'chat-1.mutations.jsonl'))).toBe(false)
    const checkpoint = JSON.parse(
      fs.readFileSync(path.join(baseDir, 'chat-1.checkpoint.json'), 'utf8')
    ) as { reason: string; revision: number; record: ChatRecord }
    expect(checkpoint).toMatchObject({ reason: 'terminal', revision: 2, record: after })
    expect(journal.replay('chat-1').record).toEqual(after)
  })

  it('replays once across a crash after checkpoint rename but before tail removal', () => {
    const before = chat()
    const after = advance(before, 'survives checkpoint crash window')
    let simulateCrash = true
    const crashing = createIncrementalChatJournal(baseDir, {
      now: () => nowMs,
      afterCheckpointWrite: () => {
        if (simulateCrash) throw new Error('simulated process loss')
      }
    })
    crashing.initialize('chat-1', before)
    crashing.append(deriveChatRecordMutation(before, after))

    expect(() => crashing.checkpoint('chat-1', 'terminal')).toThrow(/simulated process loss/)
    expect(fs.existsSync(path.join(baseDir, 'chat-1.checkpoint.json'))).toBe(true)
    expect(fs.existsSync(path.join(baseDir, 'chat-1.mutations.jsonl'))).toBe(true)

    simulateCrash = false
    const recovered = createIncrementalChatJournal(baseDir, { now: () => nowMs })
    const replayed = recovered.replay('chat-1')
    expect(replayed.record).toEqual(after)
    expect(replayed.appliedBatches).toBe(0)
    expect(replayed.skippedBatches).toBe(1)
    expect(recovered.checkpoint('chat-1', 'recovery')).toBe(true)
    expect(fs.existsSync(path.join(baseDir, 'chat-1.mutations.jsonl'))).toBe(false)
  })

  it('truncates a torn tail to the last fsynced complete mutation', () => {
    const before = chat()
    const after = advance(before, 'complete mutation')
    journal.initialize('chat-1', before)
    journal.append(deriveChatRecordMutation(before, after))
    const journalPath = path.join(baseDir, 'chat-1.mutations.jsonl')
    fs.appendFileSync(journalPath, '{"format":"taskwraith-chat-mutation"')

    const recovered = createIncrementalChatJournal(baseDir, { now: () => nowMs })
    expect(recovered.replay('chat-1').record).toEqual(after)
    expect(recovered.stats().tornTailsRecovered).toBe(1)
    const repaired = fs.readFileSync(journalPath, 'utf8')
    expect(repaired.endsWith('\n')).toBe(true)
    expect(repaired).not.toContain('{"format":"taskwraith-chat-mutation"\n{"format"')
  })

  it('rejects a revision gap before it reaches disk', () => {
    const before = chat()
    const after = advance(before, 'next')
    const batch = deriveChatRecordMutation(before, after)
    journal.initialize('chat-1', before)

    expect(() => journal.append({ ...batch, baseRevision: 7, revision: 8 })).toThrow(
      /revision mismatch/
    )
    expect(fs.existsSync(path.join(baseDir, 'chat-1.mutations.jsonl'))).toBe(false)
  })

  it('rejects an unknown mutation operation before advancing the journal', () => {
    const before = chat()
    const after = advance(before, 'next')
    const batch = deriveChatRecordMutation(before, after)
    journal.initialize('chat-1', before)

    expect(() =>
      journal.append({
        ...batch,
        operations: [{ type: 'future_unknown_operation' }] as unknown as typeof batch.operations
      })
    ).toThrow(/Invalid chat mutation batch/)
    expect(journal.replay('chat-1').record).toEqual(before)
  })

  it('checkpoints after a bounded idle interval', () => {
    journal = createIncrementalChatJournal(baseDir, {
      now: () => nowMs,
      idleCheckpointMs: 100,
      maxUncheckpointedMs: 1_000
    })
    const before = chat()
    const after = advance(before, 'idle tail')
    journal.initialize('chat-1', before)
    journal.append(deriveChatRecordMutation(before, after))

    nowMs += 99
    expect(journal.checkpointIdle()).toBe(0)
    nowMs += 1
    expect(journal.checkpointIdle()).toBe(1)
    expect(fs.existsSync(path.join(baseDir, 'chat-1.mutations.jsonl'))).toBe(false)
    expect(journal.replay('chat-1').record).toEqual(after)
  })

  it('forces a bounded checkpoint during continuously busy mutation traffic', () => {
    journal = createIncrementalChatJournal(baseDir, {
      now: () => nowMs,
      maxJournalEntries: 2,
      maxUncheckpointedMs: 60_000
    })
    const first = chat()
    const second = advance(first, 'second')
    const third = advance(second, 'third')
    journal.initialize('chat-1', first)
    journal.append(deriveChatRecordMutation(first, second))
    journal.append(deriveChatRecordMutation(second, third))

    expect(fs.existsSync(path.join(baseDir, 'chat-1.mutations.jsonl'))).toBe(false)
    expect(journal.replay('chat-1').record).toEqual(third)
    expect(journal.stats().checkpointsWritten).toBe(2)
  })

  it('checkpoints every dirty chat at shutdown', () => {
    const first = chat('chat-1')
    const second = chat('chat-2')
    const firstNext = advance(first, 'one done')
    const secondNext = advance(second, 'two done')
    journal.initialize('chat-1', first)
    journal.initialize('chat-2', second)
    journal.append(deriveChatRecordMutation(first, firstNext))
    journal.append(deriveChatRecordMutation(second, secondNext))

    expect(journal.checkpointAll('shutdown')).toBe(2)
    expect(journal.replay('chat-1').record).toEqual(firstNext)
    expect(journal.replay('chat-2').record).toEqual(secondNext)
  })

  it('keeps deletion tombstoned against late mutation appends', () => {
    const before = chat()
    const after = advance(before, 'late')
    journal.initialize('chat-1', before)
    journal.delete('chat-1')

    expect(journal.replay('chat-1').record).toBeNull()
    expect(() => journal.append(deriveChatRecordMutation(before, after))).toThrow(/tombstoned/)
    expect(journal.stats().tombstoneRejects).toBe(1)
  })

  it('restores the head revision after restart before accepting the next batch', () => {
    const first = chat()
    const second = advance(first, 'second')
    const third = advance(second, 'third')
    journal.initialize('chat-1', first)
    journal.append(deriveChatRecordMutation(first, second))

    const restarted = createIncrementalChatJournal(baseDir, { now: () => nowMs })
    restarted.append(deriveChatRecordMutation(second, third))

    expect(restarted.replay('chat-1').record).toEqual(third)
  })

  it('can replace a drifted side-band baseline from the still-authoritative record', () => {
    const first = chat()
    const second = advance(first, 'journal ahead')
    const authoritative = advance(second, 'authoritative recovery')
    journal.initialize('chat-1', first)
    journal.append(deriveChatRecordMutation(first, second))

    journal.replaceAuthoritativeCheckpoint('chat-1', authoritative)

    expect(journal.replay('chat-1').record).toEqual(authoritative)
    expect(fs.existsSync(path.join(baseDir, 'chat-1.mutations.jsonl'))).toBe(false)
  })

  it('purges one chat or clears the flat journal directory without recursive deletion', () => {
    const first = chat('chat-1')
    const second = chat('chat-2')
    journal.initialize('chat-1', first)
    journal.initialize('chat-2', second)

    journal.purge('chat-1')
    expect(fs.readdirSync(baseDir).some((name) => name.startsWith('chat-1.'))).toBe(false)
    expect(fs.readdirSync(baseDir).some((name) => name.startsWith('chat-2.'))).toBe(true)

    journal.clear()
    expect(fs.existsSync(baseDir)).toBe(false)
  })
})
