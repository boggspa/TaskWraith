import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerIntrospectionHandlers } from './introspectionHandlers'
import type { IntrospectionRunRecord, MemoryProposalPack } from '../store/types'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function samplePack(id = 'pack-1'): MemoryProposalPack {
  return {
    schemaVersion: 1,
    id,
    introspectionRunId: 'run-1',
    windowStart: '2026-07-05T00:00:00.000Z',
    windowEnd: '2026-07-05T23:59:59.999Z',
    proposals: [],
    evidenceItemCount: 0,
    createdAt: '2026-07-05T12:00:00.000Z',
    updatedAt: '2026-07-05T12:00:00.000Z'
  }
}

function sampleRun(id = 'run-1'): IntrospectionRunRecord {
  return {
    schemaVersion: 1,
    id,
    status: 'review_pending',
    trigger: 'manual',
    windowStart: '2026-07-05T00:00:00.000Z',
    windowEnd: '2026-07-05T23:59:59.999Z',
    evidenceItems: [],
    proposalPackId: 'pack-2',
    createdAt: '2026-07-05T12:00:00.000Z',
    updatedAt: '2026-07-05T12:00:00.000Z'
  }
}

function createDeps() {
  return {
    getMemoryProposalPacks: vi.fn((workspaceId?: string) => [samplePack(workspaceId || 'all')]),
    getMemoryProposalPack: vi.fn((id: string) => (id === 'pack-1' ? samplePack(id) : null)),
    updateMemoryProposal: vi.fn(() => samplePack('pack-1')),
    runManualIntrospection: vi.fn(() => ({
      run: sampleRun(),
      pack: samplePack('pack-2'),
      evidenceCount: 3,
      proposalCount: 2
    }))
  }
}

describe('registerIntrospectionHandlers', () => {
  it('registers thread introspection IPC channels', () => {
    registerIntrospectionHandlers(createDeps())

    expect(handlerFor('get-memory-proposal-packs')).toBeTypeOf('function')
    expect(handlerFor('get-memory-proposal-pack')).toBeTypeOf('function')
    expect(handlerFor('update-memory-proposal')).toBeTypeOf('function')
    expect(handlerFor('run-manual-introspection')).toBeTypeOf('function')
  })

  it('routes pack listing through deps with optional workspace filter', () => {
    const deps = createDeps()
    registerIntrospectionHandlers(deps)

    const handler = handlerFor('get-memory-proposal-packs')
    expect(handler({}, ' ws-1 ')).toEqual([samplePack('ws-1')])
    expect(deps.getMemoryProposalPacks).toHaveBeenCalledWith('ws-1')

    expect(handler({}, null)).toEqual([samplePack('all')])
    expect(deps.getMemoryProposalPacks).toHaveBeenLastCalledWith(undefined)
  })

  it('returns a single pack by id', () => {
    const deps = createDeps()
    registerIntrospectionHandlers(deps)

    const handler = handlerFor('get-memory-proposal-pack')
    expect(handler({}, 'pack-1')).toEqual(samplePack('pack-1'))
    expect(handler({}, 'missing')).toBeNull()
    expect(deps.getMemoryProposalPack).toHaveBeenCalledWith('pack-1')
  })

  it('sanitizes proposal review updates to safe fields only', () => {
    const deps = createDeps()
    registerIntrospectionHandlers(deps)

    handlerFor('update-memory-proposal')({}, {
      packId: ' pack-1 ',
      proposalId: ' prop-1 ',
      partial: {
        status: 'approved',
        reviewNote: ' Looks good ',
        lesson: 'Injected lesson',
        skillPatchDiff: '+++'
      }
    })

    expect(deps.updateMemoryProposal).toHaveBeenCalledWith('pack-1', 'prop-1', {
      status: 'approved',
      reviewNote: 'Looks good'
    })
  })

  it('rejects empty proposal review patches', () => {
    registerIntrospectionHandlers(createDeps())

    expect(() =>
      handlerFor('update-memory-proposal')({}, {
        packId: 'pack-1',
        proposalId: 'prop-1',
        partial: { lesson: 'nope' }
      })
    ).toThrow(/At least one reviewable proposal field/)
  })

  it('runs manual introspection with normalized window input', () => {
    const deps = createDeps()
    registerIntrospectionHandlers(deps)

    const response = handlerFor('run-manual-introspection')({}, {
      windowStart: '2026-07-05T00:00:00.000Z',
      windowEnd: '2026-07-05T23:59:59.999Z',
      workspaceId: ' ws-1 ',
      workspacePath: '/repo',
      trigger: 'workflow'
    })

    expect(deps.runManualIntrospection).toHaveBeenCalledWith({
      windowStart: '2026-07-05T00:00:00.000Z',
      windowEnd: '2026-07-05T23:59:59.999Z',
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      trigger: 'workflow',
      chatId: undefined,
      workflowId: undefined,
      minConfidence: undefined,
      summary: undefined
    })
    expect(response).toEqual({
      pack: samplePack('pack-2'),
      evidenceCount: 3,
      proposalCount: 2
    })
  })

  it('rejects invalid introspection windows', () => {
    registerIntrospectionHandlers(createDeps())

    expect(() =>
      handlerFor('run-manual-introspection')({}, {
        windowStart: 'bad',
        windowEnd: '2026-07-05T23:59:59.999Z'
      })
    ).toThrow(/valid ISO timestamps/)

    expect(() =>
      handlerFor('run-manual-introspection')({}, {
        windowStart: '2026-07-05T23:59:59.999Z',
        windowEnd: '2026-07-05T00:00:00.000Z'
      })
    ).toThrow(/earlier than windowEnd/)
  })
})