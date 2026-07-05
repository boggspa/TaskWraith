import { describe, expect, it, vi } from 'vitest'
import { applyMemoryProposal } from './IntrospectionApplyService'
import type {
  MemoryProposal,
  MemoryProposalPack,
  RepoConventionIndexSnapshot
} from '../store/types'

const NOW = '2026-07-05T18:00:00.000Z'

function proposal(over: Partial<MemoryProposal> = {}): MemoryProposal {
  return {
    id: 'prop-1',
    kind: 'repo_convention',
    scope: 'workspace',
    status: 'approved',
    title: 'Avoid repo-wide Prettier',
    lesson: 'Do not run repo-wide Prettier.',
    confidence: 0.9,
    evidenceRefs: [
      {
        chatId: 'chat-1',
        timestamp: '2026-07-05T12:00:00.000Z',
        summary: 'User corrected assistant'
      }
    ],
    dedupKey: 'repo-prettier',
    requiresReview: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...over
  }
}

function pack(over: Partial<MemoryProposalPack> = {}): MemoryProposalPack {
  return {
    schemaVersion: 1,
    id: 'pack-1',
    introspectionRunId: 'run-1',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    windowStart: '2026-07-05T00:00:00.000Z',
    windowEnd: '2026-07-05T23:59:59.999Z',
    proposals: [proposal()],
    evidenceItemCount: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...over
  }
}

function makeStore(seed: {
  pack?: MemoryProposalPack | null
  conventionIndexes?: RepoConventionIndexSnapshot[]
}) {
  const conventionIndexes = [...(seed.conventionIndexes || [])]
  let currentPack = seed.pack === undefined ? pack() : seed.pack

  return {
    getMemoryProposalPack: vi.fn(() => currentPack),
    updateMemoryProposal: vi.fn((packId: string, proposalId: string, partial: Partial<MemoryProposal>) => {
      if (!currentPack || currentPack.id !== packId) return null
      const proposals = currentPack.proposals.map((item) =>
        item.id === proposalId ? { ...item, ...partial, id: proposalId, updatedAt: NOW } : item
      )
      currentPack = { ...currentPack, proposals, updatedAt: NOW }
      return currentPack
    }),
    getRepoConventionIndexes: vi.fn(() => conventionIndexes),
    saveRepoConventionIndex: vi.fn((snapshot: Partial<RepoConventionIndexSnapshot>) => {
      const saved: RepoConventionIndexSnapshot = {
        schemaVersion: 1,
        workspaceId: snapshot.workspaceId || 'ws-1',
        generatedAt: snapshot.generatedAt || NOW,
        entries: snapshot.entries || []
      }
      const index = conventionIndexes.findIndex((item) => item.workspaceId === saved.workspaceId)
      if (index >= 0) conventionIndexes[index] = saved
      else conventionIndexes.push(saved)
      return saved
    }),
    conventionIndexes,
    get currentPack() {
      return currentPack
    }
  }
}

describe('applyMemoryProposal', () => {
  it('applies an approved repo_convention proposal into RepoConventionIndex', () => {
    const store = makeStore({})
    const result = applyMemoryProposal({ store, now: () => NOW }, 'pack-1', 'prop-1')

    expect(result.ok).toBe(true)
    expect(result.conventionEntryId).toBe('intro-prop-1')
    expect(store.saveRepoConventionIndex).toHaveBeenCalledTimes(1)
    expect(store.conventionIndexes[0]?.entries).toEqual([
      expect.objectContaining({
        id: 'intro-prop-1',
        kind: 'decision',
        title: 'Avoid repo-wide Prettier',
        description: 'Do not run repo-wide Prettier.',
        provenance: 'introspection'
      })
    ])
    expect(store.updateMemoryProposal).toHaveBeenCalledWith(
      'pack-1',
      'prop-1',
      expect.objectContaining({
        status: 'applied',
        appliedAt: NOW,
        applyReceipt: expect.objectContaining({
          target: 'RepoConventionIndex',
          conventionEntryId: 'intro-prop-1'
        })
      })
    )
    expect(result.pack?.proposals[0]?.status).toBe('applied')
  })

  it('blocks unapproved proposals', () => {
    const store = makeStore({
      pack: pack({ proposals: [proposal({ status: 'proposed' })] })
    })
    const result = applyMemoryProposal({ store, now: () => NOW }, 'pack-1', 'prop-1')

    expect(result).toEqual({ ok: false, blocked: 'proposal_not_approved' })
    expect(store.saveRepoConventionIndex).not.toHaveBeenCalled()
    expect(store.updateMemoryProposal).not.toHaveBeenCalled()
  })

  it('blocks approved skill_patch proposals in phase 1', () => {
    const store = makeStore({
      pack: pack({
        proposals: [
          proposal({
            kind: 'skill_patch',
            scope: 'skill',
            skillPatchDiff: '+++ skill\n+rule'
          })
        ]
      })
    })
    const result = applyMemoryProposal({ store, now: () => NOW }, 'pack-1', 'prop-1')

    expect(result).toEqual({ ok: false, blocked: 'skill_patch_not_supported_phase1' })
    expect(store.saveRepoConventionIndex).not.toHaveBeenCalled()
  })

  it('is idempotent when the proposal is already applied', () => {
    const appliedPack = pack({
      proposals: [
        proposal({
          status: 'applied',
          appliedAt: NOW,
          applyReceipt: {
            appliedAt: NOW,
            target: 'RepoConventionIndex',
            conventionEntryId: 'intro-prop-1',
            packId: 'pack-1',
            proposalId: 'prop-1'
          }
        })
      ]
    })
    const store = makeStore({
      pack: appliedPack,
      conventionIndexes: [
        {
          schemaVersion: 1,
          workspaceId: 'ws-1',
          generatedAt: NOW,
          entries: [
            {
              id: 'intro-prop-1',
              kind: 'decision',
              title: 'Avoid repo-wide Prettier',
              provenance: 'introspection',
              updatedAt: NOW
            }
          ]
        }
      ]
    })

    const result = applyMemoryProposal({ store, now: () => NOW }, 'pack-1', 'prop-1')

    expect(result.ok).toBe(true)
    expect(result.conventionEntryId).toBe('intro-prop-1')
    expect(store.saveRepoConventionIndex).not.toHaveBeenCalled()
    expect(store.updateMemoryProposal).not.toHaveBeenCalled()
    expect(store.conventionIndexes[0]?.entries).toHaveLength(1)
  })
})