/**
 * Stage 3 — segmented dual-read chat store (ADR §5.1) module tests.
 *
 * Pins the four invariants the lane brief requires:
 *   - segment write: mirrorSave seeds a snapshot + manifest and appends
 *     framed JSON mutation batches to rotating segments;
 *   - read: readFull assembles the complete transcript from snapshot +
 *     segments (full-history assembly stays a first-class read mode);
 *   - fallback: missing/corrupt manifest or snapshot, tombstones, torn
 *     tails and quarantined segments all fail closed to null so the legacy
 *     dual-read side stays authoritative;
 *   - flag-off inert + rollback: with the flag off nothing is written or
 *     read; re-enabling resumes from the exact prior state (no data loss).
 */
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  CHAT_STORE_V2_ENV_FLAG,
  createSegmentedChatStore,
  isSegmentedChatStoreEnabled,
  type SegmentedChatStore
} from './SegmentedChatStore'
import type { ChatMessage, ChatRecord } from './types'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function message(id: string, role: ChatMessage['role'], content: string): ChatMessage {
  return { id, role, content, timestamp: '2026-09-01T00:00:00.000Z' }
}

function durableChat(chatId: string, revision: number, messageIds: string[] = []): ChatRecord {
  return {
    appChatId: chatId,
    provider: 'codex',
    title: 'Stage 3 chat',
    scope: 'global',
    chatKind: 'single',
    createdAt: 1,
    updatedAt: 1,
    persistenceRevision: revision,
    archived: false,
    messages: messageIds.map((id) => message(id, 'user', `Message ${id}`)),
    runs: []
  }
}

/** Bump one revision and append the given message ids. */
function nextRecord(previous: ChatRecord, addedIds: string[]): ChatRecord {
  return {
    ...previous,
    persistenceRevision: (previous.persistenceRevision ?? 0) + 1,
    messages: [...previous.messages, ...addedIds.map((id) => message(id, 'user', `Message ${id}`))]
  }
}

interface WiredStore {
  store: SegmentedChatStore
  baseDir: string
  enabled: { value: boolean }
}

function makeStore(
  overrides: {
    enabledValue?: boolean
    maxSegmentEntries?: number
    maxSegmentBytes?: number
    now?: () => number
  } = {}
): WiredStore {
  const baseDir = mkdtempSync(join(tmpdir(), 'taskwraith-segmented-store-'))
  dirs.push(baseDir)
  const enabled = { value: overrides.enabledValue ?? true }
  const store = createSegmentedChatStore(baseDir, {
    enabled: () => enabled.value,
    canWrite: () => true,
    canRepairOnRead: () => true,
    now: overrides.now ?? (() => 1_800_000_000_000),
    ...(overrides.maxSegmentEntries !== undefined
      ? { maxSegmentEntries: overrides.maxSegmentEntries }
      : {}),
    ...(overrides.maxSegmentBytes !== undefined
      ? { maxSegmentBytes: overrides.maxSegmentBytes }
      : {})
  })
  return { store, baseDir, enabled }
}

function chatFiles(baseDir: string, chatId: string): string[] {
  return readdirSync(baseDir)
    .filter((entry) => entry.startsWith(chatId))
    .sort()
}

describe('isSegmentedChatStoreEnabled', () => {
  it('is off unless the ADR §11.4 flag is exactly "1"', () => {
    expect(isSegmentedChatStoreEnabled({})).toBe(false)
    expect(isSegmentedChatStoreEnabled({ [CHAT_STORE_V2_ENV_FLAG]: '0' })).toBe(false)
    expect(isSegmentedChatStoreEnabled({ [CHAT_STORE_V2_ENV_FLAG]: 'true' })).toBe(false)
    expect(isSegmentedChatStoreEnabled({ [CHAT_STORE_V2_ENV_FLAG]: '1' })).toBe(true)
  })
})

describe('SegmentedChatStore', () => {
  it('is fully inert while the flag is off — no writes, no reads, no probe', () => {
    const { store, baseDir } = makeStore({ enabledValue: false })
    const record = durableChat('chat-off', 1, ['m1'])
    expect(store.mirrorSave(null, record)).toBeNull()
    expect(store.readFull('chat-off')).toBeNull()
    expect(store.prefersV2('chat-off')).toBe(false)
    expect(readdirSync(baseDir)).toEqual([])
    expect(store.stats()).toMatchObject({ mirrorSaves: 0, readAttempts: 0 })
  })

  it('seeds a snapshot + manifest, appends framed batches, and readFull assembles the complete transcript', () => {
    const { store, baseDir } = makeStore()
    const first = durableChat('chat-a', 1, ['m1', 'm2'])
    const second = nextRecord(first, ['m3'])
    const third = nextRecord(second, ['m4', 'm5'])

    expect(store.mirrorSave(null, first)).toEqual({ seeded: true, mutationBytes: 0 })
    expect(store.mirrorSave(first, second)).toMatchObject({ seeded: false })
    expect(store.mirrorSave(second, third)).toMatchObject({ seeded: false })

    expect(chatFiles(baseDir, 'chat-a')).toEqual([
      'chat-a.manifest.json',
      'chat-a.segment-0.jsonl',
      'chat-a.snapshot.json'
    ])
    expect(store.prefersV2('chat-a')).toBe(true)

    const read = store.readFull('chat-a')
    expect(read).not.toBeNull()
    expect(read!.revision).toBe(3)
    expect(read!.record.messages.map((entry) => entry.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
    expect(read!.appliedBatches).toBe(2)
    expect(read!.malformedTailSkips).toBe(0)

    const stats = store.stats()
    expect(stats.seeds).toBe(1)
    expect(stats.mutationBatchesAppended).toBe(2)
    expect(stats.mutationBytesAppended).toBeGreaterThan(0)
    expect(stats.readHits).toBe(1)
    expect(stats.readMisses).toBe(0)
  })

  it('rotates segments at the entry bound and keeps full-history assembly exact', () => {
    const { store, baseDir } = makeStore({ maxSegmentEntries: 3 })
    let prev = durableChat('chat-rotate', 1, ['m1'])
    store.mirrorSave(null, prev)
    for (let step = 2; step <= 9; step += 1) {
      const next = nextRecord(prev, [`m${step}`])
      store.mirrorSave(prev, next)
      prev = next
    }
    const read = store.readFull('chat-rotate')
    expect(read!.record.messages.map((entry) => entry.id)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
      'm6',
      'm7',
      'm8',
      'm9'
    ])
    expect(read!.revision).toBe(9)
    const segments = chatFiles(baseDir, 'chat-rotate').filter((entry) =>
      entry.includes('.segment-')
    )
    expect(segments.length).toBeGreaterThan(1)
    expect(store.stats().segmentRotations).toBeGreaterThanOrEqual(2)
  })

  it('fails closed (null) when no manifest or snapshot exists — legacy fallback stays possible', () => {
    const { store } = makeStore()
    expect(store.readFull('chat-missing')).toBeNull()
    expect(store.stats().readMisses).toBe(1)
  })

  it('skips a torn final line on the active segment and retains prior good records', () => {
    const { store, baseDir } = makeStore()
    const first = durableChat('chat-torn', 1, ['m1'])
    const second = nextRecord(first, ['m2'])
    store.mirrorSave(null, first)
    store.mirrorSave(first, second)
    // Simulate a crash mid-append: a partial final line without a newline.
    appendFileSync(join(baseDir, 'chat-torn.segment-0.jsonl'), '{"format":"taskwrai')
    const read = store.readFull('chat-torn')
    expect(read!.record.messages.map((entry) => entry.id)).toEqual(['m1', 'm2'])
    expect(read!.revision).toBe(2)
    expect(read!.malformedTailSkips).toBe(1)
    expect(store.stats().malformedTailSkips).toBe(1)
  })

  it('quarantines a corrupt closed segment and loads only the earlier good chain', () => {
    const { store, baseDir } = makeStore({ maxSegmentEntries: 2 })
    let prev = durableChat('chat-quarantine', 1, ['m1'])
    store.mirrorSave(null, prev)
    for (let step = 2; step <= 4; step += 1) {
      const next = nextRecord(prev, [`m${step}`])
      store.mirrorSave(prev, next)
      prev = next
    }
    // Corrupt the FIRST (closed) segment mid-file. It holds two batches
    // (rotation happens at 2 entries), so the good prefix ends at m3.
    appendFileSync(join(baseDir, 'chat-quarantine.segment-0.jsonl'), '{"broken":\n')
    const read = store.readFull('chat-quarantine')
    expect(read!.quarantinedThisRead).toBe(1)
    expect(read!.record.messages.map((entry) => entry.id)).toEqual(['m1', 'm2', 'm3'])
    expect(store.stats().quarantinedSegments).toBe(1)
    const quarantineFiles = chatFiles(baseDir, 'chat-quarantine').filter((entry) =>
      entry.includes('.quarantine-')
    )
    expect(quarantineFiles).toHaveLength(1)
    const manifest = JSON.parse(
      readFileSync(join(baseDir, 'chat-quarantine.manifest.json'), 'utf8')
    ) as { quarantined: Array<{ fileName: string; reason: string }> }
    expect(manifest.quarantined).toHaveLength(1)
    expect(manifest.quarantined[0].reason).toContain('corrupt')
  })

  it('re-anchors the baseline when a legacy-only save advanced the record (revision race)', () => {
    const { store } = makeStore()
    store.mirrorSave(null, durableChat('chat-race', 3, ['m1']))
    // A whole-record legacy save the mirror never saw advanced the record.
    const foreign = durableChat('chat-race', 4, ['m1', 'm2'])
    const next = nextRecord(foreign, ['m3'])
    expect(store.mirrorSave(foreign, next)).toMatchObject({ seeded: false })
    expect(store.stats().baselineRepairs).toBe(1)
    const read = store.readFull('chat-race')
    expect(read!.revision).toBe(5)
    expect(read!.record.messages.map((entry) => entry.id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('replaceAuthoritative swaps the baseline and destroys superseded segments', () => {
    const { store, baseDir } = makeStore()
    const first = durableChat('chat-replace', 1, ['m1'])
    const second = nextRecord(first, ['m2'])
    store.mirrorSave(null, first)
    store.mirrorSave(first, second)
    store.replaceAuthoritative('chat-replace', durableChat('chat-replace', 9, ['m1', 'mX']))
    expect(chatFiles(baseDir, 'chat-replace')).toEqual([
      'chat-replace.manifest.json',
      'chat-replace.snapshot.json'
    ])
    const read = store.readFull('chat-replace')
    expect(read!.revision).toBe(9)
    expect(read!.record.messages.map((entry) => entry.id)).toEqual(['m1', 'mX'])
  })

  it('compacts: snapshot at the assembled revision, segments retired to archives', () => {
    const { store, baseDir } = makeStore()
    const first = durableChat('chat-compact', 1, ['m1'])
    const second = nextRecord(first, ['m2'])
    store.mirrorSave(null, first)
    store.mirrorSave(first, second)
    expect(store.checkpoint('chat-compact')).toBe(true)
    const files = chatFiles(baseDir, 'chat-compact')
    expect(files.some((entry) => entry.includes('.archive-'))).toBe(true)
    expect(files.filter((entry) => entry.includes('.segment-'))).toEqual([])
    const manifest = JSON.parse(
      readFileSync(join(baseDir, 'chat-compact.manifest.json'), 'utf8')
    ) as { archives: unknown[]; segments: unknown[]; compactionGeneration: number }
    expect(manifest.segments).toEqual([])
    expect(manifest.archives.length).toBeGreaterThanOrEqual(1)
    expect(manifest.compactionGeneration).toBe(1)
    const read = store.readFull('chat-compact')
    expect(read!.revision).toBe(2)
    expect(read!.record.messages.map((entry) => entry.id)).toEqual(['m1', 'm2'])
    expect(store.stats().compactions).toBe(1)
  })

  it('rollback: disabling the flag stops everything; re-enabling resumes without data loss', () => {
    const { store, enabled } = makeStore()
    const first = durableChat('chat-rollback', 1, ['m1'])
    const second = nextRecord(first, ['m2'])
    store.mirrorSave(null, first)
    store.mirrorSave(first, second)
    expect(store.readFull('chat-rollback')!.revision).toBe(2)

    enabled.value = false
    expect(store.mirrorSave(second, nextRecord(second, ['m3']))).toBeNull()
    expect(store.readFull('chat-rollback')).toBeNull()
    expect(store.prefersV2('chat-rollback')).toBe(false)
    expect(store.checkpoint('chat-rollback')).toBe(false)

    enabled.value = true
    const read = store.readFull('chat-rollback')
    expect(read!.revision).toBe(2)
    expect(read!.record.messages.map((entry) => entry.id)).toEqual(['m1', 'm2'])
  })

  it('recovers from a corrupt manifest: fail closed on read, re-anchor on the next mirror', () => {
    const { store, baseDir } = makeStore()
    const first = durableChat('chat-corrupt', 1, ['m1'])
    store.mirrorSave(null, first)
    writeFileSync(join(baseDir, 'chat-corrupt.manifest.json'), '{not json', 'utf8')
    expect(store.readFull('chat-corrupt')).toBeNull()
    const second = nextRecord(first, ['m2'])
    store.mirrorSave(first, second)
    expect(store.stats().baselineRepairs).toBe(1)
    const read = store.readFull('chat-corrupt')
    expect(read!.revision).toBe(2)
    expect(read!.record.messages.map((entry) => entry.id)).toEqual(['m1', 'm2'])
  })

  it('honours the tombstone and refuses reads', () => {
    const { store, baseDir } = makeStore()
    store.mirrorSave(null, durableChat('chat-deleted', 1, ['m1']))
    writeFileSync(join(baseDir, 'chat-deleted.tombstone'), '', 'utf8')
    expect(store.readFull('chat-deleted')).toBeNull()
    expect(store.prefersV2('chat-deleted')).toBe(false)
  })

  it('purge removes every artifact for the chat (idempotent)', () => {
    const { store, baseDir } = makeStore()
    store.mirrorSave(null, durableChat('chat-purge', 1, ['m1']))
    store.purge('chat-purge')
    expect(chatFiles(baseDir, 'chat-purge')).toEqual([])
    store.purge('chat-purge') // idempotent
    expect(store.readFull('chat-purge')).toBeNull()
    expect(store.stats().purges).toBe(2)
  })

  it('clear removes every artifact for every chat', () => {
    const { store, baseDir } = makeStore()
    store.mirrorSave(null, durableChat('chat-clear-a', 1, ['m1']))
    store.mirrorSave(null, durableChat('chat-clear-b', 1, ['m1']))
    store.clear()
    // clear() retires the store root itself (journal parity).
    expect(existsSync(baseDir)).toBe(false)
    expect(store.readFull('chat-clear-a')).toBeNull()
  })

  it('rejects unsafe chat ids on every mutation and read entry point', () => {
    const { store } = makeStore()
    expect(() => store.mirrorSave(null, durableChat('../escape', 1, ['m1']))).toThrow(
      /Unsafe chat id/
    )
    expect(() => store.readFull('../escape')).toThrow(/Unsafe chat id/)
    expect(() => store.purge('../escape')).toThrow(/Unsafe chat id/)
    expect(() => store.replaceAuthoritative('../escape', durableChat('../escape', 1, []))).toThrow(
      /Unsafe chat id/
    )
  })

  it('treats checkpointIdle/checkpointAll as no-ops while the flag is off', () => {
    const { store } = makeStore({ enabledValue: false })
    expect(store.checkpointIdle()).toBe(0)
    expect(store.checkpointAll()).toBe(0)
  })

  it('does not compact idle chats inside the idle window, then compacts after it', () => {
    const { store } = makeStore()
    const prev = durableChat('chat-idle', 1, ['m1'])
    store.mirrorSave(null, prev)
    const next = nextRecord(prev, ['m2'])
    store.mirrorSave(prev, next)
    expect(store.checkpointIdle(1_800_000_000_000)).toBe(0)
    expect(store.checkpointIdle(1_800_000_100_000)).toBeGreaterThanOrEqual(1)
    expect(store.stats().compactions).toBeGreaterThanOrEqual(1)
  })
})

describe('Stage 5 — COW fork prefixes (forkSharePrefix)', () => {
  function forkRecordOf(parent: ChatRecord, forkChatId: string): ChatRecord {
    return {
      ...durableChat(
        forkChatId,
        0,
        parent.messages.map((entry) => entry.id)
      ),
      title: `Fork of ${parent.title}`,
      forkContext: {
        kind: 'emulated',
        createdAt: 1,
        sourceChatId: parent.appChatId
      }
    } as ChatRecord
  }

  it('seeds a fork as chrome-only snapshot + pinned parent prefix — no transcript payload copy', () => {
    const { store, baseDir } = makeStore()
    let parent = durableChat('chat-parent', 1, ['m1', 'm2'])
    store.mirrorSave(null, parent)
    parent = nextRecord(parent, ['m3'])
    store.mirrorSave(durableChat('chat-parent', 1, ['m1', 'm2']), parent)
    const parentFilesBefore = chatFiles(baseDir, 'chat-parent')
    const parentSnapshotBytes = readFileSync(join(baseDir, 'chat-parent.snapshot.json')).length

    const fork = forkRecordOf(parent, 'chat-fork')
    expect(store.forkSharePrefix('chat-parent', fork)).toEqual({ seeded: true, mutationBytes: 0 })

    // The fork owns no segment files and no transcript bytes in its snapshot.
    expect(chatFiles(baseDir, 'chat-fork')).toEqual([
      'chat-fork.manifest.json',
      'chat-fork.snapshot.json'
    ])
    const forkSnapshot = JSON.parse(readFileSync(join(baseDir, 'chat-fork.snapshot.json'), 'utf8'))
    expect(forkSnapshot.record.messages).toEqual([])
    expect(forkSnapshot.record.runs).toEqual([])
    expect(forkSnapshot.record.title).toBe('Fork of Stage 3 chat')
    expect(readFileSync(join(baseDir, 'chat-fork.snapshot.json')).length).toBeLessThan(
      parentSnapshotBytes
    )
    // Parent artifacts untouched.
    expect(chatFiles(baseDir, 'chat-parent')).toEqual(parentFilesBefore)
    expect(store.stats().prefixForks).toBe(1)

    // Full-history assembly resolves through the prefix transparently.
    const read = store.readFull('chat-fork')
    expect(read).not.toBeNull()
    expect(read!.record.appChatId).toBe('chat-fork')
    expect(read!.record.title).toBe('Fork of Stage 3 chat')
    expect(read!.record.messages.map((entry) => entry.id)).toEqual(['m1', 'm2', 'm3'])
    expect(store.prefersV2('chat-fork')).toBe(true)
  })

  it('keeps post-fork mutations independent in both directions', () => {
    const { store } = makeStore()
    let parent = durableChat('chat-p2', 1, ['m1'])
    store.mirrorSave(null, parent)
    parent = nextRecord(parent, ['m2'])
    store.mirrorSave(durableChat('chat-p2', 1, ['m1']), parent)

    const fork = forkRecordOf(parent, 'chat-f2')
    store.forkSharePrefix('chat-p2', fork)

    // Fork-side mutation appends on the fork's own revision domain.
    const forkNext = nextRecord(fork, ['f1'])
    expect(store.mirrorSave(fork, forkNext)).toMatchObject({ seeded: false })
    const forkRead = store.readFull('chat-f2')
    expect(forkRead!.record.messages.map((entry) => entry.id)).toEqual(['m1', 'm2', 'f1'])
    expect(forkRead!.revision).toBe(1)

    // Parent's future never leaks through the pinned prefix.
    const parentNext = nextRecord(parent, ['m3'])
    store.mirrorSave(parent, parentNext)
    const forkAfter = store.readFull('chat-f2')
    expect(forkAfter!.record.messages.map((entry) => entry.id)).toEqual(['m1', 'm2', 'f1'])
    const parentRead = store.readFull('chat-p2')
    expect(parentRead!.record.messages.map((entry) => entry.id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('is inert while the flag is off and declines parents without a healthy baseline', () => {
    const { store, baseDir } = makeStore({ enabledValue: false })
    const parent = durableChat('chat-off-parent', 1, ['m1'])
    expect(
      store.forkSharePrefix('chat-off-parent', forkRecordOf(parent, 'chat-off-fork'))
    ).toBeNull()
    expect(readdirSync(baseDir)).toEqual([])
    expect(store.stats().prefixForks).toBe(0)

    const { store: onStore } = makeStore()
    const ghost = durableChat('chat-ghost', 1, ['m1'])
    expect(onStore.forkSharePrefix('chat-ghost', forkRecordOf(ghost, 'chat-gf'))).toBeNull()
    // Self-share is nonsense and must be refused.
    expect(onStore.forkSharePrefix('chat-ghost', ghost)).toBeNull()
  })

  it('fails closed when the parent compacts, then self-heals on the next fork mirror', () => {
    const { store } = makeStore()
    let parent = durableChat('chat-pc', 1, ['m1'])
    store.mirrorSave(null, parent)
    parent = nextRecord(parent, ['m2'])
    store.mirrorSave(durableChat('chat-pc', 1, ['m1']), parent)

    const fork = forkRecordOf(parent, 'chat-fc')
    store.forkSharePrefix('chat-pc', fork)
    expect(store.readFull('chat-fc')!.record.messages).toHaveLength(2)

    // Parent compaction rewrites the pinned snapshot — the fork's pin fails.
    expect(store.checkpoint('chat-pc')).toBe(true)
    expect(store.readFull('chat-fc')).toBeNull()

    // The next fork-side mirror re-seeds fully (prefix dropped), so the fork
    // is healthy again without any v1-visible gap.
    const forkNext = nextRecord(fork, ['f1'])
    expect(store.mirrorSave(fork, forkNext)).toMatchObject({ seeded: false })
    const healed = store.readFull('chat-fc')
    expect(healed).not.toBeNull()
    expect(healed!.record.messages.map((entry) => entry.id)).toEqual(['m1', 'm2', 'f1'])
    expect(healed!.record.appChatId).toBe('chat-fc')
  })

  it('fails closed when the parent is purged (no dangling prefix read), then self-heals', () => {
    const { store } = makeStore()
    const parent = durableChat('chat-pp', 1, ['m1', 'm2'])
    store.mirrorSave(null, parent)
    const fork = forkRecordOf(parent, 'chat-fp')
    store.forkSharePrefix('chat-pp', fork)
    expect(store.readFull('chat-fp')!.record.messages).toHaveLength(2)

    store.purge('chat-pp')
    expect(store.readFull('chat-fp')).toBeNull()

    const forkNext = nextRecord(fork, ['f1'])
    store.mirrorSave(fork, forkNext)
    expect(store.readFull('chat-fp')!.record.messages.map((entry) => entry.id)).toEqual([
      'm1',
      'm2',
      'f1'
    ])
  })
})
