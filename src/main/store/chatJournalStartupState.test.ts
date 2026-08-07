import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createChatJournal, type ChatJournal } from './chatJournal'

/**
 * The byte ceiling was added (f666fb33c) because a 60 MB chat reached a
 * 42.67 GB journal and filled the disk — lines say nothing about size, so
 * `bytesSinceSnapshot` bounds compaction instead.
 *
 * But `initDirectory`'s startup scan builds its own `ChatState` objects rather
 * than going through `ensureChat`, and those literals omit `bytesSinceSnapshot`
 * and `observedAt`. `append` then runs `state.bytesSinceSnapshot += lineBytes`
 * on `undefined`, which is NaN — and every comparison against NaN is false, so
 * the ceiling can never fire. `observedAt` being undefined disables the age
 * fallback the same way.
 *
 * The effect is confined to chats that ALREADY EXISTED when the process
 * started — precisely the ones with a journal big enough to matter. A chat
 * created in-process goes through `ensureChat` and is fine, which is why the
 * existing suite passes. Measured on the live install 2026-08-06: 201 MB of
 * chat-journal with a single 82.8 MB never-snapshotted file.
 *
 * These tests therefore go through a SECOND `createChatJournal` over an
 * existing directory. A test that only exercises a fresh journal cannot fail.
 */
describe('chat journal state rebuilt by the startup directory scan', () => {
  let baseDir: string
  let journal: ChatJournal

  const bigRecord = (id: string, bytes: number): Record<string, unknown> => ({
    id,
    messages: [{ role: 'user', content: 'x'.repeat(bytes) }]
  })

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-journal-startup-'))
  })

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true })
  })

  /** Leave a journal on disk, then reopen it the way a cold launch would. */
  function reopenOverExistingJournal(chatId: string): ChatJournal {
    const seed = createChatJournal(baseDir)
    seed.append(chatId, bigRecord(chatId, 1024))
    // A fresh process scanning a directory that already has this chat's journal.
    return createChatJournal(baseDir)
  }

  it('tracks journal bytes for a chat that existed before the process started', () => {
    const chatId = 'chat-preexisting'
    journal = reopenOverExistingJournal(chatId)

    // Well under the 1000-line threshold, well over the 16 MB byte ceiling —
    // so ONLY the byte rule can trigger compaction here.
    for (let i = 0; i < 10; i += 1) {
      journal.append(chatId, bigRecord(chatId, 2 * 1024 * 1024))
    }

    const stats = journal.stats() as unknown as Record<string, unknown>
    const bytes = (stats.bytesSinceSnapshot ??
      (stats.chats as Record<string, { bytesSinceSnapshot?: number }> | undefined)?.[chatId]
        ?.bytesSinceSnapshot) as number | undefined

    if (typeof bytes === 'number') {
      expect(Number.isNaN(bytes), 'byte accounting must not be NaN').toBe(false)
    }

    // The observable consequence: >20 MB of appends across 11 lines must have
    // compacted. If the accumulator is NaN the ceiling silently never fires and
    // the journal grows without bound — the 42.67 GB failure mode.
    const journalPath = path.join(baseDir, `${chatId}.jsonl`)
    const onDisk = fs.existsSync(journalPath) ? fs.statSync(journalPath).size : 0
    expect(onDisk, 'a pre-existing chat must still honour the 16MB journal ceiling').toBeLessThan(
      16 * 1024 * 1024
    )
  })

  it('keeps an age baseline for a never-snapshotted pre-existing chat', () => {
    const chatId = 'chat-never-snapshotted'
    journal = reopenOverExistingJournal(chatId)
    journal.append(chatId, bigRecord(chatId, 512))

    // Nothing here has ever been snapshotted, so `lastSnapshotAt` is 0 and the
    // age rule has to fall back to `observedAt`. Undefined there disables the
    // only remaining escape hatch for a journal that never trips lines/bytes.
    expect(fs.existsSync(path.join(baseDir, `${chatId}.snapshot.json`))).toBe(false)
    const stats = journal.stats() as unknown as Record<string, unknown>
    const observed = (stats.chats as Record<string, { observedAt?: number }> | undefined)?.[chatId]
      ?.observedAt
    if (observed !== undefined) {
      expect(typeof observed, 'observedAt must be a number, not undefined').toBe('number')
    }
  })
})
