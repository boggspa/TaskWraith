/*
 * Thread Introspection — pure normalization + proposal hygiene.
 *
 * Keeps memory-promotion records distinct from EvidencePackRecord (per-run
 * capability verification). All thread content arriving here is untrusted
 * evidence; only distilled lessons in MemoryProposal.lesson may be promoted.
 */

import type {
  IntrospectionEvidenceItem,
  IntrospectionEvidenceRef,
  IntrospectionEvidenceSource,
  IntrospectionRunRecord,
  IntrospectionRunStatus,
  IntrospectionRunTrigger,
  MemoryProposal,
  MemoryProposalApplyReceipt,
  MemoryProposalKind,
  MemoryProposalPack,
  MemoryProposalScope,
  MemoryProposalStatus,
  ProviderId
} from '../store/types'

export const INTROSPECTION_SCHEMA_VERSION = 1 as const

const PROPOSAL_KINDS = new Set<MemoryProposalKind>([
  'preference',
  'failure_mode',
  'repo_convention',
  'provider_hint',
  'skill_patch',
  'bug',
  'do_not_repeat'
])

const PROPOSAL_SCOPES = new Set<MemoryProposalScope>([
  'user',
  'workspace',
  'provider',
  'skill',
  'bug'
])

const PROPOSAL_STATUSES = new Set<MemoryProposalStatus>([
  'proposed',
  'approved',
  'applied',
  'rejected',
  'superseded',
  'expired'
])

const RUN_STATUSES = new Set<IntrospectionRunStatus>([
  'collecting',
  'analyzing',
  'review_pending',
  'completed',
  'failed',
  'cancelled'
])

const RUN_TRIGGERS = new Set<IntrospectionRunTrigger>(['manual', 'scheduled', 'workflow'])

const EVIDENCE_SOURCES = new Set<IntrospectionEvidenceSource>([
  'run_event',
  'message_feedback',
  'approval_ledger',
  'chat_message',
  'blackboard'
])

const PROVIDERS = new Set<ProviderId>([
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  'pi'
])

const MAX_TEXT = 2000
const MAX_TITLE = 240
const MAX_SUMMARY = 500
const MAX_QUOTE = 400
const MAX_EVIDENCE_REFS = 32
const MAX_EVIDENCE_ITEMS = 500
const MAX_PROPOSALS = 200

function text(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

function arr<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function clamp01(value: unknown, fallback = 0.5): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(1, Math.max(0, n))
}

function iso(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function provider(value: unknown): ProviderId | undefined {
  return typeof value === 'string' && PROVIDERS.has(value as ProviderId)
    ? (value as ProviderId)
    : undefined
}

export function defaultScopeForKind(kind: MemoryProposalKind): MemoryProposalScope {
  switch (kind) {
    case 'preference':
      return 'user'
    case 'provider_hint':
    case 'failure_mode':
      return 'provider'
    case 'skill_patch':
      return 'skill'
    case 'bug':
      return 'bug'
    case 'repo_convention':
    case 'do_not_repeat':
    default:
      return 'workspace'
  }
}

/** Skill patches and bugs always need human review before durable mutation. */
export function proposalRequiresReview(kind: MemoryProposalKind, confidence: number): boolean {
  if (kind === 'skill_patch' || kind === 'bug') return true
  if (kind === 'preference' || kind === 'repo_convention') return confidence < 0.75
  return confidence < 0.65
}

export function normalizeMemoryProposalApplyReceipt(
  value: unknown
): MemoryProposalApplyReceipt | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<MemoryProposalApplyReceipt>
  const appliedAt = text(input.appliedAt, 64)
  const conventionEntryId = text(input.conventionEntryId, 120)
  const packId = text(input.packId, 120)
  const proposalId = text(input.proposalId, 120)
  if (!appliedAt || !conventionEntryId || !packId || !proposalId) return null
  if (input.target !== 'RepoConventionIndex') return null
  return {
    appliedAt,
    target: 'RepoConventionIndex',
    conventionEntryId,
    packId,
    proposalId
  }
}

export function normalizeIntrospectionEvidenceRef(value: unknown): IntrospectionEvidenceRef | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<IntrospectionEvidenceRef>
  const chatId = text(input.chatId, 120)
  const summary = text(input.summary, MAX_SUMMARY)
  const timestamp = text(input.timestamp, 64)
  if (!chatId || !summary || !timestamp) return null
  return {
    chatId,
    timestamp,
    summary,
    ...(text(input.runId, 120) ? { runId: text(input.runId, 120) } : {}),
    ...(text(input.messageId, 120) ? { messageId: text(input.messageId, 120) } : {}),
    ...(text(input.eventId, 120) ? { eventId: text(input.eventId, 120) } : {}),
    ...(text(input.citationToken, 160) ? { citationToken: text(input.citationToken, 160) } : {}),
    ...(text(input.quote, MAX_QUOTE) ? { quote: text(input.quote, MAX_QUOTE) } : {})
  }
}

export function normalizeIntrospectionEvidenceItem(value: unknown): IntrospectionEvidenceItem | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<IntrospectionEvidenceItem>
  const id = text(input.id, 120)
  const chatId = text(input.chatId, 120)
  const signal = text(input.signal, 120)
  const summary = text(input.summary, MAX_SUMMARY)
  const timestamp = text(input.timestamp, 64)
  const source = input.source
  if (!id || !chatId || !signal || !summary || !timestamp) return null
  if (!source || !EVIDENCE_SOURCES.has(source)) return null
  return {
    id,
    source,
    signal,
    chatId,
    timestamp,
    summary,
    ...(text(input.runId, 120) ? { runId: text(input.runId, 120) } : {}),
    ...(text(input.messageId, 120) ? { messageId: text(input.messageId, 120) } : {}),
    ...(text(input.eventId, 120) ? { eventId: text(input.eventId, 120) } : {}),
    ...(provider(input.provider) ? { provider: provider(input.provider) } : {}),
    ...(text(input.workspaceId, 120) ? { workspaceId: text(input.workspaceId, 120) } : {}),
    ...(text(input.detail, MAX_TEXT) ? { detail: text(input.detail, MAX_TEXT) } : {}),
    ...(text(input.citationToken, 160) ? { citationToken: text(input.citationToken, 160) } : {})
  }
}

export function normalizeMemoryProposal(value: unknown): MemoryProposal | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<MemoryProposal>
  const id = text(input.id, 120)
  const title = text(input.title, MAX_TITLE)
  const lesson = text(input.lesson, MAX_TEXT)
  const dedupKey = text(input.dedupKey, 240)
  const kind = input.kind
  const status = input.status
  const scope = input.scope
  const nowIso = new Date().toISOString()
  if (!id || !title || !lesson || !dedupKey) return null
  if (!kind || !PROPOSAL_KINDS.has(kind)) return null
  const resolvedScope =
    scope && PROPOSAL_SCOPES.has(scope) ? scope : defaultScopeForKind(kind)
  const resolvedStatus =
    status && PROPOSAL_STATUSES.has(status) ? status : 'proposed'
  const confidence = clamp01(input.confidence, 0.5)
  const evidenceRefs = arr<unknown>(input.evidenceRefs)
    .map((ref) => normalizeIntrospectionEvidenceRef(ref))
    .filter((ref): ref is IntrospectionEvidenceRef => Boolean(ref))
    .slice(0, MAX_EVIDENCE_REFS)
  if (evidenceRefs.length === 0) return null
  const applyReceipt = normalizeMemoryProposalApplyReceipt(input.applyReceipt)
  return {
    id,
    kind,
    scope: resolvedScope,
    status: resolvedStatus,
    title,
    lesson,
    confidence,
    evidenceRefs,
    dedupKey,
    requiresReview:
      typeof input.requiresReview === 'boolean'
        ? input.requiresReview
        : proposalRequiresReview(kind, confidence),
    createdAt: iso(input.createdAt, nowIso),
    updatedAt: iso(input.updatedAt, nowIso),
    ...(text(input.suggestedApplyTarget, 400)
      ? { suggestedApplyTarget: text(input.suggestedApplyTarget, 400) }
      : {}),
    ...(kind === 'skill_patch' && text(input.skillPatchDiff, 12000)
      ? { skillPatchDiff: text(input.skillPatchDiff, 12000) }
      : {}),
    ...(provider(input.providerId) ? { providerId: provider(input.providerId) } : {}),
    ...(text(input.expiresAt, 64) ? { expiresAt: text(input.expiresAt, 64) } : {}),
    ...(text(input.supersedesId, 120) ? { supersedesId: text(input.supersedesId, 120) } : {}),
    ...(text(input.supersededById, 120) ? { supersededById: text(input.supersededById, 120) } : {}),
    ...(text(input.reviewNote, MAX_SUMMARY) ? { reviewNote: text(input.reviewNote, MAX_SUMMARY) } : {}),
    ...(text(input.appliedAt, 64) ? { appliedAt: text(input.appliedAt, 64) } : {}),
    ...(applyReceipt ? { applyReceipt } : {})
  }
}

export function normalizeMemoryProposalPack(value: unknown): MemoryProposalPack | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<MemoryProposalPack>
  const id = text(input.id, 120)
  const introspectionRunId = text(input.introspectionRunId, 120)
  const windowStart = text(input.windowStart, 64)
  const windowEnd = text(input.windowEnd, 64)
  const nowIso = new Date().toISOString()
  if (!id || !introspectionRunId || !windowStart || !windowEnd) return null
  const proposals = arr<unknown>(input.proposals)
    .map((item) => normalizeMemoryProposal(item))
    .filter((item): item is MemoryProposal => Boolean(item))
    .slice(0, MAX_PROPOSALS)
  const evidenceItemCount = Number(input.evidenceItemCount)
  return {
    schemaVersion: 1,
    id,
    introspectionRunId,
    windowStart,
    windowEnd,
    proposals,
    evidenceItemCount:
      Number.isFinite(evidenceItemCount) && evidenceItemCount >= 0
        ? Math.floor(evidenceItemCount)
        : 0,
    createdAt: iso(input.createdAt, nowIso),
    updatedAt: iso(input.updatedAt, nowIso),
    ...(text(input.workspaceId, 120) ? { workspaceId: text(input.workspaceId, 120) } : {}),
    ...(text(input.workspacePath, 800) ? { workspacePath: text(input.workspacePath, 800) } : {}),
    ...(text(input.summary, 12000) ? { summary: text(input.summary, 12000) } : {})
  }
}

export function normalizeIntrospectionRunRecord(value: unknown): IntrospectionRunRecord | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<IntrospectionRunRecord>
  const id = text(input.id, 120)
  const windowStart = text(input.windowStart, 64)
  const windowEnd = text(input.windowEnd, 64)
  const trigger = input.trigger
  const status = input.status
  const nowIso = new Date().toISOString()
  if (!id || !windowStart || !windowEnd) return null
  if (!trigger || !RUN_TRIGGERS.has(trigger)) return null
  const evidenceItems = arr<unknown>(input.evidenceItems)
    .map((item) => normalizeIntrospectionEvidenceItem(item))
    .filter((item): item is IntrospectionEvidenceItem => Boolean(item))
    .slice(0, MAX_EVIDENCE_ITEMS)
  return {
    schemaVersion: 1,
    id,
    trigger,
    status: status && RUN_STATUSES.has(status) ? status : 'collecting',
    windowStart,
    windowEnd,
    evidenceItems,
    createdAt: iso(input.createdAt, nowIso),
    updatedAt: iso(input.updatedAt, nowIso),
    ...(text(input.workflowId, 120) ? { workflowId: text(input.workflowId, 120) } : {}),
    ...(text(input.chatId, 120) ? { chatId: text(input.chatId, 120) } : {}),
    ...(text(input.workspaceId, 120) ? { workspaceId: text(input.workspaceId, 120) } : {}),
    ...(text(input.workspacePath, 800) ? { workspacePath: text(input.workspacePath, 800) } : {}),
    ...(text(input.proposalPackId, 120) ? { proposalPackId: text(input.proposalPackId, 120) } : {}),
    ...(text(input.error, MAX_SUMMARY) ? { error: text(input.error, MAX_SUMMARY) } : {}),
    ...(text(input.startedAt, 64) ? { startedAt: text(input.startedAt, 64) } : {}),
    ...(text(input.endedAt, 64) ? { endedAt: text(input.endedAt, 64) } : {})
  }
}

/** Merge proposals sharing a dedupKey — max confidence, union evidence, stable id. */
export function dedupeMemoryProposals(proposals: MemoryProposal[]): MemoryProposal[] {
  const byKey = new Map<string, MemoryProposal>()
  const order: string[] = []
  for (const proposal of proposals) {
    const existing = byKey.get(proposal.dedupKey)
    if (!existing) {
      byKey.set(proposal.dedupKey, { ...proposal })
      order.push(proposal.dedupKey)
      continue
    }
    const evidenceSeen = new Set(
      existing.evidenceRefs.map((ref) => `${ref.chatId}:${ref.runId ?? ''}:${ref.eventId ?? ''}`)
    )
    const mergedEvidence = [...existing.evidenceRefs]
    for (const ref of proposal.evidenceRefs) {
      const key = `${ref.chatId}:${ref.runId ?? ''}:${ref.eventId ?? ''}`
      if (!evidenceSeen.has(key)) {
        evidenceSeen.add(key)
        mergedEvidence.push(ref)
      }
    }
    const confidence = Math.max(existing.confidence, proposal.confidence)
    byKey.set(proposal.dedupKey, {
      ...existing,
      confidence,
      evidenceRefs: mergedEvidence.slice(0, MAX_EVIDENCE_REFS),
      requiresReview: proposalRequiresReview(existing.kind, confidence)
    })
  }
  return order.map((key) => byKey.get(key)!)
}

export function evidenceItemToRef(item: IntrospectionEvidenceItem): IntrospectionEvidenceRef {
  return {
    chatId: item.chatId,
    runId: item.runId,
    timestamp: item.timestamp,
    summary: item.summary,
    ...(item.messageId ? { messageId: item.messageId } : {}),
    ...(item.eventId ? { eventId: item.eventId } : {}),
    ...(item.citationToken ? { citationToken: item.citationToken } : {}),
    ...(item.detail ? { quote: item.detail.slice(0, MAX_QUOTE) } : {})
  }
}