/*
 * Decay / supersede lifecycle for Thread Introspection memory proposals.
 *
 * Store-level helpers that link successor ↔ predecessor proposals and expire
 * stale proposed items past `expiresAt`. No skill writes or apply paths.
 */

import type { MemoryProposal, MemoryProposalPack, MemoryProposalStatus } from '../store/types'

const SUPERSEDE_ELIGIBLE_STATUSES = new Set<MemoryProposalStatus>(['proposed', 'approved'])

export type SupersedeMemoryProposalBlockReason =
  | 'successor_pack_not_found'
  | 'successor_not_found'
  | 'predecessor_not_found'
  | 'same_proposal'
  | 'predecessor_applied'
  | 'predecessor_already_superseded'
  | 'predecessor_not_eligible'
  | 'successor_not_eligible'
  | 'patch_failed'

export interface SupersedeMemoryProposalResult {
  ok: boolean
  blocked?: SupersedeMemoryProposalBlockReason
  predecessorPack?: MemoryProposalPack
  successorPack?: MemoryProposalPack
}

export interface ExpireDueMemoryProposalsResult {
  expiredCount: number
  packs: MemoryProposalPack[]
}

export interface MemoryProposalPatch {
  packId: string
  proposalId: string
  partial: Partial<MemoryProposal>
}

export interface IntrospectionLifecycleServiceStore {
  getMemoryProposalPacks: (workspaceId?: string) => MemoryProposalPack[]
  getMemoryProposalPack: (id: string) => MemoryProposalPack | null
  applyMemoryProposalPatches: (patches: MemoryProposalPatch[]) => MemoryProposalPack[] | null
}

export interface IntrospectionLifecycleServiceDeps {
  store: IntrospectionLifecycleServiceStore
  now: () => string
}

export interface SupersedeMemoryProposalInput {
  successorPackId: string
  successorProposalId: string
  predecessorProposalId: string
}

export interface ExpireDueMemoryProposalsInput {
  workspaceId?: string
  packId?: string
}

function locateProposal(
  packs: MemoryProposalPack[],
  proposalId: string
): { pack: MemoryProposalPack; proposal: MemoryProposal } | null {
  for (const pack of packs) {
    const proposal = pack.proposals.find((item) => item.id === proposalId)
    if (proposal) return { pack, proposal }
  }
  return null
}

function isSupersedeLinkComplete(input: {
  predecessor: MemoryProposal
  successor: MemoryProposal
}): boolean {
  return (
    input.predecessor.status === 'superseded' &&
    input.predecessor.supersededById === input.successor.id &&
    input.successor.supersedesId === input.predecessor.id
  )
}

function blockReasonForIneligible(
  status: MemoryProposalStatus,
  role: 'predecessor' | 'successor'
): SupersedeMemoryProposalBlockReason {
  if (role === 'predecessor' && status === 'applied') return 'predecessor_applied'
  if (role === 'predecessor' && status === 'superseded') return 'predecessor_already_superseded'
  return role === 'predecessor' ? 'predecessor_not_eligible' : 'successor_not_eligible'
}

export function supersedeMemoryProposal(
  deps: IntrospectionLifecycleServiceDeps,
  input: SupersedeMemoryProposalInput
): SupersedeMemoryProposalResult {
  const successorPack = deps.store.getMemoryProposalPack(input.successorPackId)
  if (!successorPack) {
    return { ok: false, blocked: 'successor_pack_not_found' }
  }

  const successor = successorPack.proposals.find((item) => item.id === input.successorProposalId)
  if (!successor) {
    return { ok: false, blocked: 'successor_not_found' }
  }

  if (input.successorProposalId === input.predecessorProposalId) {
    return { ok: false, blocked: 'same_proposal' }
  }

  const packs = deps.store.getMemoryProposalPacks()
  const predecessorLocated = locateProposal(packs, input.predecessorProposalId)
  if (!predecessorLocated) {
    return { ok: false, blocked: 'predecessor_not_found' }
  }

  const predecessor = predecessorLocated.proposal

  if (isSupersedeLinkComplete({ predecessor, successor })) {
    return {
      ok: true,
      predecessorPack: predecessorLocated.pack,
      successorPack
    }
  }

  if (!SUPERSEDE_ELIGIBLE_STATUSES.has(predecessor.status)) {
    return {
      ok: false,
      blocked: blockReasonForIneligible(predecessor.status, 'predecessor')
    }
  }

  if (!SUPERSEDE_ELIGIBLE_STATUSES.has(successor.status)) {
    return {
      ok: false,
      blocked: blockReasonForIneligible(successor.status, 'successor')
    }
  }

  if (predecessor.supersededById && predecessor.supersededById !== successor.id) {
    return { ok: false, blocked: 'predecessor_already_superseded' }
  }

  const nowIso = deps.now()
  const patches: MemoryProposalPatch[] = [
    {
      packId: predecessorLocated.pack.id,
      proposalId: predecessor.id,
      partial: {
        status: 'superseded',
        supersededById: successor.id,
        updatedAt: nowIso
      }
    },
    {
      packId: successorPack.id,
      proposalId: successor.id,
      partial: {
        supersedesId: predecessor.id,
        updatedAt: nowIso
      }
    }
  ]

  const updatedPacks = deps.store.applyMemoryProposalPatches(patches)
  if (!updatedPacks) {
    return { ok: false, blocked: 'patch_failed' }
  }

  const nextPredecessorPack =
    updatedPacks.find((pack) => pack.id === predecessorLocated.pack.id) ?? predecessorLocated.pack
  const nextSuccessorPack =
    updatedPacks.find((pack) => pack.id === successorPack.id) ?? successorPack

  return {
    ok: true,
    predecessorPack: nextPredecessorPack,
    successorPack: nextSuccessorPack
  }
}

export function expireDueMemoryProposals(
  deps: IntrospectionLifecycleServiceDeps,
  input: ExpireDueMemoryProposalsInput = {}
): ExpireDueMemoryProposalsResult {
  const nowMs = Date.parse(deps.now())
  const packs = deps.store
    .getMemoryProposalPacks(input.workspaceId)
    .filter((pack) => !input.packId || pack.id === input.packId)

  const patches: MemoryProposalPatch[] = []
  for (const pack of packs) {
    for (const proposal of pack.proposals) {
      if (proposal.status !== 'proposed' || !proposal.expiresAt) continue
      const expiresAtMs = Date.parse(proposal.expiresAt)
      if (!Number.isFinite(expiresAtMs) || expiresAtMs > nowMs) continue
      patches.push({
        packId: pack.id,
        proposalId: proposal.id,
        partial: {
          status: 'expired',
          updatedAt: deps.now()
        }
      })
    }
  }

  if (patches.length === 0) {
    return { expiredCount: 0, packs: [] }
  }

  const updatedPacks = deps.store.applyMemoryProposalPatches(patches) ?? []
  return {
    expiredCount: patches.length,
    packs: updatedPacks
  }
}