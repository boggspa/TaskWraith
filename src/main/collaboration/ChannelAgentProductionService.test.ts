import { describe, expect, it, vi } from 'vitest'

import {
  CHANNEL_AGENT_REVIEW_ID,
  CHANNEL_AGENT_REVIEW_REQUIRED_CODE
} from '../../shared/collaboration/ChannelAgentReviewGate'
import {
  ChannelAgentProductionService,
  type ChannelAgentProductionServiceOptions
} from './ChannelAgentProductionService'
import type { ChannelAppendResult } from './ChannelMessageLog'
import type { ChannelMember } from './ChannelStore'

const CHANNEL_ID = 'channel-agent-production-service-proof'
const CONTENT = 'Please ask <@agent-build> to inspect this secret contribution.'

function members(): ChannelMember[] {
  return [
    {
      channelId: CHANNEL_ID,
      memberId: 'member-owner',
      kind: 'human',
      displayName: 'Host',
      identityPublicKey: 'owner-public-key',
      status: 'active',
      joinedAt: 1
    },
    {
      channelId: CHANNEL_ID,
      memberId: 'agent-build',
      kind: 'agent',
      displayName: 'Build Agent',
      identityPublicKey: Buffer.alloc(32, 7).toString('base64'),
      status: 'active',
      agentSeatId: 'pooled-agent-build',
      keyGeneration: 1,
      joinedAt: 2
    }
  ]
}

function appendResult(
  overrides: Partial<Extract<ChannelAppendResult['record'], { kind: 'human.text' }>> = {}
): ChannelAppendResult {
  return {
    deduplicated: false,
    record: {
      channelId: CHANNEL_ID,
      sequence: 1,
      messageId: 'message-production-service-proof',
      authorMemberId: 'member-owner',
      clientMessageId: 'client-production-service-proof',
      kind: 'human.text',
      content: CONTENT,
      acceptedAt: 1_000,
      contentHash: 'a'.repeat(64),
      ...overrides
    }
  }
}

function harness() {
  const execution = {
    start: vi.fn(),
    dispatchPlan: vi.fn<ChannelAgentProductionServiceOptions['execution']['dispatchPlan']>(),
    dispose: vi.fn()
  }
  const recovery = {
    recoverChannel: vi.fn<ChannelAgentProductionServiceOptions['recovery']['recoverChannel']>()
  }
  const getMembers = vi.fn(() => members())
  const resolveDispatchPlan = vi.fn<ChannelAgentProductionServiceOptions['resolveDispatchPlan']>()
  const audit = vi.fn<ChannelAgentProductionServiceOptions['audit']['append']>()
  const logger = vi.fn()
  const service = new ChannelAgentProductionService({
    execution,
    recovery,
    getMembers,
    resolveDispatchPlan,
    audit: { append: audit },
    logger
  })
  return {
    service,
    execution,
    recovery,
    getMembers,
    resolveDispatchPlan,
    audit,
    logger
  }
}

describe('ChannelAgentProductionService review gate', () => {
  it('touches no execution, recovery, plan, or authority-facing port while source-disabled', async () => {
    const h = harness()
    expect(h.service.start([CHANNEL_ID])).toEqual({
      state: 'review_blocked',
      pendingOperations: 0,
      queuedChannels: 0,
      retainedRecoveries: 0
    })
    expect(h.execution.start).not.toHaveBeenCalled()
    expect(h.recovery.recoverChannel).not.toHaveBeenCalled()

    await expect(h.service.handleDurableAppend(appendResult())).resolves.toEqual({
      kind: 'review_required',
      targetCount: 1,
      dispatched: 0,
      posted: 0,
      declined: 0,
      retained: 0
    })
    expect(h.getMembers).toHaveBeenCalledWith(CHANNEL_ID)
    expect(h.resolveDispatchPlan).not.toHaveBeenCalled()
    expect(h.execution.dispatchPlan).not.toHaveBeenCalled()
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'agent.dispatch.blocked',
        channelId: CHANNEL_ID,
        memberId: 'agent-build',
        code: CHANNEL_AGENT_REVIEW_REQUIRED_CODE,
        contentHash: 'a'.repeat(64),
        detail: CHANNEL_AGENT_REVIEW_ID,
        at: 1_000
      })
    )
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain(CONTENT)

    await h.service.stop()
    expect(h.execution.dispose).not.toHaveBeenCalled()
    expect(h.service.status().state).toBe('stopped')
  })

  it('ignores deduplicated and agent-authored records before membership access', async () => {
    const h = harness()
    const duplicate = appendResult()
    duplicate.deduplicated = true
    await expect(h.service.handleDurableAppend(duplicate)).resolves.toMatchObject({
      kind: 'ignored'
    })
    await expect(
      h.service.handleDurableAppend({
        deduplicated: false,
        record: { ...appendResult().record, kind: 'agent.text', agentProof: {} as never }
      })
    ).resolves.toMatchObject({ kind: 'ignored' })
    expect(h.getMembers).not.toHaveBeenCalled()
    expect(h.audit).not.toHaveBeenCalled()
  })

  it('fails constructor validation closed with static errors', () => {
    expect(
      () =>
        new ChannelAgentProductionService({
          execution: {} as never,
          recovery: {} as never,
          getMembers: vi.fn(),
          resolveDispatchPlan: vi.fn(),
          audit: { append: vi.fn() }
        })
    ).toThrowError(expect.objectContaining({ code: 'invalid_options' }))
  })
})
