import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatRecord } from '../../../main/store/types'
import { DEFAULT_TRANSCRIPT_PAGE_MAX_MESSAGES } from '../../../shared/transcriptPage'
import type { ChatShell, TranscriptPage } from '../../../shared/transcriptPage'
import {
  createSurfaceChatHydrator,
  isSurfaceChatHydrated,
  type SurfaceChatHydratorDeps
} from './chatSurfacePagedHydration'
import { ChatTranscriptStore } from './chatTranscriptStore'

const OVER_BUDGET = DEFAULT_TRANSCRIPT_PAGE_MAX_MESSAGES + 1

function message(id: string): ChatMessage {
  return { id, role: 'assistant', content: `body ${id}`, timestamp: '1' }
}

function summaryRow(chatId: string, messageCount: number): ChatRecord {
  return {
    appChatId: chatId,
    title: 'T',
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    messages: [],
    runs: [],
    summaryOnly: true,
    messageCount
  } as unknown as ChatRecord
}

function fullRecord(chatId: string): ChatRecord {
  return {
    appChatId: chatId,
    title: 'T',
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    messages: [message('m1')],
    runs: []
  } as ChatRecord
}

function shellOf(chatId: string, messageCount: number): ChatShell {
  return { ...summaryRow(chatId, messageCount), transcriptPaged: true } as ChatShell
}

function tailPage(chatId: string, shell?: ChatShell): TranscriptPage {
  return {
    chatId,
    messages: [message('m-tail')],
    runs: [],
    totalMessageCount: OVER_BUDGET,
    windowStart: OVER_BUDGET - 1,
    windowEnd: OVER_BUDGET,
    estimatedBytes: 64,
    hasOlder: true,
    hasNewer: false,
    oldestMessageId: 'm-tail',
    newestMessageId: 'm-tail',
    updatedAt: 2,
    ...(shell ? { shell } : {})
  }
}

function makeDeps(overrides: Partial<SurfaceChatHydratorDeps> = {}): {
  deps: SurfaceChatHydratorDeps
  store: ChatTranscriptStore
  fullHydrate: ReturnType<typeof vi.fn>
  commitPagedShell: ReturnType<typeof vi.fn>
  fetchPagedShell: ReturnType<typeof vi.fn>
} {
  const store = new ChatTranscriptStore()
  const fullHydrate = vi.fn(async (chatId: string) => fullRecord(chatId))
  const commitPagedShell = vi.fn((shell: ChatShell, page: TranscriptPage): ChatRecord => {
    store.ingestPage(page)
    return shell
  })
  const fetchPagedShell = vi.fn(async (chatId: string) => ({
    shell: shellOf(chatId, OVER_BUDGET),
    page: tailPage(chatId)
  }))
  const deps: SurfaceChatHydratorDeps = {
    resolveChat: () => null,
    transcriptStore: store,
    fullHydrate,
    commitPagedShell,
    fetchPagedShell,
    ...overrides
  }
  return { deps, store, fullHydrate, commitPagedShell, fetchPagedShell }
}

describe('isSurfaceChatHydrated', () => {
  it('treats a full record as hydrated', () => {
    const store = new ChatTranscriptStore()
    expect(isSurfaceChatHydrated(fullRecord('c1'), store)).toBe(true)
  })

  it('treats a plain summary row as not hydrated', () => {
    const store = new ChatTranscriptStore()
    expect(isSurfaceChatHydrated(summaryRow('c1', 3), store)).toBe(false)
  })

  it('treats a marked shell as hydrated ONLY while the store holds its window', () => {
    const store = new ChatTranscriptStore()
    const shell = shellOf('c1', OVER_BUDGET)
    // Shell without a loaded window (e.g. after retention dropped the store
    // entry): must read as re-hydratable, never as presentable.
    expect(isSurfaceChatHydrated(shell, store)).toBe(false)
    store.ingestPage(tailPage('c1'))
    expect(isSurfaceChatHydrated(shell, store)).toBe(true)
  })
})

describe('createSurfaceChatHydrator', () => {
  it('opens an over-budget summary as shell + tail page, never full hydration', async () => {
    const row = summaryRow('big', OVER_BUDGET)
    const { deps, fullHydrate, commitPagedShell, fetchPagedShell } = makeDeps({
      resolveChat: () => row
    })
    const hydrate = createSurfaceChatHydrator(deps)

    const result = await hydrate('big')

    expect(fetchPagedShell).toHaveBeenCalledWith('big', row)
    expect(commitPagedShell).toHaveBeenCalledTimes(1)
    expect(fullHydrate).not.toHaveBeenCalled()
    expect(result).toBe(commitPagedShell.mock.results[0]?.value)
  })

  it('full-hydrates a summary under the page budget without fetching a page', async () => {
    const { deps, fullHydrate, fetchPagedShell } = makeDeps({
      resolveChat: () => summaryRow('small', 3)
    })
    const hydrate = createSurfaceChatHydrator(deps)

    const result = await hydrate('small')

    expect(fetchPagedShell).not.toHaveBeenCalled()
    expect(fullHydrate).toHaveBeenCalledWith('small')
    expect(result?.appChatId).toBe('small')
  })

  it('full-hydrates when the renderer has no row to size the decision from', async () => {
    const { deps, fullHydrate, fetchPagedShell } = makeDeps({ resolveChat: () => null })
    const hydrate = createSurfaceChatHydrator(deps)

    await hydrate('unknown')

    expect(fetchPagedShell).not.toHaveBeenCalled()
    expect(fullHydrate).toHaveBeenCalledWith('unknown')
  })

  it('returns an already-full record untouched', async () => {
    const record = fullRecord('done')
    const { deps, fullHydrate, fetchPagedShell } = makeDeps({ resolveChat: () => record })
    const hydrate = createSurfaceChatHydrator(deps)

    expect(await hydrate('done')).toBe(record)
    expect(fullHydrate).not.toHaveBeenCalled()
    expect(fetchPagedShell).not.toHaveBeenCalled()
  })

  it('returns an already-paged shell untouched while its window is loaded', async () => {
    const shell = shellOf('paged', OVER_BUDGET)
    const { deps, store, fullHydrate, fetchPagedShell } = makeDeps({
      resolveChat: () => shell
    })
    store.ingestPage(tailPage('paged'))
    const hydrate = createSurfaceChatHydrator(deps)

    expect(await hydrate('paged')).toBe(shell)
    expect(fullHydrate).not.toHaveBeenCalled()
    expect(fetchPagedShell).not.toHaveBeenCalled()
  })

  it('re-fetches the window for a shell whose store entry was dropped', async () => {
    // Residency eviction can drop the store window while the shell record is
    // still in chat state; the next surface open must repair the window
    // instead of presenting a permanently blank shell.
    const shell = shellOf('evicted', OVER_BUDGET)
    const { deps, fetchPagedShell, commitPagedShell, fullHydrate } = makeDeps({
      resolveChat: () => shell
    })
    const hydrate = createSurfaceChatHydrator(deps)

    await hydrate('evicted')

    expect(fetchPagedShell).toHaveBeenCalledTimes(1)
    expect(commitPagedShell).toHaveBeenCalledTimes(1)
    expect(fullHydrate).not.toHaveBeenCalled()
  })

  it('falls back to full hydration when the paged fetch returns null', async () => {
    const { deps, fullHydrate } = makeDeps({
      resolveChat: () => summaryRow('big', OVER_BUDGET),
      fetchPagedShell: vi.fn(async () => null)
    })
    const hydrate = createSurfaceChatHydrator(deps)

    const result = await hydrate('big')

    expect(fullHydrate).toHaveBeenCalledWith('big')
    expect(result?.appChatId).toBe('big')
  })

  it('falls back to full hydration when the paged fetch rejects', async () => {
    const { deps, fullHydrate } = makeDeps({
      resolveChat: () => summaryRow('big', OVER_BUDGET),
      fetchPagedShell: vi.fn(async () => {
        throw new Error('ipc failed')
      })
    })
    const hydrate = createSurfaceChatHydrator(deps)

    const result = await hydrate('big')

    expect(fullHydrate).toHaveBeenCalledWith('big')
    expect(result?.appChatId).toBe('big')
  })

  it('single-flights concurrent paged opens for the same chat', async () => {
    let release: (value: { shell: ChatShell; page: TranscriptPage } | null) => void = () => {}
    const gate = new Promise<{ shell: ChatShell; page: TranscriptPage } | null>((resolve) => {
      release = resolve
    })
    const fetchPagedShell = vi.fn(() => gate)
    const { deps, commitPagedShell } = makeDeps({
      resolveChat: () => summaryRow('big', OVER_BUDGET),
      fetchPagedShell
    })
    const hydrate = createSurfaceChatHydrator(deps)

    const first = hydrate('big')
    const second = hydrate('big')
    release({ shell: shellOf('big', OVER_BUDGET), page: tailPage('big') })
    const [a, b] = await Promise.all([first, second])

    expect(fetchPagedShell).toHaveBeenCalledTimes(1)
    expect(commitPagedShell).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
  })

  it('allows a fresh paged open after the previous flight settled', async () => {
    const row = summaryRow('big', OVER_BUDGET)
    let resolveOverride: ChatRecord | null = null
    const { deps, fetchPagedShell } = makeDeps({
      resolveChat: () => resolveOverride ?? row
    })
    const hydrate = createSurfaceChatHydrator(deps)

    await hydrate('big')
    // Simulate the committed shell being dropped again later.
    resolveOverride = row
    await hydrate('big')

    expect(fetchPagedShell).toHaveBeenCalledTimes(2)
  })

  it('resolves null for an empty chat id without touching any dependency', async () => {
    const { deps, fullHydrate, fetchPagedShell } = makeDeps()
    const hydrate = createSurfaceChatHydrator(deps)

    expect(await hydrate('')).toBeNull()
    expect(fullHydrate).not.toHaveBeenCalled()
    expect(fetchPagedShell).not.toHaveBeenCalled()
  })
})
