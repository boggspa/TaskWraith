/*
 * Gated apply layer for Thread Introspection.
 *
 * Applies user-approved repo_convention / do_not_repeat proposals to the
 * RepoConventionIndex, and approved skill_patch proposals to TaskWraith skill
 * roots (via Skill Patch Manager). Preferences, bugs, and other kinds stay
 * blocked. There is no MCP apply tool.
 */

import type {
  MemoryProposal,
  MemoryProposalApplyReceipt,
  MemoryProposalKind,
  MemoryProposalPack,
  RepoConventionIndexEntry,
  RepoConventionIndexEntryKind,
  RepoConventionIndexSnapshot
} from '../store/types'
import type { SkillsStore } from '../skills/SkillsStore'
import { applySkillPatch, type SkillPatchApplyBlockReason } from './SkillPatchApply'

const CONVENTION_APPLYABLE_KINDS = new Set<MemoryProposalKind>(['repo_convention', 'do_not_repeat'])

export type ApplyMemoryProposalBlockReason =
  | 'pack_not_found'
  | 'proposal_not_found'
  | 'proposal_not_approved'
  | 'workspace_required'
  | 'kind_not_supported_phase1'
  | 'skill_patch_not_supported_phase1'
  | 'bug_not_supported_phase1'
  | 'preference_not_supported_phase1'
  | 'provider_hint_not_supported_phase1'
  | 'failure_mode_not_supported_phase1'
  | SkillPatchApplyBlockReason

export interface ApplyMemoryProposalResult {
  ok: boolean
  blocked?: ApplyMemoryProposalBlockReason
  pack?: MemoryProposalPack
  conventionEntryId?: string
  skillId?: string
}

export interface IntrospectionApplyServiceStore {
  getMemoryProposalPack: (id: string) => MemoryProposalPack | null
  updateMemoryProposal: (
    packId: string,
    proposalId: string,
    partial: Partial<MemoryProposal>
  ) => MemoryProposalPack | null
  getRepoConventionIndexes: (workspaceId?: string) => RepoConventionIndexSnapshot[]
  saveRepoConventionIndex: (
    snapshot: Partial<RepoConventionIndexSnapshot>
  ) => RepoConventionIndexSnapshot
}

export interface IntrospectionApplyServiceDeps {
  store: IntrospectionApplyServiceStore
  skillsStore?: Pick<
    SkillsStore,
    | 'listUserSkills'
    | 'listWorkspaceSkills'
    | 'upsertUserSkill'
    | 'upsertWorkspaceSkill'
    | 'deleteUserSkill'
    | 'deleteWorkspaceSkill'
  >
  now: () => string
  /** Optional registered-style workspace path validator for workspace skill_patch apply. */
  assertWorkspacePath?: (workspacePath: string) => string
}

function blockReasonForKind(kind: MemoryProposalKind): ApplyMemoryProposalBlockReason {
  switch (kind) {
    case 'skill_patch':
      return 'skill_patch_not_supported_phase1'
    case 'bug':
      return 'bug_not_supported_phase1'
    case 'preference':
      return 'preference_not_supported_phase1'
    case 'provider_hint':
      return 'provider_hint_not_supported_phase1'
    case 'failure_mode':
      return 'failure_mode_not_supported_phase1'
    default:
      return 'kind_not_supported_phase1'
  }
}

function conventionEntryKindForProposal(kind: MemoryProposalKind): RepoConventionIndexEntryKind {
  return kind === 'do_not_repeat' ? 'do_not_repeat' : 'decision'
}

function conventionEntryIdForProposal(proposalId: string): string {
  return `intro-${proposalId}`
}

function buildConventionEntry(input: {
  proposal: MemoryProposal
  entryId: string
  nowIso: string
}): RepoConventionIndexEntry {
  return {
    id: input.entryId,
    kind: conventionEntryKindForProposal(input.proposal.kind),
    title: input.proposal.title,
    description: input.proposal.lesson,
    provenance: 'introspection',
    updatedAt: input.nowIso
  }
}

function mergeConventionEntry(
  existing: RepoConventionIndexSnapshot | undefined,
  entry: RepoConventionIndexEntry,
  workspaceId: string,
  workspacePath: string | undefined,
  nowIso: string
): RepoConventionIndexSnapshot {
  const entries = existing?.entries ?? []
  const index = entries.findIndex((item) => item.id === entry.id)
  const nextEntries =
    index >= 0 ? entries.map((item, i) => (i === index ? entry : item)) : [...entries, entry]
  return {
    schemaVersion: 1,
    workspaceId,
    ...(workspacePath
      ? { workspacePath }
      : existing?.workspacePath
        ? { workspacePath: existing.workspacePath }
        : {}),
    generatedAt: nowIso,
    entries: nextEntries
  }
}

function buildConventionApplyReceipt(input: {
  packId: string
  proposalId: string
  conventionEntryId: string
  nowIso: string
}): MemoryProposalApplyReceipt {
  return {
    appliedAt: input.nowIso,
    target: 'RepoConventionIndex',
    conventionEntryId: input.conventionEntryId,
    packId: input.packId,
    proposalId: input.proposalId
  }
}

function applyConventionProposal(
  deps: IntrospectionApplyServiceDeps,
  pack: MemoryProposalPack,
  proposal: MemoryProposal,
  proposalId: string
): ApplyMemoryProposalResult {
  const workspaceId = pack.workspaceId?.trim()
  if (!workspaceId) {
    return { ok: false, blocked: 'workspace_required' }
  }

  const nowIso = deps.now()
  const conventionEntryId = conventionEntryIdForProposal(proposalId)
  const entry = buildConventionEntry({ proposal, entryId: conventionEntryId, nowIso })
  const existingSnapshot = deps.store.getRepoConventionIndexes(workspaceId)[0]
  const mergedSnapshot = mergeConventionEntry(
    existingSnapshot,
    entry,
    workspaceId,
    pack.workspacePath,
    nowIso
  )
  deps.store.saveRepoConventionIndex(mergedSnapshot)

  const applyReceipt = buildConventionApplyReceipt({
    packId: pack.id,
    proposalId,
    conventionEntryId,
    nowIso
  })
  const updatedPack = deps.store.updateMemoryProposal(pack.id, proposalId, {
    status: 'applied',
    appliedAt: nowIso,
    applyReceipt
  })

  return {
    ok: true,
    pack: updatedPack || undefined,
    conventionEntryId
  }
}

function applySkillPatchProposal(
  deps: IntrospectionApplyServiceDeps,
  pack: MemoryProposalPack,
  proposal: MemoryProposal,
  proposalId: string
): ApplyMemoryProposalResult {
  if (!deps.skillsStore) {
    return { ok: false, blocked: 'skills_store_unavailable' }
  }

  const nowIso = deps.now()
  const applied = applySkillPatch({
    skillsStore: deps.skillsStore,
    proposal,
    pack,
    nowIso,
    ...(deps.assertWorkspacePath ? { assertWorkspacePath: deps.assertWorkspacePath } : {})
  })
  if (!applied.ok) {
    return { ok: false, blocked: applied.blocked }
  }

  const updatedPack = deps.store.updateMemoryProposal(pack.id, proposalId, {
    status: 'applied',
    appliedAt: nowIso,
    applyReceipt: applied.applyReceipt
  })

  return {
    ok: true,
    pack: updatedPack || undefined,
    skillId: applied.skillId
  }
}

export function applyMemoryProposal(
  deps: IntrospectionApplyServiceDeps,
  packId: string,
  proposalId: string
): ApplyMemoryProposalResult {
  const pack = deps.store.getMemoryProposalPack(packId)
  if (!pack) {
    return { ok: false, blocked: 'pack_not_found' }
  }

  const proposal = pack.proposals.find((item) => item.id === proposalId)
  if (!proposal) {
    return { ok: false, blocked: 'proposal_not_found' }
  }

  if (proposal.status === 'applied') {
    return {
      ok: true,
      pack,
      conventionEntryId: proposal.applyReceipt?.conventionEntryId,
      skillId: proposal.applyReceipt?.skillId
    }
  }

  if (proposal.status !== 'approved') {
    return { ok: false, blocked: 'proposal_not_approved' }
  }

  if (proposal.kind === 'skill_patch') {
    return applySkillPatchProposal(deps, pack, proposal, proposalId)
  }

  if (!CONVENTION_APPLYABLE_KINDS.has(proposal.kind)) {
    return { ok: false, blocked: blockReasonForKind(proposal.kind) }
  }

  return applyConventionProposal(deps, pack, proposal, proposalId)
}
