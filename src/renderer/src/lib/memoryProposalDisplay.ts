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

const PHASE1_APPLYABLE_KINDS = new Set<MemoryProposalKind>(['repo_convention', 'do_not_repeat'])

export function isPhase1ApplyableKind(kind: MemoryProposalKind): boolean {
  return PHASE1_APPLYABLE_KINDS.has(kind)
}

export function canReviewMemoryProposal(proposal: MemoryProposal): boolean {
  return proposal.status === 'proposed' && proposal.requiresReview
}

export function canApplyMemoryProposal(proposal: MemoryProposal): boolean {
  return proposal.status === 'approved' && isPhase1ApplyableKind(proposal.kind)
}

const APPLY_BLOCKED_LABELS: Record<string, string> = {
  pack_not_found: 'Proposal pack not found.',
  proposal_not_found: 'Proposal not found.',
  proposal_not_approved: 'Proposal must be approved before apply.',
  workspace_required: 'Pack must be scoped to a workspace before apply.',
  kind_not_supported_phase1: 'This proposal kind cannot be applied in phase 1.',
  skill_patch_not_supported_phase1:
    'Skill patches remain review-only until the Skill Patch Manager ships.',
  bug_not_supported_phase1: 'Bug proposals cannot be applied in phase 1.',
  preference_not_supported_phase1: 'User preferences cannot be applied in phase 1.',
  provider_hint_not_supported_phase1: 'Provider hints cannot be applied in phase 1.',
  failure_mode_not_supported_phase1: 'Failure-mode proposals cannot be applied in phase 1.'
}

export function formatApplyMemoryProposalBlocked(blocked: string): string {
  return APPLY_BLOCKED_LABELS[blocked] ?? `Apply blocked: ${blocked}`
}

export function memoryProposalApplyHint(proposal: MemoryProposal): string {
  if (proposal.status === 'applied') {
    const entryId = proposal.applyReceipt?.conventionEntryId
    return entryId
      ? `Applied to repo conventions (${entryId}).`
      : 'Applied to repo conventions.'
  }
  if (canApplyMemoryProposal(proposal)) {
    return 'Approved — ready to apply to repo conventions.'
  }
  if (proposal.status === 'approved' && !isPhase1ApplyableKind(proposal.kind)) {
    return 'Apply is not available for this kind in phase 1.'
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