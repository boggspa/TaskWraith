import { describe, expect, it, vi } from 'vitest'
import {
  expireDueMemoryProposals,
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
  let packs = seedPacks.map((item) => ({ ...item, proposals: [...item.proposals] }))

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