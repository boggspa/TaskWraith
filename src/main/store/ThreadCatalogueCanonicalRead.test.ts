import { describe, expect, it, vi } from 'vitest'
import {
  readCanonicalCatalogueChat,
  type CanonicalCatalogueReadSources
} from './ThreadCatalogueCanonicalRead'
import type { ChatRecord } from './types'

function record(revision: number, title: string): ChatRecord {
  return {
    appChatId: 'chat',
    persistenceRevision: revision,
    title,
    messages: [],
    runs: []
  } as unknown as ChatRecord
}

function source(
  overrides: Partial<CanonicalCatalogueReadSources> = {}
): CanonicalCatalogueReadSources {
  return {
    chatId: 'chat',
    legacyFileExists: true,
    normalize: (chat) => chat,
    readLegacy: () => record(2, 'legacy'),
    readIncremental: () => null,
    pendingReplayState: () => ({ hasTail: true, checkpointRevision: 1 }),
    logger: { error: vi.fn(), warn: vi.fn() },
    ...overrides
  }
}

describe('canonical catalogue source selection', () => {
  it('does not resurrect a deleted legacy chat from residual segments', () => {
    const readSegmented = vi.fn(() => record(99, 'erased history'))
    const sources = source({ legacyFileExists: false, readSegmented })
    expect(readCanonicalCatalogueChat(sources)).toBeNull()
    expect(readSegmented).not.toHaveBeenCalled()
  })
  it('keeps a journal-only wakeup visible while the legacy file lags', () => {
    const pending = {
      ...record(3, 'journal'),
      soloWakeups: { wake: { status: 'pending' } }
    } as unknown as ChatRecord
    const actual = readCanonicalCatalogueChat(source({ readIncremental: () => pending }))
    expect(actual).toBe(pending)
  })

  it('uses legacy on an equal-revision journal disagreement', () => {
    const sources = source({ readIncremental: () => record(2, 'disagrees') })
    expect(readCanonicalCatalogueChat(sources)?.title).toBe('legacy')
    expect(sources.logger?.warn).toHaveBeenCalledOnce()
  })

  it('does not decode a folded checkpoint that cannot lead', () => {
    const readIncremental = vi.fn(() => record(2, 'folded'))
    const sources = source({
      readIncremental,
      pendingReplayState: () => ({ hasTail: false, checkpointRevision: 2 })
    })
    expect(readCanonicalCatalogueChat(sources)?.title).toBe('legacy')
    expect(readIncremental).not.toHaveBeenCalled()
  })

  it('reads a leading checkpoint even when it has no mutation tail', () => {
    const sources = source({
      readIncremental: () => record(4, 'leading checkpoint'),
      pendingReplayState: () => ({ hasTail: false, checkpointRevision: 4 })
    })
    expect(readCanonicalCatalogueChat(sources)?.title).toBe('leading checkpoint')
  })

  it('preserves the legacy-plus-journal winner on an equal-revision segmented disagreement', () => {
    const sources = source({
      readIncremental: () => record(3, 'journal'),
      readSegmented: () => record(3, 'segmented disagreement')
    })
    expect(readCanonicalCatalogueChat(sources)?.title).toBe('journal')
  })

  it('uses a healthy leading segmented record only when that source is enabled', () => {
    const sources = source({ readSegmented: () => record(4, 'segmented') })
    expect(readCanonicalCatalogueChat(sources)?.title).toBe('segmented')
    delete sources.readSegmented
    expect(readCanonicalCatalogueChat(sources)?.title).toBe('legacy')
  })

  it('preserves legacy when journal replay fails', () => {
    const sources = source({
      readIncremental: () => {
        throw new Error('revision gap')
      }
    })
    expect(readCanonicalCatalogueChat(sources)?.title).toBe('legacy')
    expect(sources.logger?.error).toHaveBeenCalledOnce()
  })
})
