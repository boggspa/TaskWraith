import type {
  MemoryProposal,
  MemoryProposalKind,
  MemoryProposalScope,
  MemoryProposalStatus
} from '../../../main/store/types'

export const MEMORY_PROPOSAL_KINDS: MemoryProposalKind[] = [
  'preference',
  'failure_mode',
  'repo_convention',
  'provider_hint',
  'skill_patch',
  'bug',
  'do_not_repeat'
]

export const MEMORY_PROPOSAL_SCOPES: MemoryProposalScope[] = [
  'user',
  'workspace',
  'provider',
  'skill',
  'bug'
]

export const MEMORY_PROPOSAL_STATUSES: MemoryProposalStatus[] = [
  'proposed',
  'approved',
  'applied',
  'rejected',
  'superseded',
  'expired'
]

const KIND_LABELS: Record<MemoryProposalKind, string> = {
  preference: 'Preference',
  failure_mode: 'Failure mode',
  repo_convention: 'Repo convention',
  provider_hint: 'Provider hint',
  skill_patch: 'Skill patch',
  bug: 'Bug',
  do_not_repeat: 'Do not repeat'
}

const SCOPE_LABELS: Record<MemoryProposalScope, string> = {
  user: 'User-wide',
  workspace: 'Workspace',
  provider: 'Provider',
  skill: 'Skill',
  bug: 'Bug tracker'
}

const STATUS_LABELS: Record<MemoryProposalStatus, string> = {
  proposed: 'Proposed',
  approved: 'Approved',
  applied: 'Applied',
  rejected: 'Rejected',
  superseded: 'Superseded',
  expired: 'Expired'
}

export function memoryProposalKindLabel(kind: MemoryProposalKind): string {
  return KIND_LABELS[kind]
}

export function memoryProposalScopeLabel(scope: MemoryProposalScope): string {
  return SCOPE_LABELS[scope]
}

export function memoryProposalStatusLabel(status: MemoryProposalStatus): string {
  return STATUS_LABELS[status]
}

export function memoryProposalKindBadgeClass(kind: MemoryProposalKind): string {
  return `memory-proposal-kind memory-proposal-kind--${kind.replace(/_/g, '-')}`
}

export function memoryProposalScopeBadgeClass(scope: MemoryProposalScope): string {
  return `memory-proposal-scope memory-proposal-scope--${scope}`
}

export function memoryProposalStatusBadgeClass(status: MemoryProposalStatus): string {
  return `memory-proposal-status memory-proposal-status--${status}`
}

export function formatMemoryProposalConfidence(confidence: number): string {
  const clamped = Math.max(0, Math.min(1, confidence))
  return `${Math.round(clamped * 100)}%`
}

export function memoryProposalConfidenceClass(confidence: number): string {
  if (confidence >= 0.75) return 'memory-proposal-confidence memory-proposal-confidence--high'
  if (confidence >= 0.5) return 'memory-proposal-confidence memory-proposal-confidence--medium'
  return 'memory-proposal-confidence memory-proposal-confidence--low'
}

const APPLYABLE_KINDS = new Set<MemoryProposalKind>([
  'repo_convention',
  'do_not_repeat',
  'skill_patch'
])

/** @deprecated Use isApplyableMemoryProposalKind — kept for callers that still say “phase 1”. */
export function isPhase1ApplyableKind(kind: MemoryProposalKind): boolean {
  return kind === 'repo_convention' || kind === 'do_not_repeat'
}

export function isApplyableMemoryProposalKind(kind: MemoryProposalKind): boolean {
  return APPLYABLE_KINDS.has(kind)
}

export function canReviewMemoryProposal(proposal: MemoryProposal): boolean {
  return proposal.status === 'proposed' && proposal.requiresReview
}

export function canApplyMemoryProposal(proposal: MemoryProposal): boolean {
  return proposal.status === 'approved' && isApplyableMemoryProposalKind(proposal.kind)
}

const APPLY_BLOCKED_LABELS: Record<string, string> = {
  pack_not_found: 'Proposal pack not found.',
  proposal_not_found: 'Proposal not found.',
  proposal_not_approved: 'Proposal must be approved before apply.',
  workspace_required: 'Pack must be scoped to a workspace before apply.',
  workspace_path_required: 'Pack must include a workspace path for workspace skill apply.',
  kind_not_supported_phase1: 'This proposal kind cannot be applied yet.',
  skill_patch_not_supported_phase1:
    'Skill patches remain review-only until the Skill Patch Manager ships.',
  skill_patch_invalid_target: 'Skill patch is missing a valid TaskWraith skill target.',
  skill_patch_path_escape: 'Skill patch skill id would escape the TaskWraith skill root.',
  skills_store_unavailable: 'TaskWraith skills store is unavailable for apply.',
  bug_not_supported_phase1: 'Bug proposals cannot be applied yet.',
  preference_not_supported_phase1: 'User preferences cannot be applied yet.',
  provider_hint_not_supported_phase1: 'Provider hints cannot be applied yet.',
  failure_mode_not_supported_phase1: 'Failure-mode proposals cannot be applied yet.'
}

export function formatApplyMemoryProposalBlocked(blocked: string): string {
  return APPLY_BLOCKED_LABELS[blocked] ?? `Apply blocked: ${blocked}`
}

export function memoryProposalApplyHint(proposal: MemoryProposal): string {
  if (proposal.status === 'applied') {
    if (proposal.applyReceipt?.target === 'TaskWraithSkill') {
      const skillId = proposal.applyReceipt.skillId
      return skillId
        ? `Applied to TaskWraith skills (${skillId}).`
        : 'Applied to TaskWraith skills.'
    }
    const entryId = proposal.applyReceipt?.conventionEntryId
    return entryId ? `Applied to repo conventions (${entryId}).` : 'Applied to repo conventions.'
  }
  if (canApplyMemoryProposal(proposal)) {
    if (proposal.kind === 'skill_patch') {
      return 'Approved — ready to apply to TaskWraith skills.'
    }
    return 'Approved — ready to apply to repo conventions.'
  }
  if (proposal.status === 'approved' && !isApplyableMemoryProposalKind(proposal.kind)) {
    return 'Apply is not available for this kind yet.'
  }
  if (proposal.requiresReview) {
    return 'Requires review before apply.'
  }
  return 'Approve before apply.'
}

export function formatMemoryProposalWindow(start: string, end: string): string {
  const startMs = Date.parse(start)
  const endMs = Date.parse(end)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return `${start} → ${end}`
  }
  const fmt = (ms: number): string =>
    new Date(ms).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    })
  return `${fmt(startMs)} → ${fmt(endMs)}`
}

export function filterMemoryProposals(
  proposals: MemoryProposal[],
  filters: {
    kinds: Set<MemoryProposalKind>
    scopes: Set<MemoryProposalScope>
    statuses: Set<MemoryProposalStatus>
    search: string
  }
): MemoryProposal[] {
  const needle = filters.search.trim().toLowerCase()
  return proposals.filter((proposal) => {
    if (!filters.kinds.has(proposal.kind)) return false
    if (!filters.scopes.has(proposal.scope)) return false
    if (!filters.statuses.has(proposal.status)) return false
    if (needle) {
      const haystack =
        `${proposal.title} ${proposal.lesson} ${proposal.suggestedApplyTarget ?? ''} ${proposal.dedupKey}`.toLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  })
}
