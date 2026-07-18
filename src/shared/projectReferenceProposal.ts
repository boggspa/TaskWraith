import type { ProjectReferenceKind } from './projects'

export const PROJECT_REFERENCE_PROPOSAL_SCHEMA_VERSION = 1
export const PROJECT_REFERENCE_PROPOSAL_PURPOSE = 'library-addition-proposal'

export const MAX_PROJECT_REFERENCE_PROPOSAL_ID_LENGTH = 256
export const MAX_PROJECT_REFERENCE_PROPOSAL_TITLE_LENGTH = 512
export const MAX_PROJECT_REFERENCE_PROPOSAL_LOCATOR_LENGTH = 4096
export const MAX_PROJECT_REFERENCE_PROPOSAL_REASON_LENGTH = 2000

export type ProjectReferenceProposalDecision = 'approve' | 'reject'

export interface ProjectReferenceProposalCandidate {
  kind: ProjectReferenceKind
  locator: string
  title: string
}

/**
 * Append-only proposal evidence. It intentionally carries no ProjectReference
 * provenance or review state: the Project registry remains user-owned, while
 * this candidate lives only in a `reference_context` run event.
 */
export interface ProjectReferenceProposedPayload {
  schemaVersion: 1
  purpose: typeof PROJECT_REFERENCE_PROPOSAL_PURPOSE
  action: 'proposed'
  proposalId: string
  projectId: string
  materializationReferenceId: string
  candidate: ProjectReferenceProposalCandidate
  reason?: string
  proposedAt: number
}

export interface ProjectReferenceProposalSource {
  runId: string
  eventId: string
  eventHash: string
}

/** A human decision appended to the same immutable run-event chain. */
export type ProjectReferenceReviewedPayload = {
  schemaVersion: 1
  purpose: typeof PROJECT_REFERENCE_PROPOSAL_PURPOSE
  action: 'reviewed'
  proposalId: string
  projectId: string
  decision: ProjectReferenceProposalDecision
  reviewedBy: 'user'
  source: ProjectReferenceProposalSource
  reviewedAt: number
  referenceId?: string
}

export type ProjectReferenceProposalEventPayload =
  | ProjectReferenceProposedPayload
  | ProjectReferenceReviewedPayload

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed)
  return Object.keys(record).every((key) => allowedKeys.has(key))
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength) return null
  // Proposal text is rendered as untrusted evidence and persisted durably.
  // Exclude terminal/control and bidi-isolate characters that could forge UI
  // structure without rejecting ordinary international text.
  for (const character of trimmed) {
    const codePoint = character.codePointAt(0) ?? 0
    if (
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      return null
    }
  }
  return trimmed
}

function boundedOptionalString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number
): string | null | undefined {
  if (!(key in record)) return undefined
  return boundedString(record[key], maxLength)
}

function boundedTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function isReferenceKind(value: unknown): value is ProjectReferenceKind {
  return value === 'file' || value === 'folder' || value === 'url'
}

function isPortableAbsolutePath(value: string): boolean {
  return (
    value.startsWith('/') ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.startsWith('\\\\') ||
    value.startsWith('//')
  )
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.username &&
      !parsed.password
    )
  } catch {
    return false
  }
}

export function parseProjectReferenceProposalCandidate(
  value: unknown
): ProjectReferenceProposalCandidate | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['kind', 'locator', 'title'])) return null
  if (!isReferenceKind(value.kind)) return null
  const locator = boundedString(value.locator, MAX_PROJECT_REFERENCE_PROPOSAL_LOCATOR_LENGTH)
  const title = boundedString(value.title, MAX_PROJECT_REFERENCE_PROPOSAL_TITLE_LENGTH)
  if (!locator || !title) return null
  if (value.kind === 'url' ? !isSafeHttpUrl(locator) : !isPortableAbsolutePath(locator)) {
    return null
  }
  return { kind: value.kind, locator, title }
}

export function parseProjectReferenceProposedPayload(
  value: unknown
): ProjectReferenceProposedPayload | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'schemaVersion',
      'purpose',
      'action',
      'proposalId',
      'projectId',
      'materializationReferenceId',
      'candidate',
      'reason',
      'proposedAt'
    ]) ||
    value.schemaVersion !== PROJECT_REFERENCE_PROPOSAL_SCHEMA_VERSION ||
    value.purpose !== PROJECT_REFERENCE_PROPOSAL_PURPOSE ||
    value.action !== 'proposed'
  ) {
    return null
  }
  const proposalId = boundedString(value.proposalId, MAX_PROJECT_REFERENCE_PROPOSAL_ID_LENGTH)
  const projectId = boundedString(value.projectId, MAX_PROJECT_REFERENCE_PROPOSAL_ID_LENGTH)
  const materializationReferenceId = boundedString(
    value.materializationReferenceId,
    MAX_PROJECT_REFERENCE_PROPOSAL_ID_LENGTH
  )
  const candidate = parseProjectReferenceProposalCandidate(value.candidate)
  const reason = boundedOptionalString(
    value,
    'reason',
    MAX_PROJECT_REFERENCE_PROPOSAL_REASON_LENGTH
  )
  const proposedAt = boundedTimestamp(value.proposedAt)
  if (
    !proposalId ||
    !projectId ||
    !materializationReferenceId ||
    !candidate ||
    reason === null ||
    proposedAt === null
  ) {
    return null
  }
  return {
    schemaVersion: 1,
    purpose: PROJECT_REFERENCE_PROPOSAL_PURPOSE,
    action: 'proposed',
    proposalId,
    projectId,
    materializationReferenceId,
    candidate,
    ...(reason ? { reason } : {}),
    proposedAt
  }
}

function parseProposalSource(value: unknown): ProjectReferenceProposalSource | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['runId', 'eventId', 'eventHash'])) return null
  const runId = boundedString(value.runId, MAX_PROJECT_REFERENCE_PROPOSAL_ID_LENGTH)
  const eventId = boundedString(value.eventId, MAX_PROJECT_REFERENCE_PROPOSAL_ID_LENGTH)
  const eventHash = boundedString(value.eventHash, 64)
  if (!runId || !eventId || !eventHash || !/^[a-f0-9]{64}$/i.test(eventHash)) return null
  return { runId, eventId, eventHash: eventHash.toLowerCase() }
}

export function parseProjectReferenceReviewedPayload(
  value: unknown
): ProjectReferenceReviewedPayload | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'schemaVersion',
      'purpose',
      'action',
      'proposalId',
      'projectId',
      'decision',
      'reviewedBy',
      'source',
      'reviewedAt',
      'referenceId'
    ]) ||
    value.schemaVersion !== PROJECT_REFERENCE_PROPOSAL_SCHEMA_VERSION ||
    value.purpose !== PROJECT_REFERENCE_PROPOSAL_PURPOSE ||
    value.action !== 'reviewed' ||
    value.reviewedBy !== 'user' ||
    (value.decision !== 'approve' && value.decision !== 'reject')
  ) {
    return null
  }
  const proposalId = boundedString(value.proposalId, MAX_PROJECT_REFERENCE_PROPOSAL_ID_LENGTH)
  const projectId = boundedString(value.projectId, MAX_PROJECT_REFERENCE_PROPOSAL_ID_LENGTH)
  const source = parseProposalSource(value.source)
  const reviewedAt = boundedTimestamp(value.reviewedAt)
  const referenceId = boundedOptionalString(
    value,
    'referenceId',
    MAX_PROJECT_REFERENCE_PROPOSAL_ID_LENGTH
  )
  if (!proposalId || !projectId || !source || reviewedAt === null || referenceId === null) {
    return null
  }
  if (value.decision === 'approve' ? !referenceId : referenceId !== undefined) return null
  return {
    schemaVersion: 1,
    purpose: PROJECT_REFERENCE_PROPOSAL_PURPOSE,
    action: 'reviewed',
    proposalId,
    projectId,
    decision: value.decision,
    reviewedBy: 'user',
    source,
    reviewedAt,
    ...(referenceId ? { referenceId } : {})
  }
}

export function parseProjectReferenceProposalEventPayload(
  value: unknown
): ProjectReferenceProposalEventPayload | null {
  if (!isRecord(value)) return null
  if (value.action === 'proposed') return parseProjectReferenceProposedPayload(value)
  if (value.action === 'reviewed') return parseProjectReferenceReviewedPayload(value)
  return null
}

/** Distinguishes unrelated `reference_context` events from corrupt proposal evidence. */
export function isProjectReferenceProposalPayload(value: unknown): boolean {
  return isRecord(value) && value.purpose === PROJECT_REFERENCE_PROPOSAL_PURPOSE
}
