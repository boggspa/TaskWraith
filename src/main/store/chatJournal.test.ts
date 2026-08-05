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

  it('compacts a chat that exceeds the line threshold', { timeout: 15_000 }, () => {
    // Bulk-write 1001 lines to the journal file — individual fsync'd
    // appends take too long for a unit test. The journal's append
    // semantics are proven in other tests; this one verifies the
    // snapshot threshold integration on re-read.
    const jPath = path.join(baseDir, 'chat-threshold.jsonl')
    const lines: string[] = []
    for (let i = 0; i < 1001; i++) {
      lines.push(
        JSON.stringify({
          savedAt: new Date(now + i).toISOString(),
          record: chatRecord('chat-threshold', `msg-${i}`, now + i)
        })
      )
    }
    fs.writeFileSync(jPath, lines.join('\n') + '\n', 'utf-8')

    // Re-create so initDirectory sees the pre-populated journal
    const fresh = createChatJournal(baseDir)
    const compacted = fresh.compact('chat-threshold')
    expect(compacted).toBe(true)

    expect(fs.existsSync(jPath)).toBe(false)
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

  // -----------------------------------------------------------------------
  // G3 — Compact-window deduplication (MistralReview + K3Review FAIL)
  // -----------------------------------------------------------------------

  /**
   * Simulate the exact crash window:
   *   1. Append lines → compact (writes snapshot, unlinks journal)
   *   2. Append more lines → compact AGAIN — but manually re-create the
   *      journal AFTER the second compact's snapshot write and BEFORE it
   *      would unlink the journal. This leaves:
   *        snapshot = [...batch1, ...batch2]
   *        journal  = [...batch2]          ← duplicated in snapshot
   *   3. read() must return NO duplicate tail entries
   *   4. A subsequent compact() must NOT double-merge
   *   5. Stats must be consistent
   */
  it('G3: read() deduplicates journal tail against snapshot after crash window', () => {
    // Batch 1 — compact
    const r1 = chatRecord('g3', 'batch1-a')
    const r2 = chatRecord('g3', 'batch1-b')
    journal.append('g3', r1)
    journal.append('g3', r2)
    journal.compact('g3')

    // Batch 2 — compact
    const r3 = chatRecord('g3', 'batch2-a')
    const r4 = chatRecord('g3', 'batch2-b')
    journal.append('g3', r3)
    journal.append('g3', r4)
    journal.compact('g3')

    // Verify clean state after normal compaction
    let result = journal.read('g3')
    expect(result.snapshot).not.toBeNull()
    const cleanSnap = result.snapshot as ChatJournalEntry[]
    expect(cleanSnap).toHaveLength(4)
    expect(result.tail).toHaveLength(0)

    // --- SIMULATE CRASH WINDOW ---
    // Append batch 3 and manually re-create the journal after snapshot write
    const r5 = chatRecord('g3', 'batch3-a')
    const r6 = chatRecord('g3', 'batch3-b')
    journal.append('g3', r5)
    journal.append('g3', r6)

    // Read the current snapshot (has batches 1-2)
    const snapBeforeCrash = journal.read('g3')
    const snapEntries = snapBeforeCrash.snapshot as ChatJournalEntry[]
    const tailEntries = snapBeforeCrash.tail as ChatJournalEntry[]

    // Manually write: snapshot with ALL entries merged. The journal file
    // still exists on disk from the normal appends — this IS the crash
    // window: compact() wrote snapshot then crashed before unlinkSync(journal).
    const snapPath = path.join(baseDir, 'g3.snapshot.json')

    const mergedEntries = [...snapEntries, ...tailEntries]
    fs.writeFileSync(snapPath, JSON.stringify(mergedEntries), 'utf-8')
    // Journal still has the tail — this IS the crash window:
    // compact() wrote snapshot then crashed before unlinkSync(journal)

    // --- RECOVER ---
    const recovered = createChatJournal(baseDir)
    const recResult = recovered.read('g3')

    // ASSERTION 1: read() returns NO duplicate tail entries
    expect(recResult.snapshot).not.toBeNull()
    const recSnap = recResult.snapshot as ChatJournalEntry[]
    expect(recSnap).toHaveLength(6) // all 6 entries in snapshot

    // The journal tail was already in the snapshot — must be deduped
    expect(recResult.tail).toHaveLength(0)

    // ASSERTION 2: A subsequent compact() does NOT double-merge
    const afterRec = chatRecord('g3', 'post-recovery')
    recovered.append('g3', afterRec)
    recovered.compact('g3')

    const finalResult = recovered.read('g3')
    const finalSnap = finalResult.snapshot as ChatJournalEntry[]
    // 6 original + 1 post-recovery = 7 — NOT 6+3+1=10 (no double-merge)
    expect(finalSnap).toHaveLength(7)
    expect(finalResult.tail).toHaveLength(0)

    // ASSERTION 3: Stats consistent — initDirectory deduped the journal
    const s = recovered.stats()
    // The 2 batch3 tail entries were deduped against the snapshot, then
    // one post-recovery append happened → linesWritten = 1
    expect(s.linesWritten).toBe(1)
    expect(s.tornLinesRecovered).toBe(0)
  })

  it('G3: initDirectory truncates journal when all lines are already in snapshot', () => {
    // Pre-populate: snapshot with entries, journal with same entries
    const r1 = chatRecord('g3-init', 'a')
    const r2 = chatRecord('g3-init', 'b')

    const snapPath = path.join(baseDir, 'g3-init.snapshot.json')
    const jPath = path.join(baseDir, 'g3-init.jsonl')

    const entries: ChatJournalEntry[] = [
      { savedAt: '2026-08-04T00:00:00.000Z', record: r1 },
      { savedAt: '2026-08-04T00:00:01.000Z', record: r2 }
    ]
    fs.writeFileSync(snapPath, JSON.stringify(entries), 'utf-8')
    fs.writeFileSync(jPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8')

    // Recover — initDirectory must dedupe
    const recovered = createChatJournal(baseDir)

    // Journal should be truncated (or removed if empty after dedup)
    const journalAfter = journalContent(jPath)
    // After dedup, all 2 lines were already in snapshot → journal removed
    expect(journalAfter).toBeNull()

    const result = recovered.read('g3-init')
    expect(result.snapshot).not.toBeNull()
    const snap = result.snapshot as ChatJournalEntry[]
    expect(snap).toHaveLength(2)
    expect(result.tail).toHaveLength(0)

    // Stats: no lines counted from the journal (all duped)
    const s = recovered.stats()
    expect(s.linesWritten).toBe(0)
  })

  it('G3: initDirectory preserves journal lines that postdate the snapshot', () => {
    // Snapshot has entries 1-2, journal has entries 1-2-3
    const r1 = chatRecord('g3-partial', 'a')
    const r2 = chatRecord('g3-partial', 'b')
    const r3 = chatRecord('g3-partial', 'c')

    const snapPath = path.join(baseDir, 'g3-partial.snapshot.json')
    const jPath = path.join(baseDir, 'g3-partial.jsonl')

    fs.writeFileSync(
      snapPath,
      JSON.stringify([
        { savedAt: '2026-08-04T00:00:00.000Z', record: r1 },
        { savedAt: '2026-08-04T00:00:01.000Z', record: r2 }
      ]),
      'utf-8'
    )
    fs.writeFileSync(
      jPath,
      [
        JSON.stringify({ savedAt: '2026-08-04T00:00:00.000Z', record: r1 }),
        JSON.stringify({ savedAt: '2026-08-04T00:00:01.000Z', record: r2 }),
        JSON.stringify({ savedAt: '2026-08-04T00:00:02.000Z', record: r3 })
      ].join('\n') + '\n',
      'utf-8'
    )

    const recovered = createChatJournal(baseDir)

    // Journal should still exist with only line 3
    const journalLines = journalContent(jPath)!.split('\n').filter(Boolean)
    expect(journalLines).toHaveLength(1)
    const parsed = JSON.parse(journalLines[0]) as ChatJournalEntry
    expect(parsed.record).toEqual(r3)

    const result = recovered.read('g3-partial')
    expect(result.snapshot).not.toBeNull()
    expect(result.tail).toHaveLength(1)
    expect(result.tail[0].record).toEqual(r3)

    // Stats: only the 1 non-dup line counted
    const s = recovered.stats()
    expect(s.linesWritten).toBe(1)
  })

  it('G3: snapshot-only chat (no journal) is unaffected by dedup', () => {
    // Normal compaction: snapshot exists, journal was properly removed
    const r1 = chatRecord('g3-clean', 'a')
    const r2 = chatRecord('g3-clean', 'b')
    journal.append('g3-clean', r1)
    journal.append('g3-clean', r2)
    journal.compact('g3-clean')

    // Verify journal is gone, snapshot has both
    expect(journalContent(path.join(baseDir, 'g3-clean.jsonl'))).toBeNull()
    const result = journal.read('g3-clean')
    expect(result.snapshot).not.toBeNull()
    const snap = result.snapshot as ChatJournalEntry[]
    expect(snap).toHaveLength(2)
    expect(result.tail).toHaveLength(0)

    // Re-init is a no-op
    const recovered = createChatJournal(baseDir)
    const recResult = recovered.read('g3-clean')
    expect(recResult.snapshot).not.toBeNull()
    expect(recResult.tail).toHaveLength(0)
  })

  it('G3: journal-only chat (no snapshot) is unaffected by dedup', () => {
    const r1 = chatRecord('g3-journalonly', 'a')
    journal.append('g3-journalonly', r1)

    const result = journal.read('g3-journalonly')
    expect(result.snapshot).toBeNull()
    expect(result.tail).toHaveLength(1)
    expect(result.tail[0].record).toEqual(r1)
  })

  it('G3: tombstoned chats are not affected by initDirectory dedup', () => {
    // Write a chat, compact it, then manually create the crash window,
    // then tombstone it
    const r1 = chatRecord('g3-tomb', 'a')
    journal.append('g3-tomb', r1)
    journal.compact('g3-tomb')
    journal.delete('g3-tomb')

    // Manually re-create snapshot + journal (simulating crash before unlink)
    const snapPath = path.join(baseDir, 'g3-tomb.snapshot.json')
    const jPath = path.join(baseDir, 'g3-tomb.jsonl')
    const tombPath = path.join(baseDir, 'g3-tomb.tombstone')
    fs.writeFileSync(
      snapPath,
      JSON.stringify([{ savedAt: '2026-08-04T00:00:00.000Z', record: r1 }]),
      'utf-8'
    )
    fs.writeFileSync(
      jPath,
      JSON.stringify({ savedAt: '2026-08-04T00:00:00.000Z', record: r1 }) + '\n',
      'utf-8'
    )
    // Tombstone still exists

    const recovered = createChatJournal(baseDir)
    const result = recovered.read('g3-tomb')
    expect(result.snapshot).toBeNull()
    expect(result.tail).toEqual([])
    expect(fs.existsSync(tombPath)).toBe(true)
  })
})

describe('ChatJournal compaction bounds journal BYTES, not just lines', () => {
  /**
   * MEASURED on a live install 2026-08-05: one 60 MB chat produced a
   * **42.67 GB** journal growing 389 MB/min, which filled the disk and took
   * the app down. Two compounding defects in `shouldCompact`:
   *
   *  1. The only size trigger was `lineCount > 1000`. A journal line holds the
   *     WHOLE record, so a 60 MB chat needs ~60 GB before compaction fires.
   *  2. The age trigger was guarded by `lastSnapshotAt > 0`, so a journal that
   *     has NEVER been snapshotted could never compact by age — precisely the
   *     case that needs it.
   *
   * Compaction must therefore be bounded by bytes written since the last
   * snapshot, independent of line count.
   */
  let baseDir: string
  let journal: ChatJournal

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-journal-bytes-'))
    journal = createChatJournal(baseDir)
  })

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true })
  })

  it('compacts a large-record chat long before the 1000-line threshold', () => {
    const chatId = 'fat-chat'
    // ~1 MB per record: 40 appends is ~40 MB of journal but only 40 lines, so
    // the line threshold cannot save us.
    const fat = 'x'.repeat(1024 * 1024)
    for (let i = 0; i < 40; i += 1) {
      journal.append(chatId, { id: chatId, blob: fat, updatedAt: i })
    }

    const journalPath = path.join(baseDir, `${chatId}.jsonl`)
    const journalBytes = fs.existsSync(journalPath) ? fs.statSync(journalPath).size : 0
    const stats = journal.stats()

    expect(
      stats.snapshotsWritten,
      'no snapshot was taken — a large-record chat grows the journal without bound'
    ).toBeGreaterThan(0)
    // After compaction the live journal tail must be far smaller than the
    // total bytes appended; without a byte trigger it is the full ~40 MB.
    expect(
      journalBytes,
      `journal tail is ${(journalBytes / 1048576).toFixed(1)} MB — compaction is not bounding bytes`
    ).toBeLessThan(24 * 1024 * 1024)
  })

  it('still replays the exact latest record after byte-triggered compaction', () => {
    const chatId = 'fat-chat-replay'
    const fat = 'y'.repeat(1024 * 1024)
    for (let i = 0; i < 40; i += 1) {
      journal.append(chatId, { id: chatId, blob: fat, updatedAt: i })
    }
    const { snapshot, tail } = journal.read(chatId)
    const latest =
      tail.length > 0 ? (tail[tail.length - 1].record as Record<string, unknown>) : snapshot
    expect((latest as Record<string, unknown>).updatedAt).toBe(39)
  })
})
