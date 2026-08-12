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

/* eslint-disable @typescript-eslint/no-require-imports -- source-isolation probes intentionally load Node modules dynamically. */

import { describe, expect, it, vi } from 'vitest'

import { projectHostSnapshot } from './HostSnapshotProjector'
import type {
  HostApprovalProjection,
  HostProviderModelProjection,
  HostQuestionProjection
} from '../../shared/hostProtocol'
import { HOST_WARNING_PROVIDER_SOURCE_NOT_READY } from '../../shared/hostProtocol'
import {
  createHostProductionSuppliers,
  type HostProductionApprovalListPort,
  type HostProductionChatListEntry,
  type HostProductionChatListPort,
  type HostProductionProviderListPort,
  type HostProductionQuestionListPort
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

function makeProviderPort(
  rows: HostProviderModelProjection[] = []
): HostProductionProviderListPort {
  return {
    getProviders: vi.fn(() => rows)
  }
}

function makeProviderRow(
  overrides: Partial<HostProviderModelProjection> = {}
): HostProviderModelProjection {
  return {
    providerId: 'codex',
    displayProvider: 'Codex',
    shortCode: 'cx',
    available: true,
    ...overrides
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

  it('omits Channels when no source is installed and preserves measured rows when present', async () => {
    const absent = await createHostProductionSuppliers({ chatList: makePort([]) })()
    expect(absent.channels).toBeUndefined()

    const donor = createHostProductionSuppliers({
      chatList: makePort([]),
      channels: {
        listChannels: () => [
          {
            channelId: 'channel-1',
            threadId: 'thread-1',
            ownerMemberId: 'owner-1',
            title: 'Shared work',
            status: 'active',
            availability: 'ready',
            membershipRevision: 1,
            memberCount: 1,
            messageCount: 0,
            updatedAt: 1
          }
        ]
      }
    })
    expect((await donor()).channels).toHaveLength(1)
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
/*  Approvals shadow port (Wave 5c Phase 2)                           */
/* ------------------------------------------------------------------ */

function makeApprovalRow(overrides: Partial<HostApprovalProjection> = {}): HostApprovalProjection {
  return {
    approvalId: '1700000000000-abc123',
    commandId: 'appstore-shadow:1700000000000-abc123',
    status: 'pending',
    actionKind: 'mcpTools',
    createdAt: 0,
    summary: 'Allow a gated tool?',
    ...overrides
  }
}

describe('HostProductionSuppliers approvals shadow port (Wave 5c Phase 2)', () => {
  it('publishes port-supplied approval rows into the family', async () => {
    const approvals: HostProductionApprovalListPort = {
      listApprovals: vi.fn(() => [makeApprovalRow()])
    }
    const donor = createHostProductionSuppliers({ chatList: makePort([]), approvals })
    const families = await donor()
    expect(families.approvals).toEqual([makeApprovalRow()])
  })

  it('keeps the family empty when no approvals port is injected', async () => {
    const donor = createHostProductionSuppliers({ chatList: makePort([]) })
    const families = await donor()
    expect(families.approvals).toEqual([])
  })

  it('fails closed when the approvals port throws — never paints a false empty', async () => {
    const approvals: HostProductionApprovalListPort = {
      listApprovals: () => {
        throw new Error('registry unavailable')
      }
    }
    const donor = createHostProductionSuppliers({ chatList: makePort([]), approvals })
    await expect(donor()).rejects.toThrow('registry unavailable')
  })
})

/* ------------------------------------------------------------------ */
/*  Questions shadow port (Wave 5c Phase 3)                           */
/* ------------------------------------------------------------------ */

function makeQuestionRow(overrides: Partial<HostQuestionProjection> = {}): HostQuestionProjection {
  return {
    questionId: 'q-1700000000000-abc123',
    threadId: 'chat-1',
    status: 'open',
    promptPreview: 'Which approach should we take?',
    askedAt: Date.parse('2024-11-14T22:13:20.000Z'),
    ...overrides
  }
}

describe('HostProductionSuppliers questions shadow port (Wave 5c Phase 3)', () => {
  it('publishes port-supplied question rows into the family', async () => {
    const questions: HostProductionQuestionListPort = {
      listQuestions: vi.fn(() => [makeQuestionRow()])
    }
    const donor = createHostProductionSuppliers({ chatList: makePort([]), questions })
    const families = await donor()
    expect(families.questions).toEqual([makeQuestionRow()])
  })

  it('keeps the family empty when no questions port is injected', async () => {
    const donor = createHostProductionSuppliers({ chatList: makePort([]) })
    const families = await donor()
    expect(families.questions).toEqual([])
  })

  it('fails closed when the questions port throws — never paints a false empty', async () => {
    const questions: HostProductionQuestionListPort = {
      listQuestions: () => {
        throw new Error('registry unavailable')
      }
    }
    const donor = createHostProductionSuppliers({ chatList: makePort([]), questions })
    await expect(donor()).rejects.toThrow('registry unavailable')
  })
})

describe('HostProductionSuppliers Track3 Mixed family shadow ports', () => {
  it('publishes runs/missions/rounds/schedules from injected ports', async () => {
    const donor = createHostProductionSuppliers({
      chatList: makePort([]),
      runs: {
        listRuns: () => [
          {
            runId: 'r1',
            threadId: 't1',
            providerId: 'codex',
            providerOutcome: 'running'
          }
        ]
      },
      missions: {
        listMissions: () => [
          {
            missionId: 'g1',
            title: 'Ship it',
            status: 'active',
            updatedAt: 1
          }
        ]
      },
      rounds: {
        listRounds: () => [
          {
            roundId: 'round-1',
            threadId: 't1',
            status: 'running',
            participantIds: ['p1'],
            providerRunIds: []
          }
        ]
      },
      schedules: {
        listSchedules: () => [
          {
            scheduleId: 's1',
            title: 'Morning',
            enabled: true
          }
        ]
      }
    })
    const families = await donor()
    expect(families.runs).toHaveLength(1)
    expect(families.missions).toHaveLength(1)
    expect(families.rounds).toHaveLength(1)
    expect(families.schedules).toHaveLength(1)
  })

  it('keeps Track3 families empty when ports are omitted', async () => {
    const donor = createHostProductionSuppliers({ chatList: makePort([]) })
    const families = await donor()
    expect(families.runs).toEqual([])
    expect(families.missions).toEqual([])
    expect(families.rounds).toEqual([])
    expect(families.schedules).toEqual([])
  })

  it('fails closed when a Track3 family port throws', async () => {
    const donor = createHostProductionSuppliers({
      chatList: makePort([]),
      runs: {
        listRuns: () => {
          throw new Error('run manager unavailable')
        }
      }
    })
    await expect(donor()).rejects.toThrow('run manager unavailable')
  })
})

describe('HostProductionSuppliers Track4 Mixed family shadow ports', () => {
  it('publishes participants/artifacts from injected ports', async () => {
    const donor = createHostProductionSuppliers({
      chatList: makePort([]),
      participants: {
        listParticipants: () => [
          {
            id: 'p1',
            threadId: 'thread-1',
            providerId: 'codex',
            role: 'Worker',
            order: 0,
            enabled: true,
            active: false
          }
        ]
      },
      artifacts: {
        listArtifacts: () => [
          {
            artifactId: 'canvas-1',
            kind: 'canvas:web',
            title: 'Preview',
            createdAt: 1
          }
        ]
      }
    })
    const families = await donor()
    expect(families.participants).toHaveLength(1)
    expect(families.artifacts).toHaveLength(1)
  })

  it('keeps Track4 families empty when ports are omitted', async () => {
    const donor = createHostProductionSuppliers({ chatList: makePort([]) })
    const families = await donor()
    expect(families.participants).toEqual([])
    expect(families.artifacts).toEqual([])
  })

  it('fails closed when a Track4 family port throws', async () => {
    const donor = createHostProductionSuppliers({
      chatList: makePort([]),
      participants: {
        listParticipants: () => {
          throw new Error('roster unavailable')
        }
      }
    })
    await expect(donor()).rejects.toThrow('roster unavailable')
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

/* ------------------------------------------------------------------ */
/*  Provider mapping — Wave 5b                                        */
/* ------------------------------------------------------------------ */

describe('HostProductionSuppliers provider mapping', () => {
  /* ---- RED PIN 1: exact N rows, never fabricate ---- */
  it('returns exactly the N provider rows the port reports — never a row the source did not admit', async () => {
    const rows = [
      makeProviderRow({ providerId: 'codex', displayProvider: 'Codex', shortCode: 'cx' }),
      makeProviderRow({ providerId: 'claude', displayProvider: 'Claude', shortCode: 'cl' })
    ]
    const donor = createHostProductionSuppliers({
      chatList: makePort([]),
      providers: makeProviderPort(rows)
    })
    const families = await donor()

    expect(families.providers).toHaveLength(2)
    expect(families.providers[0].providerId).toBe('codex')
    expect(families.providers[1].providerId).toBe('claude')
  })

  it('returns an empty list when no providers port is supplied', async () => {
    const donor = createHostProductionSuppliers({ chatList: makePort([]) })
    const families = await donor()

    expect(families.providers).toEqual([])
  })

  /* ---- RED PIN 2: throwing source → empty, never fabricate ---- */
  it('returns empty providers when getProviders throws — never fabricates a row', async () => {
    const port: HostProductionProviderListPort = {
      getProviders: () => {
        throw new Error('provider registry unavailable')
      }
    }
    const donor = createHostProductionSuppliers({
      chatList: makePort([]),
      providers: port
    })
    const families = await donor()

    expect(families.providers).toEqual([])
    // Other families must still be intact — a provider failure does not
    // cascade into thread loss or health loss.
    expect(families.health.hostStatus).toBe('ok')
  })

  /* ---- RED PIN 3: note is passed through faithfully — sanitization is the port's job ---- */
  it('passes through every field from the port unchanged — never modifies, strips or invents', async () => {
    const row = makeProviderRow({
      providerId: 'mistral',
      displayProvider: 'Mistral',
      shortCode: 'ms',
      available: true,
      modelId: 'mistral-large',
      modelLabel: 'Mistral Large',
      hueKey: '#ff7700',
      note: 'beta-access-granted'
    })
    const donor = createHostProductionSuppliers({
      chatList: makePort([]),
      providers: makeProviderPort([row])
    })
    const families = await donor()

    expect(families.providers[0]).toEqual(row)
  })

  /* ---- RED PIN 3 (corollary): the supplier does NOT strip what looks like a token ---- */
  it('does not sanitize the note field — the port owns that contract', async () => {
    // The supplier is a conduit.  A credential-shaped note from the port
    // WILL reach the output, which is correct: sanitization belongs to the
    // port implementor (the composition root), not the supplier.  This pin
    // proves the supplier does not second-guess the port.
    const row = makeProviderRow({
      providerId: 'pi',
      displayProvider: 'Pi',
      shortCode: 'pi',
      available: true,
      note: 'key=sk-abc123-def456-ghi789'
    })
    const donor = createHostProductionSuppliers({
      chatList: makePort([]),
      providers: makeProviderPort([row])
    })
    const families = await donor()

    // The supplier faithfully passes through what the port gave it.
    expect(families.providers[0].note).toBe('key=sk-abc123-def456-ghi789')
  })

  it('getProviders is called exactly once per donor invocation', async () => {
    const getProviders = vi.fn(() => [])
    const donor = createHostProductionSuppliers({
      chatList: makePort([]),
      providers: { getProviders }
    })

    await donor()
    await donor()
    expect(getProviders).toHaveBeenCalledTimes(2)
  })
})

/* ------------------------------------------------------------------ */
/*  Wave 5d — RED PIN 1 (SOURCE): not-ready must reach the wire        */
/* ------------------------------------------------------------------ */

describe('HostProductionSuppliers · Wave 5d provider readiness warning', () => {
  it('emits the provider-source-not-ready warning when the port reports NOT READY', async () => {
    const donor = createHostProductionSuppliers({
      chatList: makePort([]),
      providers: {
        getProviders: () => [],
        readProviders: () => ({ providers: [], sourceReady: false })
      }
    })
    const families = await donor()

    // The rows are empty AND the reason is on the wire. Without the code a
    // client cannot tell this from a genuine measured zero.
    expect(families.providers).toEqual([])
    expect(families.warnings.map((w) => w.code)).toContain(HOST_WARNING_PROVIDER_SOURCE_NOT_READY)
  })

  it('emits NO warning when the source is READY and genuinely empty', async () => {
    const donor = createHostProductionSuppliers({
      chatList: makePort([]),
      providers: {
        getProviders: () => [],
        readProviders: () => ({ providers: [], sourceReady: true })
      }
    })
    const families = await donor()

    // A real measured zero must NOT be dressed up as unknown — that would
    // simply invert the lie.
    expect(families.providers).toEqual([])
    expect(families.warnings.map((w) => w.code)).not.toContain(
      HOST_WARNING_PROVIDER_SOURCE_NOT_READY
    )
  })

  it('treats a THROWING provider port as unknown, not as a measured zero', async () => {
    const donor = createHostProductionSuppliers({
      chatList: makePort([]),
      providers: {
        getProviders: () => {
          throw new Error('provider registry unavailable')
        }
      }
    })
    const families = await donor()

    expect(families.providers).toEqual([])
    expect(families.warnings.map((w) => w.code)).toContain(HOST_WARNING_PROVIDER_SOURCE_NOT_READY)
  })

  it('carries a bounded snake_case code and never leaks source prose', async () => {
    const donor = createHostProductionSuppliers({
      chatList: makePort([]),
      providers: {
        getProviders: () => [],
        readProviders: () => ({ providers: [], sourceReady: false })
      }
    })
    const families = await donor()
    const warning = families.warnings.find((w) => w.code === HOST_WARNING_PROVIDER_SOURCE_NOT_READY)

    expect(warning?.code).toMatch(/^[a-z][a-z0-9_]*$/)
    expect(warning?.severity).toBe('info')
    expect(typeof warning?.warningId).toBe('string')
  })
})
