import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { ChatListIndexStore } from './ChatListIndexStore'
import type { ChatListItem } from './types'

function makeItem(
  chatId: string,
  overrides: Partial<ChatListItem> & Record<string, unknown> = {}
): ChatListItem {
  return {
    appChatId: chatId,
    id: chatId,
    title: `Chat ${chatId}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    provider: 'codex',
    messages: [],
    runs: [],
    summaryOnly: true,
    messageCount: 0,
    runCount: 0,
    ...overrides
  } as ChatListItem
}

/** Only ever appears inside a seat's brief, so a substring search over a line
 *  is a fair "did the fat blob leak?" test. */
const ROSTER_MARKER = 'PARTICIPANT-INSTRUCTIONS-MARKER'

function fatEnsemble() {
  return {
    schemaVersion: 1 as const,
    participants: Array.from({ length: 40 }, (_, i) => ({
      id: `p-${i}`,
      role: `Role ${i}`,
      provider: 'codex',
      model: 'gpt-test',
      // Briefs are the single largest contributor to a fat roster.
      instructions: `${ROSTER_MARKER} ${'brief text '.repeat(100)}`
    })),
    activeRound: {
      id: 'round-1',
      startedAt: '2026-01-01T00:00:00.000Z',
      lanes: Array.from({ length: 20 }, (_, i) => ({
        participantId: `p-${i}`,
        status: 'running'
      }))
    },
    roundSummaries: Array.from({ length: 30 }, (_, i) => ({
      id: `sum-${i}`,
      text: 'x'.repeat(200)
    })),
    blackboard: {
      entries: Array.from({ length: 50 }, (_, i) => ({
        key: `k-${i}`,
        value: 'y'.repeat(100)
      }))
    }
  }
}

describe('ChatListIndexStore cache + projection', () => {
  let dir: string
  let store: ChatListIndexStore

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-list-index-store-'))
    store = new ChatListIndexStore(dir)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('isCacheValid is true after readAll when the index file is unchanged', () => {
    store.writeEntry('chat-a', makeItem('chat-a', { title: 'A' }))
    store.clearCache()
    store.readAll()
    expect(store.isCacheValid()).toBe(true)
  })

  it('second readAll serves from cache while mtime+size stamp is unchanged', () => {
    store.writeEntry('chat-a', makeItem('chat-a', { title: 'First' }))
    store.clearCache()

    const first = store.readAll()
    expect(first['chat-a']?.title).toBe('First')
    expect(store.isCacheValid()).toBe(true)

    // Corrupt the durable file but preserve mtimeMs+size so a naive re-parse
    // would return wrong/empty data. A cache hit must keep serving 'First'.
    const indexPath = path.join(dir, 'chat-list-index.jsonl')
    const st = fs.statSync(indexPath)
    const corrupt = Buffer.alloc(st.size, 0x20) // spaces, same size, not valid JSONL
    fs.writeFileSync(indexPath, corrupt)
    // Fractional seconds keep mtimeMs equality (Date-only utimes truncates).
    fs.utimesSync(indexPath, st.atimeMs / 1000, st.mtimeMs / 1000)

    expect(store.isCacheValid()).toBe(true)
    const second = store.readAll()
    expect(second['chat-a']?.title).toBe('First')
  })

  it('cache hit preserves summary fields without needing the summary side-file', () => {
    const item = makeItem('chat-a', {
      runsSummary: [{ runId: 'r1', diffFileCount: 0 }],
      lastRun: { id: 'r1', status: 'completed' } as unknown as ChatListItem['lastRun']
    })
    store.writeEntry('chat-a', item)
    store.clearCache()

    const cold = store.readAll()
    expect(cold['chat-a']?.runsSummary?.[0]?.runId).toBe('r1')
    expect(store.isCacheValid()).toBe(true)

    // Remove the side file. A cache hit must still return the merged summary;
    // a cold re-parse would lose runsSummary.
    fs.rmSync(path.join(dir, 'chat-list-summaries'), { recursive: true, force: true })
    const warm = store.readAll()
    expect(warm['chat-a']?.runsSummary?.[0]?.runId).toBe('r1')
  })

  it('readEntry returns a defensive copy of one entry without requiring a full index re-parse on warm cache', () => {
    store.writeEntry('chat-a', makeItem('chat-a', { title: 'Alpha' }))
    store.writeEntry('chat-b', makeItem('chat-b', { title: 'Beta' }))
    store.clearCache()
    store.readAll() // warm
    expect(store.isCacheValid()).toBe(true)

    // Same-size corrupt durable file: cache hit must still return Alpha.
    const indexPath = path.join(dir, 'chat-list-index.jsonl')
    const st = fs.statSync(indexPath)
    fs.writeFileSync(indexPath, Buffer.alloc(st.size, 0x20))
    fs.utimesSync(indexPath, st.atimeMs / 1000, st.mtimeMs / 1000)

    expect(store.isCacheValid()).toBe(true)
    const entry = store.readEntry('chat-a')
    expect(entry?.title).toBe('Alpha')

    // Defensive copy: mutating the return must not poison the cache.
    if (entry) entry.title = 'MUTATED'
    expect(store.readEntry('chat-a')?.title).toBe('Alpha')
    expect(store.readEntry('missing')).toBeUndefined()
  })

  /**
   * This used to assert `ensemble` was absent entirely. That is no longer the
   * contract: dropping it made `normalizeChatRecord` rebuild a
   * `createDefaultEnsembleConfig` roster, so a 40-seat chat rendered as ~4
   * seats the user never configured — fabricated data is worse than large data.
   * What the line must not carry is the FAT blob, which is what these
   * assertions now pin: the briefs and sub-blobs go, the identities stay.
   */
  it('writeEntry reduces a fat ensemble to the lean roster on the durable JSONL line', () => {
    const fat = makeItem('chat-a', {
      chatKind: 'ensemble',
      ensemble: fatEnsemble() as unknown as ChatListItem['ensemble']
    })
    store.writeEntry('chat-a', fat)

    const raw = fs.readFileSync(path.join(dir, 'chat-list-index.jsonl'), 'utf-8')
    const line = raw.trim().split('\n').at(-1)!
    const rec = JSON.parse(line) as { chatId: string; entry: Record<string, unknown> }
    expect(rec.chatId).toBe('chat-a')
    // The bulk is gone...
    expect(line).not.toContain(ROSTER_MARKER)
    expect(rec.entry.ensemble).not.toHaveProperty('roundSummaries')
    expect(rec.entry.ensemble).not.toHaveProperty('blackboard')
    expect(JSON.stringify(rec.entry).length).toBeLessThan(JSON.stringify(fat).length / 2)
    // ...but the roster the sidebar renders survives.
    const persisted = rec.entry.ensemble as { participants: { role: string }[] }
    expect(persisted.participants).toHaveLength(40)
    expect(persisted.participants[3].role).toBe('Role 3')
    expect(rec.entry.ensemble).toHaveProperty('activeRound')

    // In-memory projection must match the durable line.
    const fromStore = store.readEntry('chat-a')
    expect(fromStore?.ensemble?.participants).toHaveLength(40)
    expect(JSON.stringify(fromStore)).not.toContain(ROSTER_MARKER)
  })

  it('one-time compact rewrites historical fat ensemble lines so the file actually shrinks', () => {
    const indexPath = path.join(dir, 'chat-list-index.jsonl')
    fs.mkdirSync(path.dirname(indexPath), { recursive: true })

    // Simulate pre-migration JSONL: already-written fat lines with ensemble.
    const fatEntry = {
      ...makeItem('chat-fat', { chatKind: 'ensemble' }),
      ensemble: fatEnsemble()
    }
    // runsSummary/lastRun belong in side files, not JSONL — drop them like the old writer.
    const {
      runsSummary: _rs,
      lastRun: _lr,
      ...jsonlShape
    } = fatEntry as unknown as ChatListItem & {
      runsSummary?: unknown
      lastRun?: unknown
    }
    const fatLine = JSON.stringify({ chatId: 'chat-fat', entry: jsonlShape }) + '\n'
    fs.writeFileSync(indexPath, fatLine, 'utf-8')
    const beforeBytes = fs.statSync(indexPath).size
    expect(beforeBytes).toBeGreaterThan(5_000)
    expect(fatLine).toContain('"ensemble"')

    // Cold load must shrink durable bytes and reduce the fat blob to lean.
    // The roster is present in the legacy line, so the heal must carry it
    // across: dropping it here is what left pre-existing installs advertising
    // a fabricated default roster on every chat the user never re-saved.
    store.clearCache()
    const loaded = store.readAll()
    expect(loaded['chat-fat']?.title).toBe('Chat chat-fat')
    expect(loaded['chat-fat']?.ensemble?.participants).toHaveLength(40)
    expect(JSON.stringify(loaded['chat-fat'])).not.toContain(ROSTER_MARKER)

    const afterRaw = fs.readFileSync(indexPath, 'utf-8')
    expect(afterRaw).not.toContain(ROSTER_MARKER)
    const afterRec = JSON.parse(afterRaw.trim().split('\n').at(-1)!) as {
      entry: Record<string, unknown>
    }
    expect(afterRec.entry.ensemble).not.toHaveProperty('roundSummaries')
    expect(afterRec.entry.ensemble).not.toHaveProperty('blackboard')
    expect((afterRec.entry.ensemble as { participants: unknown[] }).participants).toHaveLength(40)
    // chatKind may remain 'ensemble' — that is a kind tag, not the blob.
    expect(afterRec.entry.chatKind).toBe('ensemble')
    const afterBytes = fs.statSync(indexPath).size
    expect(afterBytes).toBeLessThan(beforeBytes)
    expect(afterBytes).toBeLessThan(beforeBytes * 0.5)
  })

  it('removeEntries does not serve a deleted chat from a stale cache', () => {
    store.writeEntry('chat-a', makeItem('chat-a'))
    store.writeEntry('chat-b', makeItem('chat-b'))
    expect(store.readEntry('chat-a')).toBeTruthy()

    store.removeEntries(['chat-a'])
    expect(store.readEntry('chat-a')).toBeUndefined()
    expect(store.readAll()['chat-a']).toBeUndefined()
    expect(store.readEntry('chat-b')?.appChatId).toBe('chat-b')
    expect(store.isCacheValid()).toBe(true)
  })

  it('external mtime+size change invalidates the cache', () => {
    store.writeEntry('chat-a', makeItem('chat-a', { title: 'Before' }))
    store.clearCache()
    store.readAll()
    expect(store.isCacheValid()).toBe(true)

    const indexPath = path.join(dir, 'chat-list-index.jsonl')
    // External writer: rewrite file with a different entry (simulates another process).
    const external = {
      chatId: 'chat-a',
      entry: {
        ...makeItem('chat-a', { title: 'External' }),
        runsSummary: undefined,
        lastRun: undefined
      }
    }
    // Ensure size and content change; bump mtime if needed.
    fs.writeFileSync(indexPath, JSON.stringify(external) + '\n', 'utf-8')
    const now = new Date()
    fs.utimesSync(indexPath, now, now)

    expect(store.isCacheValid()).toBe(false)
    expect(store.readAll()['chat-a']?.title).toBe('External')
  })
})
