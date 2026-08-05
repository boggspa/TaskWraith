import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createChatJournal, type ChatJournal, type ChatJournalEntry } from './chatJournal'

describe('ChatJournal', () => {
  let baseDir: string
  let journal: ChatJournal
  const now = Date.parse('2026-08-04T00:00:00.000Z')

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /** Monotonic counter so comparisons across calls produce equal records. */
  let recordSeq = 0

  function chatRecord(id: string, content: string, ts?: number): Record<string, unknown> {
    return {
      id,
      messages: [{ role: 'user', content }],
      updatedAt: ts ?? now + recordSeq++
    }
  }

  function journalContent(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf-8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  function journalEntries(filePath: string): ChatJournalEntry[] {
    const content = journalContent(filePath)
    if (!content) return []
    return content
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ChatJournalEntry)
  }

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-chat-journal-'))
    journal = createChatJournal(baseDir)
    recordSeq = 0
  })

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true })
  })

  // -----------------------------------------------------------------------
  // Basic append + read
  // -----------------------------------------------------------------------

  it('appends one line to the journal and reads it back', () => {
    const record = chatRecord('chat-1', 'hello')
    journal.append('chat-1', record)

    const result = journal.read('chat-1')
    expect(result.snapshot).toBeNull()
    expect(result.tail).toHaveLength(1)
    expect(result.tail[0].record).toEqual(record)
  })

  it('appends multiple lines for one chat and reads them in order', () => {
    const r1 = chatRecord('chat-1', 'first')
    const r2 = chatRecord('chat-1', 'second')
    const r3 = chatRecord('chat-1', 'third')

    journal.append('chat-1', r1)
    journal.append('chat-1', r2)
    journal.append('chat-1', r3)

    const result = journal.read('chat-1')
    expect(result.tail).toHaveLength(3)
    expect(result.tail[0].record).toEqual(r1)
    expect(result.tail[1].record).toEqual(r2)
    expect(result.tail[2].record).toEqual(r3)
  })

  it('writes each line as a valid JSON object on its own line', () => {
    journal.append('chat-a', chatRecord('chat-a', 'msg'))

    const lines = journalContent(path.join(baseDir, 'chat-a.jsonl'))!.split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]) as ChatJournalEntry
    expect(parsed).toHaveProperty('savedAt')
    expect(parsed).toHaveProperty('record')
    expect(parsed.record).toHaveProperty('id', 'chat-a')
  })

  it('records a savedAt ISO timestamp on every entry', () => {
    journal.append('chat-ts', chatRecord('chat-ts', 'x'))

    const entries = journalEntries(path.join(baseDir, 'chat-ts.jsonl'))
    expect(entries).toHaveLength(1)
    const parsed = Date.parse(entries[0].savedAt)
    expect(Number.isNaN(parsed)).toBe(false)
  })

  // -----------------------------------------------------------------------
  // GATE 1 — Torn-append recovery
  // -----------------------------------------------------------------------

  it('recovers a journal with a torn tail by truncating to the last valid line', () => {
    const r1 = chatRecord('chat-recover', 'first')
    const r2 = chatRecord('chat-recover', 'second')

    // Write r1 via the journal, then manually append r2 and a torn tail
    journal.append('chat-recover', r1)

    const jPath = path.join(baseDir, 'chat-recover.jsonl')
    fs.appendFileSync(
      jPath,
      JSON.stringify({
        savedAt: '2026-08-04T00:00:01.000Z',
        record: r2
      }) + '\n'
    )
    // Torn partial line
    fs.appendFileSync(jPath, '{"savedAt":"2026-08-04T00:00:02.000Z","record":{"id":"torn')

    // Re-create — initDirectory must truncate the torn tail
    const recovered = createChatJournal(baseDir)
    const result = recovered.read('chat-recover')
    expect(result.tail).toHaveLength(2)

    // Journal file must be clean
    const lines = journalContent(jPath)!.split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    const entries = journalEntries(jPath)
    expect(entries).toHaveLength(2)
  })

  it('removes a journal that is entirely corrupt (no valid lines)', () => {
    const jPath = path.join(baseDir, 'chat-all-corrupt.jsonl')
    fs.writeFileSync(jPath, '{torn\nalso-torn\n', 'utf-8')

    const recovered = createChatJournal(baseDir)
    expect(fs.existsSync(jPath)).toBe(false)
    expect(recovered.read('chat-all-corrupt').tail).toEqual([])
  })

  it('does not lose valid lines when a torn tail is recovered', () => {
    const jPath = path.join(baseDir, 'chat-mixed.jsonl')
    const r1 = chatRecord('a', '', 1)
    const r2 = chatRecord('a', '', 2)
    const r3 = chatRecord('a', '', 3)
    const validLines = [
      JSON.stringify({ savedAt: '2026-08-04T00:00:00Z', record: r1 }),
      JSON.stringify({ savedAt: '2026-08-04T00:00:01Z', record: r2 }),
      JSON.stringify({ savedAt: '2026-08-04T00:00:02Z', record: r3 })
    ]
    fs.writeFileSync(jPath, validLines.join('\n') + '\n{"torn', 'utf-8')

    const recovered = createChatJournal(baseDir)
    const result = recovered.read('chat-mixed')
    expect(result.tail).toHaveLength(3)
    expect(result.tail[0].record).toEqual(r1)
    expect(result.tail[1].record).toEqual(r2)
    expect(result.tail[2].record).toEqual(r3)
  })

  // -----------------------------------------------------------------------
  // Snapshot compaction
  // -----------------------------------------------------------------------

  it('compacts journal lines into a snapshot and truncates the journal', () => {
    const r1 = chatRecord('chat-compact', 'first')
    const r2 = chatRecord('chat-compact', 'second')

    journal.append('chat-compact', r1)
    journal.append('chat-compact', r2)

    const compacted = journal.compact('chat-compact')
    expect(compacted).toBe(true)

    // Journal must be gone
    expect(journalContent(path.join(baseDir, 'chat-compact.jsonl'))).toBeNull()

    // Snapshot must hold both entries as a flat array
    const snapContent = journalContent(path.join(baseDir, 'chat-compact.snapshot.json'))
    expect(snapContent).not.toBeNull()
    const snap = JSON.parse(snapContent!) as ChatJournalEntry[]
    expect(snap).toHaveLength(2)
    expect(snap[0].record).toEqual(r1)
    expect(snap[1].record).toEqual(r2)
  })

  it('compacts an empty chat to false (no-op)', () => {
    expect(journal.compact('nonexistent')).toBe(false)
  })

  it('merges existing snapshot with journal tail during compaction', () => {
    // Batch 1 → compact
    const r1 = chatRecord('chat-merge', 'batch1-a')
    const r2 = chatRecord('chat-merge', 'batch1-b')
    journal.append('chat-merge', r1)
    journal.append('chat-merge', r2)
    journal.compact('chat-merge')

    // Batch 2 → compact again
    const r3 = chatRecord('chat-merge', 'batch2-a')
    const r4 = chatRecord('chat-merge', 'batch2-b')
    journal.append('chat-merge', r3)
    journal.append('chat-merge', r4)
    journal.compact('chat-merge')

    // Read back — snapshot must be a flat array of 4
    const result = journal.read('chat-merge')
    expect(result.snapshot).not.toBeNull()
    const snap = result.snapshot as ChatJournalEntry[]
    expect(snap).toHaveLength(4)
    expect(snap[0].record).toEqual(r1)
    expect(snap[1].record).toEqual(r2)
    expect(snap[2].record).toEqual(r3)
    expect(snap[3].record).toEqual(r4)
  })

  it('read() returns snapshot + any un-compacted journal tail', () => {
    journal.append('chat-partial', chatRecord('chat-partial', 'pre-snapshot'))
    journal.compact('chat-partial')
    const postRecord = chatRecord('chat-partial', 'post-snapshot')
    journal.append('chat-partial', postRecord)

    const result = journal.read('chat-partial')
    expect(result.snapshot).not.toBeNull()
    expect(result.tail).toHaveLength(1)
    expect(result.tail[0].record).toEqual(postRecord)
  })

  // -----------------------------------------------------------------------
  // GATE 3 — Snapshot scheduling triggers
  // -----------------------------------------------------------------------

  it('compacts a chat that exceeds the line threshold', () => {
    for (let i = 0; i < 1001; i++) {
      journal.append('chat-threshold', chatRecord('chat-threshold', `msg-${i}`))
    }

    // Auto-compact on append (Gate 3) fires once lineCount > 1000 —
    // an explicit compact afterward is a no-op because the journal is empty.
    expect(journal.compact('chat-threshold')).toBe(false)
    expect(journal.stats().snapshotsWritten).toBeGreaterThanOrEqual(1)

    // Journal must be cleared
    expect(journalContent(path.join(baseDir, 'chat-threshold.jsonl'))).toBeNull()

    // Every line must be in the snapshot
    const snap = JSON.parse(
      journalContent(path.join(baseDir, 'chat-threshold.snapshot.json'))!
    ) as ChatJournalEntry[]
    expect(snap).toHaveLength(1001)
  })

  it('compactAll compacts multiple chats', () => {
    journal.append('a', chatRecord('a', 'x'))
    journal.append('a', chatRecord('a', 'y'))
    journal.append('b', chatRecord('b', 'z'))

    const count = journal.compactAll()
    expect(count).toBe(2)

    expect(journalContent(path.join(baseDir, 'a.jsonl'))).toBeNull()
    expect(journalContent(path.join(baseDir, 'b.jsonl'))).toBeNull()
    expect(fs.existsSync(path.join(baseDir, 'a.snapshot.json'))).toBe(true)
    expect(fs.existsSync(path.join(baseDir, 'b.snapshot.json'))).toBe(true)
  })

  // -----------------------------------------------------------------------
  // GATE 2 — History deletion COMPLETE and provable
  // -----------------------------------------------------------------------

  it('tombstones a chat and removes all journal/snapshot artifacts', () => {
    journal.append('chat-del', chatRecord('chat-del', 'msg1'))
    journal.compact('chat-del')
    journal.append('chat-del', chatRecord('chat-del', 'msg2'))

    journal.delete('chat-del')

    expect(journalContent(path.join(baseDir, 'chat-del.jsonl'))).toBeNull()
    expect(journalContent(path.join(baseDir, 'chat-del.snapshot.json'))).toBeNull()
    expect(fs.existsSync(path.join(baseDir, 'chat-del.tombstone'))).toBe(true)

    const result = journal.read('chat-del')
    expect(result.snapshot).toBeNull()
    expect(result.tail).toEqual([])
  })

  it('refuses appends to a tombstoned chat', () => {
    journal.append('chat-tomb', chatRecord('chat-tomb', 'before'))
    journal.delete('chat-tomb')

    expect(() => journal.append('chat-tomb', chatRecord('chat-tomb', 'after'))).toThrow(
      'tombstoned'
    )

    expect(journalContent(path.join(baseDir, 'chat-tomb.jsonl'))).toBeNull()
  })

  it('delete is idempotent', () => {
    journal.delete('chat-double')
    expect(() => journal.delete('chat-double')).not.toThrow()
  })

  it('delete of a chat with no journal is a no-op that still tombstones', () => {
    journal.delete('chat-new')
    expect(fs.existsSync(path.join(baseDir, 'chat-new.tombstone'))).toBe(true)
    expect(() => journal.append('chat-new', chatRecord('chat-new', 'x'))).toThrow('tombstoned')
  })

  it('read returns empty for a deleted chat that had data before deletion', () => {
    journal.append('chat-read-del', chatRecord('chat-read-del', 'msg'))
    journal.delete('chat-read-del')

    const result = journal.read('chat-read-del')
    expect(result.snapshot).toBeNull()
    expect(result.tail).toHaveLength(0)
  })

  it('provides stats counters for deletions and tombstone rejects', () => {
    journal.append('chat-stats', chatRecord('chat-stats', 'x'))
    journal.delete('chat-stats')

    expect(() => journal.append('chat-stats', chatRecord('chat-stats', 'y'))).toThrow('tombstoned')

    const s = journal.stats()
    expect(s.appends).toBe(2)
    expect(s.chatsDeleted).toBe(1)
    expect(s.tombstoneRejects).toBe(1)
  })

  // -----------------------------------------------------------------------
  // GATE 4 — Cross-file ordering (crash-between convergence)
  // -----------------------------------------------------------------------

  it('survives a crash between snapshot write and journal truncation', () => {
    journal.append('chat-crash', chatRecord('chat-crash', 'before'))
    journal.compact('chat-crash')

    // Append after compaction — simulates journal active while snapshot exists
    const afterRecord = chatRecord('chat-crash', 'after-compact')
    journal.append('chat-crash', afterRecord)

    // Re-init — must handle snapshot + journal both present
    const recovered = createChatJournal(baseDir)
    const result = recovered.read('chat-crash')

    expect(result.snapshot).not.toBeNull()
    const snap = result.snapshot as ChatJournalEntry[]
    expect(snap).toHaveLength(1)

    expect(result.tail).toHaveLength(1)
    expect(result.tail[0].record).toEqual(afterRecord)
  })

  it('survives a crash mid-append (torn line recovery)', () => {
    const completeRecord = chatRecord('chat-torn', 'complete', 100)
    const jPath = path.join(baseDir, 'chat-torn.jsonl')
    fs.writeFileSync(
      jPath,
      JSON.stringify({
        savedAt: '2026-08-04T00:00:00Z',
        record: completeRecord
      }) + '\n{"savedAt":"2026-08-04T00:00:01Z","rec',
      'utf-8'
    )

    const recovered = createChatJournal(baseDir)
    const result = recovered.read('chat-torn')
    expect(result.tail).toHaveLength(1)
    expect(result.tail[0].record).toEqual(completeRecord)
  })

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  it('handles multiple independent chats without cross-talk', () => {
    const rA = chatRecord('a', 'a-data')
    const rB = chatRecord('b', 'b-data')
    journal.append('a', rA)
    journal.append('b', rB)

    const aResult = journal.read('a')
    const bResult = journal.read('b')

    expect(aResult.tail).toHaveLength(1)
    expect(aResult.tail[0].record).toEqual(rA)
    expect(bResult.tail).toHaveLength(1)
    expect(bResult.tail[0].record).toEqual(rB)
  })

  it('read returns empty for a never-written chat', () => {
    const result = journal.read('nonexistent')
    expect(result.snapshot).toBeNull()
    expect(result.tail).toEqual([])
  })

  it('handles a corrupt snapshot gracefully (treats as absent)', () => {
    fs.writeFileSync(path.join(baseDir, 'chat-corrupt.snapshot.json'), '{not json', 'utf-8')
    const r = chatRecord('chat-corrupt', 'journal-data')
    journal.append('chat-corrupt', r)

    const result = journal.read('chat-corrupt')
    expect(result.snapshot).toBeNull()
    expect(result.tail).toHaveLength(1)
    expect(result.tail[0].record).toEqual(r)
  })

  it('survives writes to a chat with a pre-existing empty journal', () => {
    fs.writeFileSync(path.join(baseDir, 'chat-empty.jsonl'), '', 'utf-8')

    journal.append('chat-empty', chatRecord('chat-empty', 'data'))

    const result = journal.read('chat-empty')
    expect(result.tail).toHaveLength(1)
  })

  it('tracks bytesWritten in stats', () => {
    journal.append('chat-bytes', chatRecord('chat-bytes', 'hello world'))

    const s = journal.stats()
    expect(s.bytesWritten).toBeGreaterThan(0)
    expect(s.linesWritten).toBe(1)
    expect(s.appends).toBe(1)
  })

  it('snapshot stats counter increments on compaction', () => {
    journal.append('chat-snap-stats', chatRecord('chat-snap-stats', 'x'))
    journal.compact('chat-snap-stats')

    const s = journal.stats()
    expect(s.snapshotsWritten).toBe(1)
  })

  it('throws on non-serializable records', () => {
    const circular: Record<string, unknown> = { id: 'circular' }
    circular.self = circular

    expect(() => journal.append('circular', circular)).toThrow('not JSON-serializable')
  })

  it('empty journal directory init is a no-op', () => {
    const s = journal.stats()
    expect(s.linesWritten).toBe(0)
    expect(s.appends).toBe(0)
  })
})
