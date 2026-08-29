import { describe, expect, it, vi } from 'vitest'

import {
  collectOrphanSubThreadCandidates,
  indexEntryVouchesForSource,
  type OrphanSubThreadIndexEntry,
  type OrphanSubThreadRecord,
  type OrphanSubThreadScanDeps
} from './OrphanSubThreadScan'

interface Chat {
  chatId: string
  appChatId?: string
  parentChatId?: string
  mtimeMs: number
  size: number
}

/** Builds a scan over an in-memory corpus. `indexed` decides which chats the
 *  index vouches for; every other chat must reach the expensive read. */
function scanOver(
  chats: Chat[],
  options: { indexed?: (chat: Chat) => OrphanSubThreadIndexEntry | undefined } = {}
): { deps: OrphanSubThreadScanDeps; readChatRecord: ReturnType<typeof vi.fn> } {
  const present = new Set(chats.map((chat) => chat.chatId))
  const readChatRecord = vi.fn((chatId: string): OrphanSubThreadRecord | null => {
    const chat = chats.find((candidate) => candidate.chatId === chatId)
    if (!chat) return null
    return { appChatId: chat.appChatId ?? chat.chatId, parentChatId: chat.parentChatId }
  })
  const indexed =
    options.indexed ??
    ((chat: Chat): OrphanSubThreadIndexEntry => ({
      appChatId: chat.appChatId ?? chat.chatId,
      parentChatId: chat.parentChatId,
      sourceChatMtimeMs: chat.mtimeMs,
      sourceChatSize: chat.size
    }))

  return {
    readChatRecord,
    deps: {
      listChatIds: () => chats.map((chat) => chat.chatId),
      statChatFile: (chatId) => {
        const chat = chats.find((candidate) => candidate.chatId === chatId)
        return chat ? { mtimeMs: chat.mtimeMs, size: chat.size } : null
      },
      indexEntry: (chatId) => {
        const chat = chats.find((candidate) => candidate.chatId === chatId)
        return chat ? indexed(chat) : undefined
      },
      readChatRecord,
      parentChatExists: (parentChatId) => present.has(parentChatId)
    }
  }
}

const CORPUS: Chat[] = [
  { chatId: 'root-a', mtimeMs: 10, size: 100 },
  { chatId: 'child-of-a', parentChatId: 'root-a', mtimeMs: 11, size: 101 },
  { chatId: 'orphan-1', parentChatId: 'deleted-root', mtimeMs: 12, size: 102 },
  { chatId: 'orphan-2', appChatId: 'ios-orphan-2', parentChatId: 'gone', mtimeMs: 13, size: 103 },
  { chatId: 'root-b', mtimeMs: 14, size: 104 }
]

describe('orphan sub-thread scan', () => {
  it('answers from the index without reading a single chat record', () => {
    const { deps, readChatRecord } = scanOver(CORPUS)

    const result = collectOrphanSubThreadCandidates(deps)

    expect(result.candidates).toEqual(['orphan-1', 'ios-orphan-2'])
    expect(result.fullReads).toBe(0)
    expect(readChatRecord).not.toHaveBeenCalled()
  })

  it('keys candidates by appChatId, not by the file name', () => {
    const { deps } = scanOver(CORPUS)

    expect(collectOrphanSubThreadCandidates(deps).candidates).toContain('ios-orphan-2')
    expect(collectOrphanSubThreadCandidates(deps).candidates).not.toContain('orphan-2')
  })

  it('falls back to the full read when the file changed under the index', () => {
    const { deps, readChatRecord } = scanOver(CORPUS, {
      indexed: (chat) => ({
        appChatId: chat.appChatId ?? chat.chatId,
        parentChatId: chat.chatId === 'orphan-1' ? undefined : chat.parentChatId,
        // Stale mtime for orphan-1 only: the index would otherwise hide it.
        sourceChatMtimeMs: chat.chatId === 'orphan-1' ? chat.mtimeMs - 1 : chat.mtimeMs,
        sourceChatSize: chat.size
      })
    })

    const result = collectOrphanSubThreadCandidates(deps)

    expect(readChatRecord).toHaveBeenCalledTimes(1)
    expect(readChatRecord).toHaveBeenCalledWith('orphan-1')
    expect(result.fullReads).toBe(1)
    expect(result.candidates).toEqual(['orphan-1', 'ios-orphan-2'])
  })

  it('treats a size change as staleness even when the mtime matches', () => {
    const { deps, readChatRecord } = scanOver(CORPUS, {
      indexed: (chat) => ({
        appChatId: chat.appChatId ?? chat.chatId,
        parentChatId: undefined,
        sourceChatMtimeMs: chat.mtimeMs,
        sourceChatSize: chat.size + 1
      })
    })

    const result = collectOrphanSubThreadCandidates(deps)

    expect(readChatRecord).toHaveBeenCalledTimes(CORPUS.length)
    expect(result.candidates).toEqual(['orphan-1', 'ios-orphan-2'])
  })

  it('falls back when the index has no entry at all', () => {
    const { deps, readChatRecord } = scanOver(CORPUS, { indexed: () => undefined })

    const result = collectOrphanSubThreadCandidates(deps)

    expect(result.fullReads).toBe(CORPUS.length)
    expect(readChatRecord).toHaveBeenCalledTimes(CORPUS.length)
    expect(result.candidates).toEqual(['orphan-1', 'ios-orphan-2'])
  })

  it('refuses a partial index entry rather than trusting half an answer', () => {
    expect(
      indexEntryVouchesForSource({ appChatId: 'a', sourceChatSize: 1 }, { mtimeMs: 1, size: 1 })
    ).toBe(false)
    expect(
      indexEntryVouchesForSource({ appChatId: 'a', sourceChatMtimeMs: 1 }, { mtimeMs: 1, size: 1 })
    ).toBe(false)
    expect(
      indexEntryVouchesForSource(
        { appChatId: '', sourceChatMtimeMs: 1, sourceChatSize: 1 },
        { mtimeMs: 1, size: 1 }
      )
    ).toBe(false)
    expect(indexEntryVouchesForSource(undefined, { mtimeMs: 1, size: 1 })).toBe(false)
    expect(
      indexEntryVouchesForSource({ appChatId: 'a', sourceChatMtimeMs: 1, sourceChatSize: 1 }, null)
    ).toBe(false)
  })

  it('produces the same candidate set whether or not the index is trusted', () => {
    const viaIndex = collectOrphanSubThreadCandidates(scanOver(CORPUS).deps)
    const viaFullRead = collectOrphanSubThreadCandidates(
      scanOver(CORPUS, { indexed: () => undefined }).deps
    )

    expect(viaIndex.candidates).toEqual(viaFullRead.candidates)
    expect(viaIndex.fullReads).toBe(0)
    expect(viaFullRead.fullReads).toBe(CORPUS.length)
  })

  it('skips a chat whose record cannot be read at all', () => {
    const chats: Chat[] = [{ chatId: 'unreadable', parentChatId: 'gone', mtimeMs: 1, size: 1 }]
    const { deps } = scanOver(chats, { indexed: () => undefined })
    deps.readChatRecord = () => null

    expect(collectOrphanSubThreadCandidates(deps).candidates).toEqual([])
  })
})
