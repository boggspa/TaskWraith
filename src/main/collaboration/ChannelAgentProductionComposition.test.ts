import { describe, expect, it, vi } from 'vitest'

import {
  CHANNEL_AGENT_REVIEW_ID,
  CHANNEL_AGENT_REVIEW_REQUIRED_CODE
} from '../../shared/collaboration/ChannelAgentReviewGate'
import {
  createChannelAgentProductionComposition,
  type ChannelAgentProductionCompositionOptions
} from './ChannelAgentProductionComposition'
import type { HumanChannelMessage } from './ChannelMessageLog'
import type { ChannelMember } from './ChannelStore'

const CHANNEL_ID = 'channel-production-composition-gate-proof'
const CONTENT = 'Ask <@agent-build> to inspect this durable contribution.'

function record(): HumanChannelMessage {
  return {
    channelId: CHANNEL_ID,
    sequence: 1,
    messageId: 'message-production-composition-gate-proof',
    authorMemberId: 'member-owner',
    clientMessageId: 'client-production-composition-gate-proof',
    kind: 'human.text',
    content: CONTENT,
    acceptedAt: 1_000,
    contentHash: 'a'.repeat(64)
  }
}

function members(): ChannelMember[] {
  return [
    {
      channelId: CHANNEL_ID,
      memberId: 'member-owner',
      kind: 'human',
      displayName: 'Host',
      identityPublicKey: Buffer.alloc(32, 1).toString('base64'),
      status: 'active',
      joinedAt: 1
    },
    {
      channelId: CHANNEL_ID,
      memberId: 'agent-build',
      kind: 'agent',
      displayName: 'Build Agent',
      identityPublicKey: Buffer.alloc(32, 2).toString('base64'),
      status: 'active',
      agentSeatId: 'pooled-agent-build',
      keyGeneration: 1,
      joinedAt: 2
    }
  ]
}

function harness() {
  const calls = {
    reserve: vi.fn(),
    listChannel: vi.fn(),
    snapshot: vi.fn(),
    beginConsumption: vi.fn(),
    commitConsumption: vi.fn(),
    beginLaunch: vi.fn(),
    confirmLaunch: vi.fn(),
    recordTerminal: vi.fn(),
    recordSignedPost: vi.fn(),
    recordPosted: vi.fn(),
    abandon: vi.fn(),
    complete: vi.fn(),
    consumeDispatch: vi.fn(),
    authoritySnapshot: vi.fn(),
    verifyPostAuthority: vi.fn(),
    loadIdentity: vi.fn(),
    getChannel: vi.fn(),
    listMembers: vi.fn(() => members()),
    getMessageById: vi.fn(),
    appendSignedAgentPost: vi.fn(),
    getChat: vi.fn(),
    resolveWorkspacePrincipal: vi.fn(),
    getSettings: vi.fn(),
    providerAllowed: vi.fn(),
    composeMainOwnedChannelAgentRun: vi.fn(),
    dispatch: vi.fn(),
    audit: vi.fn(),
    subscribeRunEvents: vi.fn(),
    subscribeRunSessions: vi.fn(),
    claimRunAudience: vi.fn(),
    reconcileRun: vi.fn(),
    logger: vi.fn()
  }
  const service = createChannelAgentProductionComposition({
    journal: {
      reserve: calls.reserve,
      listChannel: calls.listChannel,
      snapshot: calls.snapshot,
      beginConsumption: calls.beginConsumption,
      commitConsumption: calls.commitConsumption,
      beginLaunch: calls.beginLaunch,
      confirmLaunch: calls.confirmLaunch,
      recordTerminal: calls.recordTerminal,
      recordSignedPost: calls.recordSignedPost,
      recordPosted: calls.recordPosted,
      abandon: calls.abandon,
      complete: calls.complete
    } as never,
    authority: {
      consumeDispatch: calls.consumeDispatch,
      snapshot: calls.authoritySnapshot,
      verifyPostAuthority: calls.verifyPostAuthority
    } as never,
    identities: { load: calls.loadIdentity } as never,
    channels: {
      getChannel: calls.getChannel,
      listMembers: calls.listMembers
    } as never,
    messages: { getMessageById: calls.getMessageById } as never,
    runtime: { appendSignedAgentPost: calls.appendSignedAgentPost } as never,
    getChat: calls.getChat,
    resolveWorkspacePrincipal: calls.resolveWorkspacePrincipal,
    getSettings: calls.getSettings,
    providerAllowed: calls.providerAllowed,
    composeMainOwnedChannelAgentRun: calls.composeMainOwnedChannelAgentRun,
    dispatch: calls.dispatch,
    audit: { append: calls.audit },
    subscribeRunEvents: calls.subscribeRunEvents,
    subscribeRunSessions: calls.subscribeRunSessions,
    claimRunAudience: calls.claimRunAudience,
    reconcileRun: calls.reconcileRun,
    logger: calls.logger
  })
  return { service, calls }
}

describe('createChannelAgentProductionComposition review gate', () => {
  it('keeps every execution, recovery, authority, identity, and runtime port inert', async () => {
    const h = harness()
    expect(h.service.start([CHANNEL_ID])).toMatchObject({ state: 'review_blocked' })
    await expect(
      h.service.handleDurableAppend({ record: record(), deduplicated: false })
    ).resolves.toEqual({
      kind: 'review_required',
      targetCount: 1,
      dispatched: 0,
      posted: 0,
      declined: 0,
      retained: 0
    })

    expect(h.calls.listMembers).toHaveBeenCalledOnce()
    expect(h.calls.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'agent.dispatch.blocked',
        channelId: CHANNEL_ID,
        memberId: 'agent-build',
        code: CHANNEL_AGENT_REVIEW_REQUIRED_CODE,
        contentHash: 'a'.repeat(64),
        detail: CHANNEL_AGENT_REVIEW_ID
      })
    )
    for (const port of [
      h.calls.reserve,
      h.calls.listChannel,
      h.calls.authoritySnapshot,
      h.calls.verifyPostAuthority,
      h.calls.consumeDispatch,
      h.calls.loadIdentity,
      h.calls.getChannel,
      h.calls.getMessageById,
      h.calls.appendSignedAgentPost,
      h.calls.getChat,
      h.calls.resolveWorkspacePrincipal,
      h.calls.getSettings,
      h.calls.providerAllowed,
      h.calls.composeMainOwnedChannelAgentRun,
      h.calls.dispatch,
      h.calls.subscribeRunEvents,
      h.calls.subscribeRunSessions,
      h.calls.claimRunAudience,
      h.calls.reconcileRun
    ]) {
      expect(port).not.toHaveBeenCalled()
    }
    expect(JSON.stringify(h.calls.audit.mock.calls)).not.toContain(CONTENT)
    await h.service.stop()
  })

  it('rejects a partial canonical-source port before returning a service', () => {
    expect(() =>
      createChannelAgentProductionComposition({
        channels: {} as never
      } as unknown as ChannelAgentProductionCompositionOptions)
    ).toThrowError(expect.objectContaining({ code: 'invalid_options' }))
  })
})
