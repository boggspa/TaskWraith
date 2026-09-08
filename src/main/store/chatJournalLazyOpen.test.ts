import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createChatJournal, type ChatJournalEntry } from './chatJournal'

/**
 * Body reads of journal / snapshot files, recorded by path.
 *
 * Only reads count: `parseJournalLines` and the snapshot read go through
 * `readFileSync`, `readNewestJournalEntry` opens with 'r' and uses `readSync`.
 * Directory listings and stats are metadata and are deliberately allowed.
 */
const probe = vi.hoisted(() => ({ enabled: false, reads: [] as string[] }))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  const isBody = (target: unknown): boolean =>
    typeof target === 'string' &&
    (target.endsWith('.jsonl') ||
      target.endsWith('.snapshot.json') ||
      target.includes('.oversized-'))
  const readFileSync = (...args: Parameters<typeof actual.readFileSync>) => {
    if (probe.enabled && isBody(args[0])) probe.reads.push(args[0] as string)
    return Reflect.apply(actual.readFileSync, actual, args)
  }
  const openSync = (...args: Parameters<typeof actual.openSync>) => {
    if (probe.enabled && isBody(args[0]) && (args[1] === 'r' || args[1] === undefined)) {
      probe.reads.push(args[0] as string)
    }
    return Reflect.apply(actual.openSync, actual, args)
  }
  const patched = { ...actual, readFileSync, openSync }
  return { ...patched, default: patched }
})

describe('chat journal lazy open', () => {
  let baseDir: string
  const t = (second: number): string => `2026-09-08T00:00:${String(second).padStart(2, '0')}.000Z`
  const entry = (chatId: string, second: number, content: string): ChatJournalEntry => ({
    savedAt: t(second),
    record: { id: chatId, messages: [{ role: 'user', content }] }
  })
  const line = (value: ChatJournalEntry): string => `${JSON.stringify(value)}\n`
  const file = (name: string): string => path.join(baseDir, name)
  const quarantined = (): string[] =>
    fs.readdirSync(baseDir).filter((name) => name.includes('.oversized-'))
  /** Names plus exact bytes: proves construction repaired, rewrote or parked nothing. */
  const tree = (): Record<string, string> =>
    Object.fromEntries(
      fs
        .readdirSync(baseDir)
        .sort()
        .map((name) => [name, fs.readFileSync(file(name), 'utf-8')])
    )

  /**
   * A cold directory the way a crash leaves it:
   *  - healthy: two whole lines, no snapshot.
   *  - torn:    snapshot already holds e1; the journal repeats e1 (compact()
   *             crashed before unlinking), adds e2, then a torn partial line.
   *  - buried:  tombstoned, with a stale journal and snapshot left behind.
   *  - huge:    valid JSONL above the (test-sized) parse ceiling.
   */
  const healthy = [entry('healthy', 1, 'one'), entry('healthy', 2, 'two')]
  const tornKept = entry('torn', 1, 'in-snapshot')
  const tornNew = entry('torn', 2, 'after-snapshot')
  const buried = entry('buried', 1, 'deleted')

  beforeEach(() => {
    probe.enabled = false
    probe.reads = []
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-chat-journal-lazy-'))
    fs.writeFileSync(file('healthy.jsonl'), healthy.map(line).join(''), 'utf-8')
    fs.writeFileSync(file('torn.snapshot.json'), JSON.stringify([tornKept]), 'utf-8')
    fs.writeFileSync(
      file('torn.jsonl'),
      `${line(tornKept)}${line(tornNew)}{"savedAt":"${t(3)}","record":{"id":"to`,
      'utf-8'
    )
    fs.writeFileSync(file('buried.tombstone'), '', 'utf-8')
    fs.writeFileSync(file('buried.jsonl'), line(buried), 'utf-8')
    fs.writeFileSync(file('buried.snapshot.json'), JSON.stringify([buried]), 'utf-8')
    const pad = 'p'.repeat(200)
    const hugeLines: string[] = []
    for (let seq = 0; seq < 12; seq += 1) {
      hugeLines.push(JSON.stringify({ savedAt: t(seq), record: { id: 'huge', seq, pad } }))
    }
    fs.writeFileSync(file('huge.jsonl'), `${hugeLines.join('\n')}\n`, 'utf-8')
  })

  afterEach(() => {
    probe.enabled = false
    vi.useRealTimers()
    fs.rmSync(baseDir, { recursive: true, force: true })
  })

  it('construction reads no journal or snapshot body and repairs nothing', () => {
    const before = tree()

    probe.enabled = true
    const journal = createChatJournal(baseDir, { maxJournalParseBytes: 1024 })
    probe.enabled = false

    expect(probe.reads).toEqual([])
    expect(tree()).toEqual(before)
    expect(quarantined()).toEqual([])
    expect(journal.stats()).toMatchObject({ linesWritten: 0, tornLinesRecovered: 0 })
  })

  it('opening one journal recovers exactly that journal and leaves the others unread', () => {
    probe.enabled = true
    const journal = createChatJournal(baseDir, { maxJournalParseBytes: 1024 })

    // Torn tail truncated, crash-window duplicate deduped, only the new line kept.
    const torn = journal.read('torn')
    expect(torn.snapshot).toEqual([tornKept])
    expect(torn.tail).toEqual([tornNew])
    expect(fs.readFileSync(file('torn.jsonl'), 'utf-8')).toBe(line(tornNew))
    expect(journal.stats()).toMatchObject({ linesWritten: 1, tornLinesRecovered: 1 })

    // The rebuilt state carries on: the next append lands after the kept line
    // and compaction collapses to it.
    const next = { id: 'torn', messages: [{ role: 'user', content: 'post-recovery' }] }
    journal.append('torn', next)
    expect(journal.read('torn').tail.map((item) => item.record)).toEqual([tornNew.record, next])
    expect(journal.compact('torn')).toBe(true)
    const snapshot = JSON.parse(fs.readFileSync(file('torn.snapshot.json'), 'utf-8')) as {
      record: unknown
    }[]
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0].record).toEqual(next)
    expect(fs.existsSync(file('torn.jsonl'))).toBe(false)

    // A tombstone still wins, without decoding what it buries.
    expect(journal.read('buried')).toEqual({ snapshot: null, tail: [] })
    expect(() => journal.append('buried', { id: 'buried' })).toThrow(/tombstoned/)
    expect(fs.existsSync(file('buried.tombstone'))).toBe(true)

    // The oversized journal is parked when its chat is opened, not before.
    expect(quarantined()).toEqual([])
    expect(journal.read('huge')).toEqual({ snapshot: null, tail: [] })
    expect(quarantined()).toHaveLength(1)
    expect(fs.existsSync(file('huge.jsonl'))).toBe(false)

    // Everything above touched only its own chat.
    const bodies = probe.reads.map((target) => path.basename(target))
    expect(bodies.some((name) => name.startsWith('healthy.'))).toBe(false)
    expect(bodies.some((name) => name.startsWith('buried.'))).toBe(false)
    probe.enabled = false

    expect(journal.read('healthy').tail).toEqual(healthy)
  })

  it('compactAll still reaches an on-disk journal that was never touched in-process', () => {
    const journal = createChatJournal(baseDir, { maxJournalParseBytes: 1024 })

    // `healthy` and `torn` compact; `buried` is tombstoned and `huge` is parked.
    expect(journal.compactAll()).toBe(2)
    for (const chatId of ['healthy', 'torn']) {
      const snapshot = JSON.parse(fs.readFileSync(file(`${chatId}.snapshot.json`), 'utf-8')) as {
        record: unknown
      }[]
      expect(snapshot).toHaveLength(1)
      expect(fs.existsSync(file(`${chatId}.jsonl`))).toBe(false)
    }
    expect(fs.existsSync(file('buried.tombstone'))).toBe(true)
    expect(quarantined()).toHaveLength(1)
  })

  it('ages a pre-existing journal from process start, not from its first touch', () => {
    const start = Date.parse('2026-09-08T10:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(start)
    const journal = createChatJournal(baseDir)

    // Eleven minutes of uptime before this chat is first saved: the age rule
    // must fire on that save exactly as it did when the scan was eager.
    vi.setSystemTime(start + 11 * 60 * 1000)
    journal.append('healthy', { id: 'healthy', messages: [{ role: 'user', content: 'three' }] })

    expect(fs.existsSync(file('healthy.snapshot.json'))).toBe(true)
    expect(fs.existsSync(file('healthy.jsonl'))).toBe(false)
    expect(journal.stats().snapshotsWritten).toBe(1)
  })
})
