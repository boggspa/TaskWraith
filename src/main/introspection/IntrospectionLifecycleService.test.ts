import { describe, expect, it, vi } from 'vitest'
import {
  expireDueMemoryProposals,
  supersedeReviewedMemoryProposal,
  supersedeMemoryProposal,
  type MemoryProposalPatch
} from './IntrospectionLifecycleService'
import type { MemoryProposal, MemoryProposalPack } from '../store/types'

const NOW = '2026-07-05T18:00:00.000Z'

function proposal(id: string, over: Partial<MemoryProposal> = {}): MemoryProposal {
  return {
    id,
    kind: 'repo_convention',
    scope: 'workspace',
    status: 'proposed',
    title: `Title ${id}`,
    lesson: `Lesson ${id}`,
    confidence: 0.8,
    evidenceRefs: [
      {
        chatId: 'chat-1',
        timestamp: '2026-07-05T12:00:00.000Z',
        summary: 'evidence'
      }
    ],
    dedupKey: `key-${id}`,
    requiresReview: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...over
  }
}

function pack(id: string, proposals: MemoryProposal[], over: Partial<MemoryProposalPack> = {}): MemoryProposalPack {
  return {
    schemaVersion: 1,
    id,
    introspectionRunId: `run-${id}`,
    workspaceId: 'ws-1',
    windowStart: '2026-07-05T00:00:00.000Z',
    windowEnd: '2026-07-05T23:59:59.999Z',
    proposals,
    evidenceItemCount: proposals.length,
    createdAt: NOW,
    updatedAt: NOW,
    ...over
  }
}

function makeStore(seedPacks: MemoryProposalPack[]) {
  const packs = seedPacks.map((item) => ({ ...item, proposals: [...item.proposals] }))

  return {
    getMemoryProposalPacks: vi.fn((workspaceId?: string) =>
      packs.filter((item) => !workspaceId || item.workspaceId === workspaceId)
    ),
    getMemoryProposalPack: vi.fn((id: string) => packs.find((item) => item.id === id) ?? null),
    applyMemoryProposalPatches: vi.fn((patches: MemoryProposalPatch[]) => {
      const touched = new Set<string>()
      for (const patch of patches) {
        const packIndex = packs.findIndex((item) => item.id === patch.packId)
        if (packIndex < 0) return null
        const proposalIndex = packs[packIndex]!.proposals.findIndex(
          (item) => item.id === patch.proposalId
        )
        if (proposalIndex < 0) return null
        packs[packIndex] = {
          ...packs[packIndex]!,
          proposals: packs[packIndex]!.proposals.map((item, index) =>
            index === proposalIndex
              ? { ...item, ...patch.partial, id: patch.proposalId, updatedAt: NOW }
              : item
          ),
          updatedAt: NOW
        }
        touched.add(packs[packIndex]!.id)
      }
      return packs.filter((item) => touched.has(item.id))
    })
  }
}

describe('IntrospectionLifecycleService', () => {
  it.each(['old', 'new'])('blocks supersede when expiry persistence fails for %s', (dueId) => {
    const store = makeStore([pack('p', ['old', 'new'].map((id) => proposal(id, id === dueId ? { expiresAt: NOW } : {})))])
    store.applyMemoryProposalPatches.mockReturnValueOnce(null)
    expect(supersedeReviewedMemoryProposal({ store, now: () => NOW }, { packId: 'p', predecessorProposalId: 'old', successorProposalId: 'new' })).toEqual({ ok: false, blocked: 'patch_failed' })
    expect(store.applyMemoryProposalPatches).toHaveBeenCalledTimes(1)
    expect(store.getMemoryProposalPack('p')?.proposals.every((item) => item.status === 'proposed')).toBe(true)
  })
  it('explicit reviewed supersede preserves successor approval and predecessor evidence', () => {
    const old = proposal('old', { status: 'approved', reviewNote: 'Human approved' })
    const store = makeStore([pack('p', [old, proposal('new')])])
    const input = { packId: 'p', predecessorProposalId: 'old', successorProposalId: 'new' }
    const result = supersedeReviewedMemoryProposal({ store, now: () => NOW }, input)
    expect(result.ok).toBe(true)
    expect(result.predecessorPack?.proposals[0]).toMatchObject({ status: 'superseded', reviewNote: 'Human approved', supersededById: 'new' })
    expect(result.successorPack?.proposals[1]).toMatchObject({ status: 'proposed', supersedesId: 'old' })
    expect(supersedeReviewedMemoryProposal({ store, now: () => NOW }, input).ok).toBe(true)
    expect(store.applyMemoryProposalPatches).toHaveBeenCalledTimes(1)
  })

  it('rejects cross-pack IDs and packs without workspace identity', () => {
    const store = makeStore([pack('p', [proposal('new')]), pack('q', [proposal('old')])])
    const input = { packId: 'p', predecessorProposalId: 'old', successorProposalId: 'new' }
    expect(supersedeReviewedMemoryProposal({ store, now: () => NOW }, input).blocked).toBe('predecessor_not_found')
    const globalStore = makeStore([pack('p', [proposal('new'), proposal('old')], { workspaceId: undefined })])
    expect(supersedeReviewedMemoryProposal({ store: globalStore, now: () => NOW }, input).blocked).toBe('workspace_required')
    expect(store.applyMemoryProposalPatches).not.toHaveBeenCalled()
    expect(globalStore.applyMemoryProposalPatches).not.toHaveBeenCalled()
  })

  it.each(['applied', 'rejected', 'expired'] as const)('protects %s predecessor history', (status) => {
    const store = makeStore([pack('p', [proposal('old', { status }), proposal('new')])])
    expect(supersedeReviewedMemoryProposal({ store, now: () => NOW }, { packId: 'p', predecessorProposalId: 'old', successorProposalId: 'new' }).ok).toBe(false)
    expect(store.applyMemoryProposalPatches).not.toHaveBeenCalled()
  })

  it('rejects chains and cycles rather than overwriting reciprocal history', () => {
    const store = makeStore([pack('p', [proposal('old', { supersedesId: 'new' }), proposal('new')])])
    expect(supersedeReviewedMemoryProposal({ store, now: () => NOW }, { packId: 'p', predecessorProposalId: 'old', successorProposalId: 'new' }).blocked).toBe('proposal_link_conflict')
    expect(store.applyMemoryProposalPatches).not.toHaveBeenCalled()
  })

  it('rechecks due expiry before supersede and propagates atomic failure', () => {
    const input = { packId: 'p', predecessorProposalId: 'old', successorProposalId: 'new' }
    const stale = makeStore([pack('p', [proposal('old', { expiresAt: NOW }), proposal('new')])])
    expect(supersedeReviewedMemoryProposal({ store: stale, now: () => NOW }, input).ok).toBe(false)
    expect(stale.getMemoryProposalPack('p')?.proposals[0]?.status).toBe('expired')
    const failed = makeStore([pack('p', [proposal('old'), proposal('new')])])
    failed.applyMemoryProposalPatches.mockReturnValueOnce(null)
    expect(supersedeReviewedMemoryProposal({ store: failed, now: () => NOW }, input).blocked).toBe('patch_failed')
  })

  it('ignores an invalid clock without reading or patching records', () => {
    const store = makeStore([pack('due', [proposal('due', { expiresAt: NOW })])])
    expect(expireDueMemoryProposals({ store, now: () => 'invalid' })).toEqual({
      expiredCount: 0,
      packs: []
    })
    expect(store.getMemoryProposalPacks).not.toHaveBeenCalled()
    expect(store.applyMemoryProposalPatches).not.toHaveBeenCalled()
  })

  it('reports no expiration when the atomic patch fails', () => {
    const store = makeStore([pack('due', [proposal('due', { expiresAt: NOW })])])
    store.applyMemoryProposalPatches.mockReturnValueOnce(null)
    expect(expireDueMemoryProposals({ store, now: () => NOW })).toEqual({
      expiredCount: 0,
      packs: []
    })
    expect(store.getMemoryProposalPack('due')?.proposals[0]?.status).toBe('proposed')
  })

  it('expires only explicitly due proposed records in the requested workspace and pack', () => {
    const records = [
      proposal('due', { expiresAt: NOW }),
      proposal('undated'),
      proposal('invalid', { expiresAt: 'invalid' }),
      proposal('future', { expiresAt: '2026-07-05T18:00:00.001Z' }),
      proposal('approved', { status: 'approved', expiresAt: NOW }),
      proposal('applied', { status: 'applied', expiresAt: NOW, appliedAt: NOW })
    ]
    const store = makeStore([
      pack('selected', records),
      pack('other-pack', [proposal('other', { expiresAt: NOW })]),
      pack('other-workspace', [proposal('elsewhere', { expiresAt: NOW })], { workspaceId: 'ws-2' })
    ])
    const input = { workspaceId: 'ws-1', packId: 'selected' }
    const now = vi.fn(() => NOW)
    expect(expireDueMemoryProposals({ store, now }, input).expiredCount).toBe(1)
    expect(now).toHaveBeenCalledTimes(1)
    expect(store.getMemoryProposalPack('selected')?.proposals.slice(1)).toEqual(records.slice(1))
    expect(store.getMemoryProposalPack('other-pack')?.proposals[0]?.status).toBe('proposed')
    expect(store.getMemoryProposalPack('other-workspace')?.proposals[0]?.status).toBe('proposed')
    expect(expireDueMemoryProposals({ store, now }, input)).toEqual({ expiredCount: 0, packs: [] })
    expect(store.applyMemoryProposalPatches).toHaveBeenCalledTimes(1)
  })

  it('supersede links both proposals across packs', () => {
    const oldProposal = proposal('old')
    const newProposal = proposal('new')
    const store = makeStore([pack('pack-old', [oldProposal]), pack('pack-new', [newProposal])])

    const result = supersedeMemoryProposal(
      { store, now: () => NOW },
      {
        successorPackId: 'pack-new',
        successorProposalId: 'new',
        predecessorProposalId: 'old'
      }
    )

    expect(result.ok).toBe(true)
    expect(result.predecessorPack?.proposals[0]).toMatchObject({
      id: 'old',
      status: 'superseded',
      supersededById: 'new'
    })
    expect(result.successorPack?.proposals[0]).toMatchObject({
      id: 'new',
      supersedesId: 'old'
    })
  })

  it('blocks superseding an applied predecessor', () => {
    const store = makeStore([
      pack('pack-old', [proposal('old', { status: 'applied', appliedAt: NOW })]),
      pack('pack-new', [proposal('new')])
    ])

    const result = supersedeMemoryProposal(
      { store, now: () => NOW },
      {
        successorPackId: 'pack-new',
        successorProposalId: 'new',
        predecessorProposalId: 'old'
      }
    )

    expect(result).toEqual({ ok: false, blocked: 'predecessor_applied' })
    expect(store.applyMemoryProposalPatches).not.toHaveBeenCalled()
  })

  it('expires stale proposed items past expiresAt', () => {
    const store = makeStore([
      pack('pack-1', [
        proposal('fresh', { expiresAt: '2026-07-06T00:00:00.000Z' }),
        proposal('stale', { expiresAt: '2026-07-05T12:00:00.000Z' }),
        proposal('approved', {
          status: 'approved',
          expiresAt: '2026-07-05T10:00:00.000Z'
        })
      ])
    ])

    const result = expireDueMemoryProposals({ store, now: () => NOW }, { packId: 'pack-1' })

    expect(result.expiredCount).toBe(1)
    expect(result.packs[0]?.proposals.find((item) => item.id === 'stale')?.status).toBe('expired')
    expect(result.packs[0]?.proposals.find((item) => item.id === 'fresh')?.status).toBe('proposed')
    expect(result.packs[0]?.proposals.find((item) => item.id === 'approved')?.status).toBe(
      'approved'
    )
  })

  it('idempotent repeat supersede does not corrupt state', () => {
    const linkedOld = proposal('old', { status: 'superseded', supersededById: 'new' })
    const linkedNew = proposal('new', { supersedesId: 'old' })
    const store = makeStore([pack('pack-a', [linkedOld, linkedNew])])

    const result = supersedeMemoryProposal(
      { store, now: () => NOW },
      {
        successorPackId: 'pack-a',
        successorProposalId: 'new',
        predecessorProposalId: 'old'
      }
    )

    expect(result.ok).toBe(true)
    expect(store.applyMemoryProposalPatches).not.toHaveBeenCalled()
    expect(result.successorPack?.proposals.find((item) => item.id === 'new')).toMatchObject({
      supersedesId: 'old'
    })
    expect(result.predecessorPack?.proposals.find((item) => item.id === 'old')).toMatchObject({
      status: 'superseded',
      supersededById: 'new'
    })
  })
})
