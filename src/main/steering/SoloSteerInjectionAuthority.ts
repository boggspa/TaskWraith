import {
  SOLO_STEER_TRANSCRIPT_PREPARATION,
  midRunQueuedMessageId
} from '../../shared/midRunSteeringQueue'
import type { ChatMessage, ProviderId, RunQueueJob, RunQueueRequestSnapshot } from '../store/types'

export type SoloSteerInjectionJobClass = 'prepared-transcript-barrier' | 'promoted-queued-job'

export type SoloSteerInjectionAuthorityFailureReason =
  | 'invalid_input'
  | 'job_identity_mismatch'
  | 'invalid_promotion_authority'
  | 'invalid_job_origin'
  | 'missing_request'
  | 'invalid_transcript_row'

export interface VerifiedSoloSteerInjectionAuthority {
  kind: 'verified'
  jobClass: SoloSteerInjectionJobClass
  job: RunQueueJob
  request: RunQueueRequestSnapshot
  message: ChatMessage
  messageId: string
  text: string
}

export type SoloSteerInjectionAuthorityResult =
  | VerifiedSoloSteerInjectionAuthority
  | {
      kind: 'invalid'
      reason: SoloSteerInjectionAuthorityFailureReason
    }

export interface ResolveSoloSteerInjectionAuthorityInput {
  queuedRunId: string
  chatId: string
  provider: ProviderId
  ownerToken: string
  job: RunQueueJob | null | undefined
  messages: readonly ChatMessage[]
}

/**
 * Proves that one main-owned queue promotion and one exact durable transcript
 * row describe the same solo steer.
 *
 * There are two legitimate origins. Composer Steer creates a non-runnable
 * first-write transcript barrier, while a queued-row Steer promotes an
 * ordinary job that already has durable queue provenance. The latter must not
 * impersonate the former by supplying barrier metadata, and the former keeps
 * its exact preparation marker requirement.
 */
export function resolveSoloSteerInjectionAuthority(
  input: ResolveSoloSteerInjectionAuthorityInput
): SoloSteerInjectionAuthorityResult {
  if (
    !isNonEmptyString(input.queuedRunId) ||
    !isNonEmptyString(input.chatId) ||
    !isNonEmptyString(input.provider) ||
    !isNonEmptyString(input.ownerToken)
  ) {
    return { kind: 'invalid', reason: 'invalid_input' }
  }

  const job = input.job
  if (
    !job ||
    job.status !== 'steer_promoting' ||
    job.runId !== input.queuedRunId ||
    job.chatId !== input.chatId ||
    job.provider !== input.provider
  ) {
    return { kind: 'invalid', reason: 'job_identity_mismatch' }
  }

  const messageId = midRunQueuedMessageId(input.queuedRunId)
  if (
    job.queueMessageId !== messageId ||
    job.promotionOwnerToken !== input.ownerToken ||
    job.promotionToken !== input.ownerToken ||
    !isNonEmptyString(job.promotedAt) ||
    !isPositiveInteger(job.promotionAttempt) ||
    !isPositiveInteger(job.transitionVersion)
  ) {
    return { kind: 'invalid', reason: 'invalid_promotion_authority' }
  }

  const jobClass = classifyJobOrigin(job)
  if (!jobClass) return { kind: 'invalid', reason: 'invalid_job_origin' }
  if (!job.request) return { kind: 'invalid', reason: 'missing_request' }

  const matchingRows = input.messages.filter((message) => message.id === messageId)
  if (matchingRows.length !== 1) {
    return { kind: 'invalid', reason: 'invalid_transcript_row' }
  }
  const message = matchingRows[0]
  const transcriptSummary = typeof message.content === 'string' ? message.content.trim() : ''
  if (
    message.role !== 'user' ||
    !transcriptSummary ||
    message.metadata?.kind !== 'midRunSteering' ||
    message.metadata?.midRunQueueRunId !== input.queuedRunId ||
    message.metadata?.midRunQueueSource !== 'soloSteer'
  ) {
    return { kind: 'invalid', reason: 'invalid_transcript_row' }
  }

  // The transcript row is an identity/correlation proof, not payload
  // authority. Its content may deliberately be a renderer-facing preview
  // (for example `displayPrompt`) and must never replace the exact prompt in
  // main's persisted request snapshot. Context-only steers have no prompt, so
  // their verified stable transcript summary is the text envelope delivered
  // alongside the persisted attachments/context.
  const requestPrompt = typeof job.request.prompt === 'string' ? job.request.prompt.trim() : ''
  const text = requestPrompt || transcriptSummary

  return {
    kind: 'verified',
    jobClass,
    job,
    request: job.request,
    message,
    messageId,
    text
  }
}

function classifyJobOrigin(job: RunQueueJob): SoloSteerInjectionJobClass | null {
  if (job.steerPreparationKind === SOLO_STEER_TRANSCRIPT_PREPARATION) {
    return 'prepared-transcript-barrier'
  }
  if (job.steerPreparationKind !== undefined || !isNonEmptyString(job.enqueuedAt)) {
    return null
  }
  return 'promoted-queued-job'
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim())
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}
