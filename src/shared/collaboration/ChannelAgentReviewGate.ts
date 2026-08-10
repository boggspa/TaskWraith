/**
 * Channels P3 participation was enabled only after the exact signed
 * identity/delegation candidate completed adversarial review. The accepted
 * candidate and decision are named here so the shipping source boundary is
 * self-describing and reviewable without a runtime control plane.
 *
 * This is not a feature flag, environment variable, persisted setting, IPC
 * value, or renderer choice. Changing participation requires another reviewed
 * source change.
 */

export const CHANNEL_AGENT_REVIEW_ID = 'channels-p3-agent-participation-v1' as const

export const CHANNEL_AGENT_REVIEW_ACCEPTED_CANDIDATE =
  'b0f4d84e1fd84e2312f8375dcf7e6fc2d4ee63e4' as const

export const CHANNEL_AGENT_REVIEW_ACCEPTANCE_COMMIT =
  '92ad1e98259a95377b78c689b586e5e9f8d120d0' as const

export const CHANNEL_AGENT_REVIEW_RECORD = 'docs/channels-p3-adversarial-review.md' as const

export const CHANNEL_AGENT_PARTICIPATION_REVIEW_GATE = Object.freeze({
  schemaVersion: 2 as const,
  reviewId: CHANNEL_AGENT_REVIEW_ID,
  status: 'accepted' as const,
  participationEnabled: true as const,
  acceptedCandidate: CHANNEL_AGENT_REVIEW_ACCEPTED_CANDIDATE,
  acceptanceCommit: CHANNEL_AGENT_REVIEW_ACCEPTANCE_COMMIT,
  acceptanceRecord: CHANNEL_AGENT_REVIEW_RECORD
})

// Retained as the stable audit code for an explicitly injected closed-gate test lane.
export const CHANNEL_AGENT_REVIEW_REQUIRED_CODE = 'channel_agent_review_required' as const

/** Compile-time and runtime constant: callers cannot inject an override. */
export function channelAgentParticipationEnabled(): true {
  return true
}

/** Stable assertion boundary for callers that require the accepted review. */
export function assertChannelAgentParticipationReviewed(): void {
  return undefined
}
