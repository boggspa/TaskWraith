/**
 * Host Arc Wave 3.6b — HostProductionSuppliers tests.
 *
 * BOUNDARIES:
 * - import-isolation test (no electron, AppStore, Bridge, provider, store,
 *   resolver, pipeline)
 * - mapper tests (ChatListEntry → HostThreadProjection)
 * - empty-list / populated-list / store-failure
 * - workspace derivation
 * - honesty: usage always unavailable, no fabricated counts
 */

import { describe, expect, it, vi } from 'vitest'

import { projectHostSnapshot } from './HostSnapshotProjector'
import {
  createHostProductionSuppliers,
  type HostProductionChatListEntry,
  type HostProductionChatListPort
} from './HostProductionSuppliers'

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function makeEntry(
  overrides: Partial<HostProductionChatListEntry> = {}
): HostProductionChatListEntry {
  return {
    appChatId: 'chat-1',
    title: 'Test Chat',
    archived: false,
    updatedAt: 1700000000000,
    messageCount: 5,
    ...overrides
  }
}

function makePort(entries: HostProductionChatListEntry[] = []): HostProductionChatListPort {
  return {
    getChatList: vi.fn(() => entries)
  }
}

/* ------------------------------------------------------------------ */
/*  Import isolation                                                  */
/* ------------------------------------------------------------------ */

describe('HostProductionSuppliers import isolation', () => {
  it('imports zero electron symbols', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').resolve(__dirname, 'HostProductionSuppliers.ts'),
      'utf-8'
    )
    const imports = src
      .split('\n')
      .filter((l: string) => l.startsWith('import ') && l.includes("from '"))
    const electronImports = imports.filter(
      (l: string) => l.includes("'electron'") || l.includes('"electron"')
    )
    expect(electronImports).toHaveLength(0)
  })

  it('imports zero AppStore / BridgeActionExecutor / provider symbols', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').resolve(__dirname, 'HostProductionSuppliers.ts'),
      'utf-8'
    )
    const imports = src
      .split('\n')
      .filter((l: string) => l.startsWith('import ') && l.includes("from '"))
    const forbidden = imports.filter(
      (l: string) =>
        l.includes('AppStore') ||
        l.includes('BridgeActionExecutor') ||
        l.includes("'../provider") ||
        l.includes("'../providers")
    )
    expect(forbidden).toHaveLength(0)
  })

  it('imports zero store / resolver / pipeline VALUE symbols', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').resolve(__dirname, 'HostProductionSuppliers.ts'),
      'utf-8'
    )
    const imports = src
      .split('\n')
      .filter((l: string) => l.startsWith('import ') && l.includes("from '"))
    const forbidden = imports.filter(
      (l: string) =>
        l.includes("'../store") ||
        l.includes("'./HostDeferredCommandEnvelopeResolver") ||
        l.includes("'./HostDeferredAllowPipeline") ||
        l.includes("'./HostCommandMutationPipeline") ||
        l.includes("'./HostLocalServer") ||
        l.includes("'./HostSupervisor")
    )
    expect(forbidden).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ */
/*  Empty / unavailable                                               */
/* ------------------------------------------------------------------ */

describe('HostProductionSuppliers empty state', () => {
  it('returns empty arrays when the chat list is empty', async () => {
    const donor = createHostProductionSuppliers({ chatList: makePort([]) })
    const families = await donor()

    expect(families.threads).toEqual([])
    expect(families.workspaces).toEqual([])
  })

  it('returns honest usage (unavailable, never zero tokens)', async () => {
    const donor = createHostProductionSuppliers({ chatList: makePort([]) })
    const families = await donor()

    expect(families.usage.availability).toBe('unavailable')
    expect(families.usage.tokens).toBeUndefined()
    expect(families.usage.confidence).toBe('unknown')
    expect(families.usage.band).toBe('unknown')
  })

  it('returns honest health (ok / live / supervised / live freshness)', async () => {
    const donor = createHostProductionSuppliers({ chatList: makePort([]) })
    const families = await donor()

    expect(families.health).toEqual({
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: true,
      freshness: 'live'
    })
  })

  it('returns empty questions, approvals, schedules, artifacts, warnings', async () => {
    const donor = createHostProductionSuppliers({ chatList: makePort([]) })
    const families = await donor()

    expect(families.questions).toEqual([])
    expect(families.approvals).toEqual([])
    expect(families.schedules).toEqual([])
    expect(families.artifacts).toEqual([])
    expect(families.warnings).toEqual([])
    expect(families.runs).toEqual([])
    expect(families.missions).toEqual([])
    expect(families.rounds).toEqual([])
    expect(families.participants).toEqual([])
    expect(families.providers).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/*  Thread mapping — single entry                                     */
/* ------------------------------------------------------------------ */

describe('HostProductionSuppliers thread mapping', () => {
  it('maps appChatId → id', async () => {
    const donor = createHostProductionSuppliers({
      chatList: makePort([makeEntry({ appChatId: 'abc-123' })])
    })
    const families = await donor()
    expect(families.threads[0].id).toBe('abc-123')
  })

  it('maps title verbatim', async () => {
    const donor = createHostProductionSuppliers({
      chatList: makePort([makeEntry({ title: 'My Thread' })])
    })
    const families = await donor()
    expect(families.threads[0].title).toBe('My Thread')
  })

  it('maps workspaceId → workspaceId (null when absent)', async () => {
    const donor = createHostProductionSuppliers({
      chatList: makePort([
        makeEntry({ appChatId: 'a', workspaceId: 'ws-1' }),
        makeEntry({ appChatId: 'b', workspaceId: null }),
        makeEntry({ appChatId: 'c' }) // no workspaceId key at all
      ])
    })
    const families = await donor()

    expect(families.threads[0].workspaceId).toBe('ws-1')
    expect(families.threads[1].workspaceId).toBeNull()
    expect(families.threads[2].workspaceId).toBeNull()
  })

  it('emits parentThreadId when parentChatId is present', async () => {
    const donor = createHostProductionSuppliers({
      chatList: makePort([makeEntry({ appChatId: 'child', parentChatId: 'parent-1' })])
    })
    const families = await donor()
    expect(families.threads[0]).toHaveProperty('parentThreadId', 'parent-1')
  })

  it('omits parentThreadId when parentChatId is absent', async () => {
    const donor = createHostProductionSuppliers({
      chatList: makePort([makeEntry({ appChatId: 'orphan', parentChatId: null })])
    })
    const families = await donor()
    expect(families.threads[0]).not.toHaveProperty('parentThreadId')
  })

  it('maps chatKind: ensemble stays ensemble, everything else → single', async () => {
    const donor = createHostProductionSuppliers({
      chatList: makePort([
        makeEntry({ appChatId: 'a', chatKind: 'ensemble' }),
        makeEntry({ appChatId: 'b', chatKind: 'single' }),
        makeEntry({ appChatId: 'c', chatKind: null }),
        makeEntry({ appChatId: 'd' }) // no chatKind at all
      ])
    })
    const families = await donor()

    expect(families.threads[0].chatKind).toBe('ensemble')
    expect(families.threads[1].chatKind).toBe('single')
    expect(families.threads[2].chatKind).toBe('single')
    expect(families.threads[3].chatKind).toBe('single')
  })

  it('maps archived and pinned', async () => {
    const donor = createHostProductionSuppliers({
      chatList: makePort([
        makeEntry({ appChatId: 'a', archived: true, pinned: true }),
        makeEntry({ appChatId: 'b', archived: false, pinned: false }),
        makeEntry({ appChatId: 'c', archived: false }) // pinned absent → defaults false
      ])
    })
    const families = await donor()

    expect(families.threads[0].archived).toBe(true)
    expect(families.threads[0].pinned).toBe(true)
    expect(families.threads[1].archived).toBe(false)
    expect(families.threads[1].pinned).toBe(false)
    expect(families.threads[2].pinned).toBe(false)
  })

  it('maps messageCount verbatim — count is already honest from getChatList', async () => {
    const donor = createHostProductionSuppliers({
      chatList: makePort([
        makeEntry({ appChatId: 'a', messageCount: 42 }),
        makeEntry({ appChatId: 'b', messageCount: 0 })
      ])
    })
    const families = await donor()
    expect(families.threads[0].messageCount).toBe(42)
    expect(families.threads[1].messageCount).toBe(0)
  })

  it('emits latestPreview from searchPreview', async () => {
    const donor = createHostProductionSuppliers({
      chatList: makePort([makeEntry({ appChatId: 'a', searchPreview: 'hello world' })])
    })
    const families = await donor()
    expect(families.threads[0]).toHaveProperty('latestPreview', 'hello world')
  })

  it('omits latestPreview when searchPreview is absent', async () => {
    const donor = createHostProductionSuppliers({
      chatList: makePort([makeEntry({ appChatId: 'a', searchPreview: null })])
    })
    const families = await donor()
    expect(families.threads[0]).not.toHaveProperty('latestPreview')
  })

  it('sets previewTruncated when searchPreview is at 180-char bound', async () => {
    const donor = createHostProductionSuppliers({
      chatList: makePort([
        makeEntry({ appChatId: 'a', searchPreview: 'x'.repeat(180) }),
        makeEntry({ appChatId: 'b', searchPreview: 'short' })
      ])
    })
    const families = await donor()
    expect(families.threads[0].previewTruncated).toBe(true)
    expect(families.threads[1].previewTruncated).toBe(false)
  })

  it('omits previewTruncated when no searchPreview', async () => {
    const donor = createHostProductionSuppliers({
      chatList: makePort([makeEntry({ appChatId: 'a', searchPreview: null })])
    })
    const families = await donor()
    expect(families.threads[0]).not.toHaveProperty('previewTruncated')
  })

  it('maps updatedAt verbatim', async () => {
    const donor = createHostProductionSuppliers({
      chatList: makePort([makeEntry({ appChatId: 'a', updatedAt: 1712345678000 })])
    })
    const families = await donor()
    expect(families.threads[0].updatedAt).toBe(1712345678000)
  })

  it('maps provider → providerId', async () => {
    const donor = createHostProductionSuppliers({
      chatList: makePort([makeEntry({ appChatId: 'a', provider: 'anthropic' })])
    })
    const families = await donor()
    expect(families.threads[0].providerId).toBe('anthropic')
  })

  it('omits providerId when provider is absent', async () => {
    const donor = createHostProductionSuppliers({
      chatList: makePort([makeEntry({ appChatId: 'a', provider: null })])
    })
    const families = await donor()
    expect(families.threads[0]).not.toHaveProperty('providerId')
  })
})

/* ------------------------------------------------------------------ */
/*  Workspace derivation                                              */
/* ------------------------------------------------------------------ */

describe('HostProductionSuppliers workspace derivation', () => {
  it('derives unique workspaces from chat entries', async () => {
    const donor = createHostProductionSuppliers({
      chatList: makePort([
        makeEntry({ appChatId: 'a', workspaceId: 'ws-1', workspacePath: '/tmp/ws1' }),
        makeEntry({ appChatId: 'b', workspaceId: 'ws-1', workspacePath: '/tmp/ws1' }), // duplicate
        makeEntry({ appChatId: 'c', workspaceId: 'ws-2', workspacePath: '/tmp/ws2' })
      ])
    })
    const families = await donor()

    expect(families.workspaces).toHaveLength(2)
    const ids = families.workspaces.map((w) => w.id).sort()
    expect(ids).toEqual(['ws-1', 'ws-2'])
  })

  it('workspace projection carries id + name (fallback to id) + real path + defaults', async () => {
    const donor = createHostProductionSuppliers({
      chatList: makePort([
        makeEntry({ appChatId: 'a', workspaceId: 'ws-1', workspacePath: '/Users/x/projects/one' })
      ])
    })
    const families = await donor()

    expect(families.workspaces[0]).toEqual({
      id: 'ws-1',
      name: 'ws-1', // honest fallback
      path: '/Users/x/projects/one',
      pinned: false,
      updatedAt: 0 // honest: not derivable from chat list alone
    })
  })

  it('skips workspace row when workspacePath is absent (null / empty / missing)', async () => {
    const donor = createHostProductionSuppliers({
      chatList: makePort([
        makeEntry({ appChatId: 'a', workspaceId: 'ws-1', workspacePath: null }),
        makeEntry({ appChatId: 'b', workspaceId: 'ws-2', workspacePath: '' }),
        makeEntry({ appChatId: 'c', workspaceId: 'ws-3' }) // no workspacePath key
      ])
    })
    const families = await donor()
    expect(families.workspaces).toEqual([])
  })

  it('excludes entries with null workspaceId', async () => {
    const donor = createHostProductionSuppliers({
      chatList: makePort([
        makeEntry({ appChatId: 'a', workspaceId: null }),
        makeEntry({ appChatId: 'b', workspaceId: 'ws-1', workspacePath: '/tmp/ws1' })
      ])
    })
    const families = await donor()

    expect(families.workspaces).toHaveLength(1)
    expect(families.workspaces[0].id).toBe('ws-1')
  })

  /* ---- Consumer proof: donor output must survive projector ---- */
  it('donor output with workspace-bearing entries passes projectHostSnapshot', async () => {
    const donor = createHostProductionSuppliers({
      chatList: makePort([
        makeEntry({
          appChatId: 'chat-a',
          workspaceId: 'ws-1',
          workspacePath: '/Users/test/projects/alpha'
        }),
        makeEntry({
          appChatId: 'chat-b',
          workspaceId: 'ws-2',
          workspacePath: '/Users/test/projects/beta'
        }),
        makeEntry({ appChatId: 'chat-c', workspaceId: 'ws-3' }) // skipped — no path
      ])
    })
    const families = await donor()

    const result = projectHostSnapshot({
      position: {
        generation: 1,
        cursor: 0,
        freshness: 'live',
        generatedAt: '2024-01-01T00:00:00Z'
      },
      recovery: { reopenStatus: 'clean' },
      ...families
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      // Surface the error — if this fails, the projector rejected the donor output
      expect(result.error).toBeUndefined()
      return
    }
    expect(result.value.workspaces).toHaveLength(2)
    const paths = result.value.workspaces.map((w) => w.path).sort()
    expect(paths).toEqual(['/Users/test/projects/alpha', '/Users/test/projects/beta'])
  })

  it('donor output without workspacePath entries has zero workspaces and still passes projector', async () => {
    const donor = createHostProductionSuppliers({
      chatList: makePort([
        makeEntry({ appChatId: 'a', workspaceId: null }),
        makeEntry({ appChatId: 'b' }), // no workspaceId at all
        makeEntry({ appChatId: 'c', workspaceId: 'ws-1', workspacePath: '' }) // empty path → skipped
      ])
    })
    const families = await donor()

    expect(families.workspaces).toEqual([])

    const result = projectHostSnapshot({
      position: {
        generation: 1,
        cursor: 0,
        freshness: 'live',
        generatedAt: '2024-01-01T00:00:00Z'
      },
      recovery: { reopenStatus: 'clean' },
      ...families
    })
    expect(result.ok).toBe(true)
  })

  it('donor output fails projector when path is empty (red proof — delete fix and this goes green-red)', async () => {
    // This test proves the consumer contract: if the donor emitted path:''
    // the projector WOULD reject it. The donor now skips empty-path rows
    // so this scenario can only be constructed directly — it documents
    // what happens if someone reverts the fix.
    const result = projectHostSnapshot({
      position: {
        generation: 1,
        cursor: 0,
        freshness: 'live',
        generatedAt: '2024-01-01T00:00:00Z'
      },
      recovery: { reopenStatus: 'clean' },
      health: { hostStatus: 'ok', connectionPhase: 'live', supervised: true, freshness: 'live' },
      workspaces: [{ id: 'ws-bad', name: 'bad', path: '', pinned: false, updatedAt: 0 }],
      threads: [],
      runs: [],
      missions: [],
      rounds: [],
      participants: [],
      providers: [],
      questions: [],
      approvals: [],
      schedules: [],
      usage: { availability: 'unavailable', confidence: 'unknown', band: 'unknown' },
      artifacts: [],
      warnings: []
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('path is required')
    }
  })
})

/* ------------------------------------------------------------------ */
/*  Store failure → honest empty, never crash                         */
/* ------------------------------------------------------------------ */

describe('HostProductionSuppliers store failure', () => {
  it('returns empty threads when getChatList throws', async () => {
    const port: HostProductionChatListPort = {
      getChatList: () => {
        throw new Error('store offline')
      }
    }
    const donor = createHostProductionSuppliers({ chatList: port })
    const families = await donor()

    expect(families.threads).toEqual([])
    expect(families.workspaces).toEqual([])
  })

  it('still returns health + usage + empty families on failure', async () => {
    const port: HostProductionChatListPort = {
      getChatList: () => {
        throw new Error('ENOENT')
      }
    }
    const donor = createHostProductionSuppliers({ chatList: port })
    const families = await donor()

    expect(families.health.hostStatus).toBe('ok')
    expect(families.usage.availability).toBe('unavailable')
  })

  it('getChatList is called exactly once per donor invocation', async () => {
    const getChatList = vi.fn(() => [])
    const donor = createHostProductionSuppliers({
      chatList: { getChatList }
    })

    await donor()
    await donor()
    expect(getChatList).toHaveBeenCalledTimes(2)
  })
})
