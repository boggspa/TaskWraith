import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  assertChannelAgentParticipationReviewed,
  CHANNEL_AGENT_PARTICIPATION_REVIEW_GATE,
  CHANNEL_AGENT_REVIEW_ACCEPTANCE_COMMIT,
  CHANNEL_AGENT_REVIEW_ACCEPTED_CANDIDATE,
  CHANNEL_AGENT_REVIEW_ID,
  CHANNEL_AGENT_REVIEW_RECORD,
  channelAgentParticipationEnabled
} from './ChannelAgentReviewGate'

describe('ChannelAgentReviewGate', () => {
  it('is an immutable accepted production source gate', () => {
    expect(CHANNEL_AGENT_PARTICIPATION_REVIEW_GATE).toEqual({
      schemaVersion: 2,
      reviewId: CHANNEL_AGENT_REVIEW_ID,
      status: 'accepted',
      participationEnabled: true,
      acceptedCandidate: CHANNEL_AGENT_REVIEW_ACCEPTED_CANDIDATE,
      acceptanceCommit: CHANNEL_AGENT_REVIEW_ACCEPTANCE_COMMIT,
      acceptanceRecord: CHANNEL_AGENT_REVIEW_RECORD
    })
    expect(Object.isFrozen(CHANNEL_AGENT_PARTICIPATION_REVIEW_GATE)).toBe(true)
    expect(channelAgentParticipationEnabled()).toBe(true)
    expect(CHANNEL_AGENT_REVIEW_ACCEPTED_CANDIDATE).toBe('b0f4d84e1fd84e2312f8375dcf7e6fc2d4ee63e4')
    expect(CHANNEL_AGENT_REVIEW_ACCEPTANCE_COMMIT).toBe('92ad1e98259a95377b78c689b586e5e9f8d120d0')
    expect(CHANNEL_AGENT_REVIEW_RECORD).toBe('docs/channels-p3-adversarial-review.md')
  })

  it('accepts the tracked adversarial review', () => {
    expect(assertChannelAgentParticipationReviewed()).toBeUndefined()
  })

  it('has no environment, settings, IPC, or caller-supplied bypass seam', () => {
    const source = readFileSync(new URL('./ChannelAgentReviewGate.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(
      /process\.env|import\.meta\.env|localStorage|from ['"][^'"]*settings|ipc(Main|Renderer)\b/
    )
    expect(source).toContain('return CHANNEL_AGENT_PARTICIPATION_REVIEW_GATE.participationEnabled')
    expect(channelAgentParticipationEnabled.length).toBe(0)
    expect(assertChannelAgentParticipationReviewed.length).toBe(0)
  })
})
