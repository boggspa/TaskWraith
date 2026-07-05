/*
 * Pure proposal classification over normalized introspection evidence.
 *
 * Converts harvested signals (approval friction, tool failures, feedback, etc.)
 * into reviewable MemoryProposal candidates. Does not read disk or mutate skills.
 */

import { randomUUID } from 'crypto'
import {
  dedupeMemoryProposals,
  evidenceItemToRef,
  proposalRequiresReview
} from './IntrospectionModel'
import type {
  IntrospectionEvidenceItem,
  MemoryProposal,
  MemoryProposalKind,
  MemoryProposalScope
} from '../store/types'

export interface EvidenceSignalClassification {
  kind: MemoryProposalKind
  scope: MemoryProposalScope
  baseConfidence: number
  suggestedApplyTarget?: string
}

export interface GenerateProposalsOptions {
  minConfidence?: number
  nowIso?: string
  idFactory?: () => string
}

const SIGNAL_CLASSIFICATION: Record<string, EvidenceSignalClassification> = {
  approval_denied: {
    kind: 'failure_mode',
    scope: 'workspace',
    baseConfidence: 0.62,
    suggestedApplyTarget: 'approval_policy'
  },
  approval_timeout: {
    kind: 'failure_mode',
    scope: 'workspace',
    baseConfidence: 0.58,
    suggestedApplyTarget: 'approval_policy'
  },
  tool_failure: {
    kind: 'failure_mode',
    scope: 'workspace',
    baseConfidence: 0.7
  },
  tool_loop: {
    kind: 'do_not_repeat',
    scope: 'workspace',
    baseConfidence: 0.68,
    suggestedApplyTarget: 'blackboard:do-not-repeat'
  },
  provider_error: {
    kind: 'failure_mode',
    scope: 'provider',
    baseConfidence: 0.66
  },
  feedback_down: {
    kind: 'preference',
    scope: 'user',
    baseConfidence: 0.55,
    suggestedApplyTarget: 'user_rules'
  },
  feedback_correction: {
    kind: 'preference',
    scope: 'user',
    baseConfidence: 0.6,
    suggestedApplyTarget: 'user_rules'
  },
  user_correction: {
    kind: 'preference',
    scope: 'user',
    baseConfidence: 0.57,
    suggestedApplyTarget: 'user_rules'
  },
  repeated_retry: {
    kind: 'do_not_repeat',
    scope: 'workspace',
    baseConfidence: 0.6,
    suggestedApplyTarget: 'blackboard:do-not-repeat'
  },
  repo_convention_hint: {
    kind: 'repo_convention',
    scope: 'workspace',
    baseConfidence: 0.72,
    suggestedApplyTarget: 'RepoConventionIndex'
  },
  skill_candidate: {
    kind: 'skill_patch',
    scope: 'skill',
    baseConfidence: 0.5,
    suggestedApplyTarget: 'skill_file'
  },
  product_bug: {
    kind: 'bug',
    scope: 'bug',
    baseConfidence: 0.65,
    suggestedApplyTarget: 'issue_tracker'
  },
  provider_hint: {
    kind: 'provider_hint',
    scope: 'provider',
    baseConfidence: 0.6,
    suggestedApplyTarget: 'provider_runtime_hint'
  }
}

export function classifyEvidenceSignal(signal: string): EvidenceSignalClassification | null {
  const normalized = String(signal || '')
    .trim()
    .toLowerCase()
  return SIGNAL_CLASSIFICATION[normalized] ?? null
}

export function buildProposalDedupKey(
  kind: MemoryProposalKind,
  signal: string,
  chatId: string
): string {
  return `${kind}:${signal}:${chatId}`
}

function distillLesson(item: IntrospectionEvidenceItem, kind: MemoryProposalKind): string {
  const detail = item.detail?.trim()
  if (detail) {
    return detail.slice(0, 500)
  }
  switch (kind) {
    case 'preference':
      return `User preference signal from ${item.signal}: ${item.summary}`
    case 'failure_mode':
      return `Observed failure pattern (${item.signal}): ${item.summary}`
    case 'repo_convention':
      return `Workspace convention candidate: ${item.summary}`
    case 'provider_hint':
      return `Provider-specific hint (${item.provider ?? 'unknown'}): ${item.summary}`
    case 'skill_patch':
      return `Skill distillation candidate: ${item.summary}`
    case 'bug':
      return `Product issue candidate: ${item.summary}`
    case 'do_not_repeat':
    default:
      return `Do-not-repeat pattern (${item.signal}): ${item.summary}`
  }
}

function proposalTitle(item: IntrospectionEvidenceItem, kind: MemoryProposalKind): string {
  const prefix =
    kind === 'preference'
      ? 'Preference'
      : kind === 'failure_mode'
        ? 'Failure mode'
        : kind === 'repo_convention'
          ? 'Repo convention'
          : kind === 'provider_hint'
            ? 'Provider hint'
            : kind === 'skill_patch'
              ? 'Skill patch'
              : kind === 'bug'
                ? 'Bug'
                : 'Do not repeat'
  return `${prefix}: ${item.summary}`.slice(0, 240)
}

function confidenceForItem(
  classification: EvidenceSignalClassification,
  item: IntrospectionEvidenceItem
): number {
  let confidence = classification.baseConfidence
  if (item.source === 'message_feedback') confidence += 0.05
  if (item.source === 'approval_ledger') confidence += 0.03
  if (item.detail && item.detail.length > 40) confidence += 0.04
  return Math.min(1, confidence)
}

export function proposalFromEvidenceItem(
  item: IntrospectionEvidenceItem,
  options: GenerateProposalsOptions = {}
): MemoryProposal | null {
  const classification = classifyEvidenceSignal(item.signal)
  if (!classification) return null
  const nowIso = options.nowIso ?? new Date().toISOString()
  const idFactory = options.idFactory ?? randomUUID
  const scope =
    classification.kind === 'provider_hint' || classification.kind === 'failure_mode'
      ? item.provider
        ? 'provider'
        : classification.scope
      : classification.scope
  const confidence = confidenceForItem(classification, item)
  const kind = classification.kind
  const resolvedScope: MemoryProposalScope =
    scope === 'provider' ? 'provider' : classification.scope
  return {
    id: idFactory(),
    kind,
    scope: resolvedScope,
    status: 'proposed',
    title: proposalTitle(item, kind),
    lesson: distillLesson(item, kind),
    confidence,
    evidenceRefs: [evidenceItemToRef(item)],
    dedupKey: buildProposalDedupKey(kind, item.signal, item.chatId),
    requiresReview: proposalRequiresReview(kind, confidence),
    createdAt: nowIso,
    updatedAt: nowIso,
    ...(classification.suggestedApplyTarget
      ? { suggestedApplyTarget: classification.suggestedApplyTarget }
      : {}),
    ...(item.provider ? { providerId: item.provider } : {})
  }
}

export function generateProposalsFromEvidence(
  items: IntrospectionEvidenceItem[],
  options: GenerateProposalsOptions = {}
): MemoryProposal[] {
  const minConfidence = options.minConfidence ?? 0.5
  const raw = items
    .map((item) => proposalFromEvidenceItem(item, options))
    .filter((proposal): proposal is MemoryProposal => Boolean(proposal))
    .filter((proposal) => proposal.confidence >= minConfidence)
  return dedupeMemoryProposals(raw)
}

export function buildMemoryProposalPackInput(input: {
  introspectionRunId: string
  workspaceId?: string
  workspacePath?: string
  windowStart: string
  windowEnd: string
  evidenceItems: IntrospectionEvidenceItem[]
  summary?: string
  minConfidence?: number
  nowIso?: string
  idFactory?: () => string
}): {
  proposals: MemoryProposal[]
  evidenceItemCount: number
  summary?: string
} {
  const proposals = generateProposalsFromEvidence(input.evidenceItems, {
    minConfidence: input.minConfidence,
    nowIso: input.nowIso,
    idFactory: input.idFactory
  })
  return {
    proposals,
    evidenceItemCount: input.evidenceItems.length,
    ...(input.summary ? { summary: input.summary } : {})
  }
}