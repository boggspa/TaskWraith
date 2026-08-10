import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  assertChannelAgentParticipationReviewed,
  CHANNEL_AGENT_PARTICIPATION_REVIEW_GATE,
  CHANNEL_AGENT_REVIEW_ID,
  CHANNEL_AGENT_REVIEW_REQUIRED_CODE,
  channelAgentParticipationEnabled
} from './ChannelAgentReviewGate'

describe('ChannelAgentReviewGate', () => {
  it('is an immutable production-disabled source gate', () => {
    expect(CHANNEL_AGENT_PARTICIPATION_REVIEW_GATE).toEqual({
      schemaVersion: 1,
      reviewId: CHANNEL_AGENT_REVIEW_ID,
      status: 'blocked_pending_adversarial_review',
      participationEnabled: false
    })
    expect(Object.isFrozen(CHANNEL_AGENT_PARTICIPATION_REVIEW_GATE)).toBe(true)
    expect(channelAgentParticipationEnabled()).toBe(false)
  })

  it('fails closed with a stable machine-readable code', () => {
    expect(assertChannelAgentParticipationReviewed).toThrow(
      `${CHANNEL_AGENT_REVIEW_REQUIRED_CODE}: ${CHANNEL_AGENT_REVIEW_ID}`
    )
  })

  it('has no environment, settings, IPC, or caller-supplied bypass seam', () => {
    const source = readFileSync(new URL('./ChannelAgentReviewGate.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(
      /process\.env|import\.meta\.env|localStorage|from ['"][^'"]*settings|ipc(Main|Renderer)\b/
    )
    expect(channelAgentParticipationEnabled.length).toBe(0)
    expect(assertChannelAgentParticipationReviewed.length).toBe(0)
  })
})
