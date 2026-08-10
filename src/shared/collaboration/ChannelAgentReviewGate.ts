/**
 * Channels P3 participation is deliberately source-gated until the signed
 * identity/delegation implementation has completed adversarial review.
 *
 * This is not a feature flag, environment variable, persisted setting, IPC
 * value, or renderer choice. Pre-review production code must call the guard
 * and fail closed. Enabling participation therefore requires a reviewed source
 * change that can name the accepted review record.
 */

export const CHANNEL_AGENT_REVIEW_ID = 'channels-p3-agent-participation-v1' as const

export const CHANNEL_AGENT_PARTICIPATION_REVIEW_GATE = Object.freeze({
  schemaVersion: 1 as const,
  reviewId: CHANNEL_AGENT_REVIEW_ID,
  status: 'blocked_pending_adversarial_review' as const,
  participationEnabled: false as const
})

export const CHANNEL_AGENT_REVIEW_REQUIRED_CODE = 'channel_agent_review_required' as const

/** Compile-time and runtime constant: callers cannot inject an override. */
export function channelAgentParticipationEnabled(): false {
  return false
}

/** Stable fail-closed boundary for every pre-review production entry point. */
export function assertChannelAgentParticipationReviewed(): never {
  throw new Error(
    `${CHANNEL_AGENT_REVIEW_REQUIRED_CODE}: ${CHANNEL_AGENT_REVIEW_ID} has not passed adversarial review`
  )
}
