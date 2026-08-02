import type {
  ContinuationProposalCandidateKind,
  ContinuationProposalRequest,
  ContinuationProposalSnapshot
} from './store/types'

/**
 * Validation seam for the local Foundation Models continuation ranker.
 *
 * This protocol is deliberately much narrower than close-out summarization:
 * the request contains only host-generated enum state and opaque candidate
 * identifiers. It has no textual telemetry for a model to follow, and a
 * response can only select a candidate that was already safe to show.
 */

const MAX_CANDIDATES = 8
const MAX_ID_LENGTH = 180

const CANDIDATE_KINDS = new Set<ContinuationProposalCandidateKind>([
  'picker-dismissed',
  'task-continuation',
  'lane-failed',
  'uncommitted-changes'
])

const PHASES = new Set<ContinuationProposalRequest['phase']>(['none', 'working', 'blocked'])
const ROUND_STATES = new Set<ContinuationProposalRequest['roundState']>([
  'none',
  'completed',
  'partial-success',
  'all-failed'
])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function compactId(value: unknown, label: string): string {
  const text = String(value ?? '')
    .trim()
    .slice(0, MAX_ID_LENGTH)
  if (!text) throw new Error(`${label} is required.`)
  // Candidate/checkpoint ids are host-created identifiers, not display prose.
  if (!/^[A-Za-z0-9._,:-]+$/.test(text)) throw new Error(`${label} is invalid.`)
  return text
}

function optionalCompactText(value: unknown, maxLength: number): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

export function sanitizeContinuationProposalRequest(input: unknown): ContinuationProposalRequest {
  const record = asRecord(input) || {}
  const chatId = optionalCompactText(record.chatId, 180)
  if (!chatId) throw new Error('Continuation proposal chat id is required.')
  const checkpointId = compactId(record.checkpointId, 'Continuation checkpoint id')
  const phase = record.phase
  if (typeof phase !== 'string' || !PHASES.has(phase as ContinuationProposalRequest['phase'])) {
    throw new Error('Continuation checkpoint phase is invalid.')
  }
  const roundState = record.roundState
  if (
    typeof roundState !== 'string' ||
    !ROUND_STATES.has(roundState as ContinuationProposalRequest['roundState'])
  ) {
    throw new Error('Continuation checkpoint round state is invalid.')
  }

  const seen = new Set<string>()
  const candidates = Array.isArray(record.candidates)
    ? record.candidates
        .slice(0, MAX_CANDIDATES)
        .flatMap((raw): ContinuationProposalRequest['candidates'] => {
          const candidate = asRecord(raw)
          if (!candidate) return []
          try {
            const id = compactId(candidate.id, 'Continuation candidate id')
            const kind = candidate.kind
            if (
              typeof kind !== 'string' ||
              !CANDIDATE_KINDS.has(kind as ContinuationProposalCandidateKind)
            ) {
              return []
            }
            if (seen.has(id)) return []
            seen.add(id)
            return [{ id, kind: kind as ContinuationProposalCandidateKind }]
          } catch {
            return []
          }
        })
    : []
  if (candidates.length === 0) throw new Error('At least one continuation candidate is required.')

  return {
    chatId,
    checkpointId,
    phase: phase as ContinuationProposalRequest['phase'],
    roundState: roundState as ContinuationProposalRequest['roundState'],
    candidates
  }
}

export function normalizeContinuationProposalResult(
  request: ContinuationProposalRequest,
  result: unknown,
  generatedAt: string
): ContinuationProposalSnapshot {
  const record = asRecord(result) || {}
  const candidateId = optionalCompactText(record.candidateId, MAX_ID_LENGTH)
  if (!candidateId || !request.candidates.some((candidate) => candidate.id === candidateId)) {
    return buildContinuationProposalUnavailableSnapshot(
      request,
      'Foundation Models returned an unknown continuation candidate.'
    )
  }
  return {
    checkpointId: request.checkpointId,
    generatedAt,
    status: 'ready',
    candidateId,
    model: optionalCompactText(record.model, 120) || 'Apple Foundation Models'
  }
}

export function buildContinuationProposalUnavailableSnapshot(
  request: ContinuationProposalRequest,
  reason: string
): ContinuationProposalSnapshot {
  return {
    checkpointId: request.checkpointId,
    generatedAt: new Date().toISOString(),
    status: 'unavailable',
    error: optionalCompactText(reason, 500) || 'Local continuation ranking is unavailable.'
  }
}
