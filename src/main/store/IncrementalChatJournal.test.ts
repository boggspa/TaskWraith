import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import fsModule from 'fs'
import { syncBuiltinESMExports } from 'module'
import * as os from 'os'
import * as path from 'path'
import { deriveChatRecordMutation } from './ChatRecordMutation'
import {
  createIncrementalChatJournal,
  INCREMENTAL_CHAT_JOURNAL_ARTIFACT_SUFFIXES,
  MAX_PENDING_DEFERRED_FSYNCS,
  type IncrementalChatJournal
} from './IncrementalChatJournal'
import type { ChatRecord } from './types'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'log-incremental-chat-'

/** Remove, with all it holds, a folder made here by `mkdtempSync` with TEMPORARY_PREFIX. */
function removeTemporaryDirectory(directory: string): void {
  const temporary = os.tmpdir()
  const made = temporary + path.sep + TEMPORARY_PREFIX
  if (
    directory === temporary ||
    !directory.startsWith(made) ||
    directory.length <= made.length ||
    path.dirname(directory) !== temporary
  )
    throw new Error(`Refusing to remove ${directory}: not a folder this file made`)
  fs.rmSync(directory, { recursive: true, force: true })
}

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
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    nowMs = Date.parse('2026-08-16T00:00:00.000Z')
    journal = createIncrementalChatJournal(baseDir, { now: () => nowMs })
  })

  afterEach(() => {
    removeTemporaryDirectory(baseDir)
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

    it('acknowledges only fsyncs issued before the async durability barrier', async () => {
      const { journal: deferred, captured } = deferredJournal()
      const before = chat()
      const first = advance(before, 'first')
      deferred.initialize('chat-1', before)
      deferred.append(deriveChatRecordMutation(before, first), { durability: 'deferred' })
      let settled = false
      const barrier = deferred.awaitDeferredDurability!('chat-1').then(() => {
        settled = true
      })
      const second = advance(first, 'second')
      deferred.append(deriveChatRecordMutation(first, second), { durability: 'deferred' })
      await Promise.resolve()
      expect(settled).toBe(false)
      expect(deferred.stats().drainedDeferredFsyncs).toBe(0)
      captured[0].done(null)
      await barrier
      expect(settled).toBe(true)
      captured[1].done(null)
    })

    it('rejects an async durability barrier when its fsync fails', async () => {
      const { journal: deferred, captured } = deferredJournal()
      const before = chat()
      deferred.initialize('chat-1', before)
      deferred.append(deriveChatRecordMutation(before, advance(before, 'update')), {
        durability: 'deferred'
      })
      const barrier = deferred.awaitDeferredDurability!('chat-1')
      const assertion = expect(barrier).rejects.toThrow('flush failed')
      captured[0].done(new Error('flush failed'))
      await assertion
      await expect(deferred.awaitDeferredDurability!('chat-1')).rejects.toThrow('flush failed')
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

    it('falls back to a synchronous fsync once 64 deferred flushes are pending', () => {
      const { journal: deferred, captured } = deferredJournal()
      let current = chat()
      deferred.initialize('chat-1', current)
      for (let i = 0; i < MAX_PENDING_DEFERRED_FSYNCS; i += 1) {
        const next = advance(current, `streamed ${i}`)
        deferred.append(deriveChatRecordMutation(current, next), { durability: 'deferred' })
        current = next
      }
      expect(captured).toHaveLength(MAX_PENDING_DEFERRED_FSYNCS)
      expect(deferred.stats().deferredAppends).toBe(MAX_PENDING_DEFERRED_FSYNCS)

      const overflow = advance(current, 'saturated sync fallback')
      deferred.append(deriveChatRecordMutation(current, overflow), { durability: 'deferred' })
      expect(captured).toHaveLength(MAX_PENDING_DEFERRED_FSYNCS)
      expect(deferred.stats().deferredAppends).toBe(MAX_PENDING_DEFERRED_FSYNCS)
      expect(deferred.replay('chat-1').record).toEqual(overflow)

      for (const pending of captured) pending.done(null)
    })

    it('replays D1 bytes after a restart even when the deferred fsync never completed', () => {
      const { journal: deferred, captured } = deferredJournal()
      const before = chat()
      const after = advance(before, 'unflushed stream')
      deferred.initialize('chat-1', before)
      deferred.append(deriveChatRecordMutation(before, after), { durability: 'deferred' })
      expect(captured).toHaveLength(1)

      const recovered = createIncrementalChatJournal(baseDir, { now: () => nowMs })
      expect(recovered.replay('chat-1').record).toEqual(after)
      captured[0].done(null)
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

  it('replays a long streaming tail across duplicate revisions without changing disk or later reads', () => {
    const before = chat('chat-1', 1, 'start')
    const batches = [] as ReturnType<typeof deriveChatRecordMutation>[]
    let expected = before
    for (let i = 0; i < 160; i += 1) {
      const next = advance(expected, `${expected.messages[0].content}.${i}`)
      batches.push(deriveChatRecordMutation(expected, next))
      expected = next
    }
    journal.initialize('chat-1', before)
    const tail = batches.flatMap((batch, index) => (index === 50 ? [batch, batch] : [batch]))
    fs.writeFileSync(
      path.join(baseDir, 'chat-1.mutations.jsonl'),
      tail.map((batch) => JSON.stringify(batch) + '\n').join('')
    )
    const diskBefore = snapshotTree(baseDir)
    const readOnly = createIncrementalChatJournal(baseDir, {
      canWrite: () => false,
      canRepairOnRead: () => false
    })

    const replayed = readOnly.replay('chat-1')
    expect(replayed).toMatchObject({ record: expected, appliedBatches: 160, skippedBatches: 1 })
    replayed.record!.messages[0].content = 'consumer edit'
    expect(readOnly.replay('chat-1').record).toEqual(expected)
    expect(snapshotTree(baseDir)).toEqual(diskBefore)
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

  it('durably replays the compact ensemble operations emitted by an authored save', () => {
    const before: ChatRecord = {
      ...chat(),
      ensemble: {
        enabled: true,
        maxParticipants: 1,
        maxContinuationHops: 6,
        participants: [
          {
            id: 'seat-1',
            provider: 'kimi',
            enabled: true,
            role: 'Worker',
            order: 1,
            instructions: ''
          }
        ]
      }
    }
    const after = advance(before, before.messages[0].content)
    after.ensemble!.maxContinuationHops = 12
    after.ensemble!.participants[0].linkedProviderSessionId = 'persisted-seat-session'
    const batch = deriveChatRecordMutation(before, after, {
      authoredTranscript: { operations: [], transcriptOps: [], changedMessageCount: 0 }
    })
    expect(batch.operations.map((operation) => operation.type)).toEqual(
      expect.arrayContaining(['ensemble_patch', 'ensemble_participant_patch'])
    )
    journal.initialize('chat-1', before)
    journal.append(batch)

    const reopened = createIncrementalChatJournal(baseDir, { now: () => nowMs })
    expect(reopened.replay('chat-1').record).toEqual(after)
    expect(reopened.checkpoint('chat-1', 'terminal')).toBe(true)
    expect(createIncrementalChatJournal(baseDir).replay('chat-1').record).toEqual(after)
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

  it('does not discover or decode cold historical journals in main maintenance mode', () => {
    const first = chat()
    journal.initialize('chat-1', first)
    journal.append(deriveChatRecordMutation(first, advance(first, 'unopened tail')))
    const cold = createIncrementalChatJournal(baseDir, {
      maintenanceScope: 'opened',
      now: () => nowMs + 60_000
    })
    const before = fs.readFileSync(path.join(baseDir, 'chat-1.mutations.jsonl'), 'utf8')
    expect(cold.checkpointIdle()).toBe(0)
    expect(cold.checkpointAll()).toBe(0)
    expect(cold.stats().replayedBatches).toBe(0)
    expect(fs.readFileSync(path.join(baseDir, 'chat-1.mutations.jsonl'), 'utf8')).toBe(before)
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

  describe('pendingReplayState (cheap replay probe)', () => {
    it('reports no tail and the checkpoint revision for a freshly folded chat', () => {
      const before = chat('chat-1', 1)
      journal.initialize('chat-1', before)
      // Checkpoint written, no mutations tail yet.
      expect(journal.pendingReplayState('chat-1')).toEqual({
        hasTail: false,
        checkpointRevision: 1
      })
    })

    it('reports a live tail while mutations sit unfolded, then clears once folded', () => {
      const before = chat('chat-1', 1)
      const after = advance(before, 'tail present')
      journal.initialize('chat-1', before)
      journal.append(deriveChatRecordMutation(before, after))
      expect(journal.pendingReplayState('chat-1').hasTail).toBe(true)

      expect(journal.checkpoint('chat-1', 'manual')).toBe(true)
      // Folded: tail gone, checkpoint now at the advanced revision.
      expect(journal.pendingReplayState('chat-1')).toEqual({
        hasTail: false,
        checkpointRevision: 2
      })
    })

    it('peeks the header revision without parsing the multi-message record', () => {
      // A record whose body carries its own `persistenceRevision` and even a
      // nested `revision`-shaped string must not fool the header peek.
      const before = chat('chat-1', 7)
      before.messages[0].content = '{"revision":999999}'
      journal.initialize('chat-1', before)
      expect(journal.pendingReplayState('chat-1').checkpointRevision).toBe(7)
    })

    it('never throws: unknown chat and unsafe id both fall back to a real replay', () => {
      expect(journal.pendingReplayState('unknown-chat')).toEqual({
        hasTail: false,
        checkpointRevision: null
      })
      // An unsafe id forces the replay path (hasTail true) rather than throwing.
      expect(journal.pendingReplayState('../escape')).toEqual({
        hasTail: true,
        checkpointRevision: null
      })
    })
  })

  it('keeps compacting healthy chats when one chat throws (idle sweep)', () => {
    // chat-bad is iterated FIRST (inserted first): under the old unguarded loop
    // its throw aborted the whole sweep and chat-good was never folded.
    const bad = chat('chat-bad', 1)
    const badNext = advance(bad, 'bad tail')
    const good = chat('chat-good', 1)
    const goodNext = advance(good, 'good tail')
    journal.initialize('chat-bad', bad)
    journal.append(deriveChatRecordMutation(bad, badNext))
    journal.initialize('chat-good', good)
    journal.append(deriveChatRecordMutation(good, goodNext))
    // Corrupt chat-bad's checkpoint on disk; checkpoint()'s own readCheckpoint
    // re-reads it and throws, exactly like a revision-gap chat at boot.
    fs.writeFileSync(path.join(baseDir, 'chat-bad.checkpoint.json'), '{ not valid json')

    nowMs += 1_000_000 // both idle-eligible
    expect(() => journal.checkpointIdle()).not.toThrow()
    // The healthy chat still folded despite the corrupt sibling ahead of it.
    expect(fs.existsSync(path.join(baseDir, 'chat-good.mutations.jsonl'))).toBe(false)
    expect(journal.replay('chat-good').record).toEqual(goodNext)
  })

  it('keeps compacting healthy chats when one chat throws (shutdown sweep)', () => {
    const bad = chat('chat-bad', 1)
    const badNext = advance(bad, 'bad tail')
    const good = chat('chat-good', 1)
    const goodNext = advance(good, 'good tail')
    journal.initialize('chat-bad', bad)
    journal.append(deriveChatRecordMutation(bad, badNext))
    journal.initialize('chat-good', good)
    journal.append(deriveChatRecordMutation(good, goodNext))
    fs.writeFileSync(path.join(baseDir, 'chat-bad.checkpoint.json'), '{ not valid json')

    // The corrupt chat is skipped, so the count is the ONE healthy fold — not a
    // thrown sweep that strands every later chat's journal.
    expect(journal.checkpointAll('shutdown')).toBe(1)
    expect(fs.existsSync(path.join(baseDir, 'chat-good.mutations.jsonl'))).toBe(false)
    expect(journal.replay('chat-good').record).toEqual(goodNext)
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

  describe('per-chat artifact list', () => {
    afterEach(() => {
      vi.restoreAllMocks()
      syncBuiltinESMExports()
    })

    // Loading a chat's state begins by probing its tombstone, so the probed
    // names are exactly the chats a sweep found in the directory.
    function chatsFoundBySweep(): string[] {
      const probed: string[] = []
      const realExists = fsModule.existsSync.bind(fsModule)
      vi.spyOn(fsModule, 'existsSync').mockImplementation((target) => {
        const name = path.basename(String(target))
        if (name.endsWith('.tombstone')) probed.push(name.slice(0, -'.tombstone'.length))
        return realExists(target)
      })
      syncBuiltinESMExports()
      const sweeper = createIncrementalChatJournal(baseDir, { now: () => nowMs })
      expect(sweeper.checkpointAll('shutdown')).toBe(0)
      return probed.sort()
    }

    it('finds a chat from any one of its journal files and ignores every other name', () => {
      journal.initialize('by-checkpoint', chat('by-checkpoint'))
      fs.writeFileSync(path.join(baseDir, 'by-sealed.sealed.mutations.jsonl'), '')
      fs.writeFileSync(path.join(baseDir, 'by-active.mutations.jsonl'), '')
      fs.writeFileSync(path.join(baseDir, 'by-tombstone.tombstone'), '')
      for (const ignored of [
        '.temp.checkpoint.json.1234.0.tmp',
        'legacy.jsonl',
        'has.dot.checkpoint.json',
        'backup.sealed.mutations.jsonl.bak',
        'notes.txt'
      ]) {
        fs.writeFileSync(path.join(baseDir, ignored), '')
      }

      expect(chatsFoundBySweep()).toEqual([
        'by-active',
        'by-checkpoint',
        'by-sealed',
        'by-tombstone'
      ])
    })

    it('purges and tombstones through every listed artifact', () => {
      const ownFiles = (chatId: string): string[] =>
        fs
          .readdirSync(baseDir)
          .filter((name) => name.startsWith(`${chatId}.`))
          .sort()
      for (const chatId of ['purged', 'deleted']) {
        for (const suffix of INCREMENTAL_CHAT_JOURNAL_ARTIFACT_SUFFIXES) {
          fs.writeFileSync(path.join(baseDir, `${chatId}${suffix}`), '')
        }
        expect(ownFiles(chatId)).toHaveLength(INCREMENTAL_CHAT_JOURNAL_ARTIFACT_SUFFIXES.length)
      }

      journal.purge('purged')
      journal.delete('deleted')

      expect(ownFiles('purged')).toEqual([])
      expect(ownFiles('deleted')).toEqual(['deleted.tombstone'])
    })
  })

  describe('journal file creation durability', () => {
    // Each fsync this journal issues, in order: the file's path, or `baseDir`
    // for a directory fsync. A file's name is durable only once its directory
    // is fsynced, so an acknowledged append must not outrun that.
    function recordFsyncs(): string[] {
      const pathByFd = new Map<number, string>()
      const realOpen = fsModule.openSync.bind(fsModule)
      const realFsync = fsModule.fsyncSync.bind(fsModule)
      vi.spyOn(fsModule, 'openSync').mockImplementation(((
        ...args: Parameters<typeof fs.openSync>
      ) => {
        const fd = realOpen(...args)
        pathByFd.set(fd, String(args[0]))
        return fd
      }) as typeof fs.openSync)
      const fsyncs: string[] = []
      vi.spyOn(fsModule, 'fsyncSync').mockImplementation((fd) => {
        fsyncs.push(pathByFd.get(fd) ?? `fd:${fd}`)
        realFsync(fd)
      })
      // The journal reads `fs` as a namespace; push the spies through to it.
      syncBuiltinESMExports()
      return fsyncs
    }

    afterEach(() => {
      vi.restoreAllMocks()
      syncBuiltinESMExports()
    })

    it('makes a created journal file name durable before a synchronous append returns', () => {
      const before = chat()
      journal.initialize('chat-1', before)
      const journalFile = path.join(baseDir, 'chat-1.mutations.jsonl')
      expect(fs.existsSync(journalFile)).toBe(false)

      const fsyncs = recordFsyncs()
      journal.append(deriveChatRecordMutation(before, advance(before, 'acknowledged')))

      expect(fsyncs).toEqual([journalFile, baseDir])
    })

    it('makes the name durable again when an append recreates the journal after a checkpoint', () => {
      const before = chat()
      const middle = advance(before, 'first')
      journal.initialize('chat-1', before)
      journal.append(deriveChatRecordMutation(before, middle))
      journal.checkpoint('chat-1', 'manual')
      const journalFile = path.join(baseDir, 'chat-1.mutations.jsonl')
      expect(fs.existsSync(journalFile)).toBe(false)

      const fsyncs = recordFsyncs()
      journal.append(deriveChatRecordMutation(middle, advance(middle, 'after checkpoint')))

      expect(fsyncs).toEqual([journalFile, baseDir])
    })

    it('fsyncs the directory synchronously when a deferred append creates the journal', () => {
      const captured: number[] = []
      const deferred = createIncrementalChatJournal(baseDir, {
        now: () => nowMs,
        scheduleFsync: (fd, done) => {
          captured.push(fd)
          done(null)
        }
      })
      const before = chat()
      deferred.initialize('chat-1', before)

      const fsyncs = recordFsyncs()
      deferred.append(deriveChatRecordMutation(before, advance(before, 'streamed')), {
        durability: 'deferred'
      })

      // The file's own flush stays with the scheduler; only its name is made
      // durable inline, once, at creation.
      expect(captured).toHaveLength(1)
      expect(fsyncs).toEqual([baseDir])
    })

    it('leaves the directory alone for an append to an existing journal file', () => {
      const before = chat()
      const middle = advance(before, 'first')
      journal.initialize('chat-1', before)
      journal.append(deriveChatRecordMutation(before, middle))
      const journalFile = path.join(baseDir, 'chat-1.mutations.jsonl')

      const fsyncs = recordFsyncs()
      journal.append(deriveChatRecordMutation(middle, advance(middle, 'second')))

      expect(fsyncs).toEqual([journalFile])
    })
  })
})
