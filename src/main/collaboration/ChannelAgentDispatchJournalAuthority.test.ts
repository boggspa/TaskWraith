import { describe, expect, it, vi } from 'vitest'

import {
  CHANNEL_AGENT_MAX_POST_BYTES,
  CHANNEL_AGENT_PROTOCOL_VERSION,
  hashChannelAgentContent,
  signChannelAgentDelegation,
  signChannelAgentDispatchGrant
} from '../../shared/collaboration/ChannelAgentProtocol'
import { exportRawEd25519PublicKey, generateIdentityKeyPair } from '../../shared/e2ee/keys'
import {
  CHANNEL_AGENT_AUTHORITY_STATE_VERSION,
  type ChannelAgentAuthoritySnapshot,
  type ChannelAgentDispatchConsumption
} from './ChannelAgentAuthorityState'
import type { ChannelAgentDispatchPlan } from './ChannelAgentDispatchAuthority'
import {
  inspectChannelAgentDispatchConsumption,
  validateChannelAgentDispatchJournalSnapshot
} from './ChannelAgentDispatchJournalAuthority'
import {
  ChannelAgentDispatchJournalState,
  type ChannelAgentDispatchJournalSnapshot
} from './ChannelAgentDispatchJournalState'
import type { AgentChannelMember, Channel, ChannelMember } from './ChannelStore'

const CHANNEL_ID = 'channel-journal-authority-proof'
const CHAT_ID = 'chat-journal-authority-proof'
const OWNER_ID = 'member-owner'
const HUMAN_ID = 'member-human'
const AGENT_ID = 'member-agent'
const SEAT_ID = 'pooled-agent-journal-authority-proof'
const GRANT_ID = 'grant-journal-authority-proof'
const DELEGATION_ID = 'delegation-journal-authority-proof'
const TRIGGER_ID = 'trigger-journal-authority-proof'
const WORKSPACE_HASH = 'a'.repeat(64)
const POSTURE_HASH = 'b'.repeat(64)
const NOW = 1_000

interface Fixture {
  readonly channel: Channel
  readonly members: readonly ChannelMember[]
  readonly plan: ChannelAgentDispatchPlan
  readonly authorityBefore: ChannelAgentAuthoritySnapshot
  readonly authorityAfter: ChannelAgentAuthoritySnapshot
  readonly consumption: ChannelAgentDispatchConsumption
}

function fixture(): Fixture {
  const ownerKeys = generateIdentityKeyPair()
  const agentKeys = generateIdentityKeyPair()
  const ownerPublicKey = exportRawEd25519PublicKey(ownerKeys.publicKey).toString('base64')
  const agentPublicKey = exportRawEd25519PublicKey(agentKeys.publicKey).toString('base64')
  const delegation = signChannelAgentDelegation(ownerKeys.privateKey, {
    schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
    delegationId: DELEGATION_ID,
    channelId: CHANNEL_ID,
    ownerMemberId: OWNER_ID,
    agentMemberId: AGENT_ID,
    agentSeatId: SEAT_ID,
    agentPublicKeyB64: agentPublicKey,
    keyGeneration: 1,
    scopes: ['channel.dispatch', 'channel.post'],
    issuedAt: 100,
    notBefore: 100,
    expiresAt: 10_000,
    maxPostBytes: CHANNEL_AGENT_MAX_POST_BYTES
  })
  const grant = signChannelAgentDispatchGrant(ownerKeys.privateKey, {
    schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
    grantId: GRANT_ID,
    channelId: CHANNEL_ID,
    ownerMemberId: OWNER_ID,
    agentMemberId: AGENT_ID,
    agentSeatId: SEAT_ID,
    agentPublicKeyB64: agentPublicKey,
    keyGeneration: 1,
    delegationId: DELEGATION_ID,
    trigger: 'mention',
    allowedMentionerMemberIds: [HUMAN_ID],
    workspaceIdentityHash: WORKSPACE_HASH,
    permissionPostureHash: POSTURE_HASH,
    issuedAt: 100,
    notBefore: 100,
    expiresAt: 10_000,
    maxDispatches: 2
  })
  const agent: AgentChannelMember = {
    channelId: CHANNEL_ID,
    memberId: AGENT_ID,
    kind: 'agent',
    displayName: 'Journal Agent',
    identityPublicKey: agentPublicKey,
    status: 'active',
    agentSeatId: SEAT_ID,
    keyGeneration: 1,
    joinedAt: 20
  }
  const members: ChannelMember[] = [
    {
      channelId: CHANNEL_ID,
      memberId: OWNER_ID,
      kind: 'human',
      displayName: 'Host',
      identityPublicKey: ownerPublicKey,
      status: 'active',
      joinedAt: 10
    },
    {
      channelId: CHANNEL_ID,
      memberId: HUMAN_ID,
      kind: 'human',
      displayName: 'Reviewer',
      identityPublicKey: Buffer.alloc(32, 7).toString('base64'),
      status: 'active',
      joinedAt: 15
    },
    agent
  ]
  const plan = {
    channelId: CHANNEL_ID,
    chatId: CHAT_ID,
    ownerMemberId: OWNER_ID,
    triggerMessageId: TRIGGER_ID,
    triggerContentHash: hashChannelAgentContent('Inspect the journal binding.'),
    mentionerMemberId: HUMAN_ID,
    target: {
      memberId: AGENT_ID,
      agentSeatId: SEAT_ID,
      keyGeneration: 1,
      displayName: 'Journal Agent',
      source: 'structured_member_id'
    },
    member: agent,
    delegation,
    dispatchGrant: grant,
    workspaceIdentityHash: WORKSPACE_HASH,
    permissionPostureHash: POSTURE_HASH,
    authorityRevision: 2,
    expectedDispatchOrdinal: 1,
    consumeInput: {
      grantId: GRANT_ID,
      triggerMessageId: TRIGGER_ID,
      mentionerMemberId: HUMAN_ID,
      workspaceIdentityHash: WORKSPACE_HASH,
      permissionPostureHash: POSTURE_HASH
    }
  } as unknown as ChannelAgentDispatchPlan
  const consumption: ChannelAgentDispatchConsumption = {
    schemaVersion: CHANNEL_AGENT_AUTHORITY_STATE_VERSION,
    recordedRevision: 3,
    channelId: CHANNEL_ID,
    grantId: GRANT_ID,
    triggerMessageId: TRIGGER_ID,
    mentionerMemberId: HUMAN_ID,
    workspaceIdentityHash: WORKSPACE_HASH,
    permissionPostureHash: POSTURE_HASH,
    dispatchOrdinal: 1,
    consumedAt: NOW + 1
  }
  const authorityBefore: ChannelAgentAuthoritySnapshot = {
    schemaVersion: CHANNEL_AGENT_AUTHORITY_STATE_VERSION,
    channelId: CHANNEL_ID,
    ownerMemberId: OWNER_ID,
    revision: 2,
    delegations: [{ recordedRevision: 1, signedDelegation: delegation }],
    dispatchGrants: [{ recordedRevision: 2, signedDispatchGrant: grant }],
    revocations: [],
    consumptions: []
  }
  return {
    channel: {
      channelId: CHANNEL_ID,
      chatId: CHAT_ID,
      ownerMemberId: OWNER_ID,
      status: 'active',
      createdAt: 10,
      updatedAt: 20,
      membershipRevision: 3,
      messageCount: 1,
      display: {
        title: 'Journal authority proof',
        status: 'active',
        memberCount: 3,
        messageCount: 1
      }
    },
    members,
    plan,
    authorityBefore,
    authorityAfter: {
      ...authorityBefore,
      revision: 3,
      consumptions: [consumption]
    },
    consumption
  }
}

function snapshots(value: Fixture) {
  const reserved = ChannelAgentDispatchJournalState.reserve(value.plan, NOW)
  const reservedSnapshot = reserved.snapshot()
  reserved.beginConsumption(value.plan, NOW + 1)
  const consumingSnapshot = reserved.snapshot()
  reserved.commitConsumption(value.consumption)
  return {
    reserved: reservedSnapshot,
    consuming: consumingSnapshot,
    consumed: reserved.snapshot()
  }
}

function harness(value: Fixture) {
  const getChannel = vi.fn((): Channel | null => value.channel)
  const listMembers = vi.fn((): readonly ChannelMember[] => value.members)
  const authoritySnapshot = vi.fn((): ChannelAgentAuthoritySnapshot | null => value.authorityBefore)
  const channels = { getChannel, listMembers }
  const authority = { snapshot: authoritySnapshot }
  const validate = (snapshot: ChannelAgentDispatchJournalSnapshot) =>
    validateChannelAgentDispatchJournalSnapshot({ channels, authority } as never, snapshot)
  return { getChannel, listMembers, authoritySnapshot, channels, authority, validate }
}

describe('Channel agent dispatch journal authority', () => {
  it('accepts reservation, atomic-consumption window, and committed consumption exactly', () => {
    const value = fixture()
    const state = snapshots(value)
    const h = harness(value)
    expect(h.validate(state.reserved)).toBe('valid')
    expect(h.validate(state.consuming)).toBe('valid')
    expect(inspectChannelAgentDispatchConsumption(h.authority as never, state.consuming)).toEqual({
      kind: 'absent'
    })

    h.authoritySnapshot.mockReturnValue(value.authorityAfter)
    expect(h.validate(state.consuming)).toBe('valid')
    expect(inspectChannelAgentDispatchConsumption(h.authority as never, state.consuming)).toEqual({
      kind: 'found',
      consumption: value.consumption
    })
    expect(h.validate(state.consumed)).toBe('valid')
  })

  it('preserves evidence when a canonical metadata or authority root is unavailable', () => {
    const value = fixture()
    const state = snapshots(value)
    const h = harness(value)
    h.getChannel.mockReturnValue(null)
    expect(h.validate(state.reserved)).toBe('unavailable')

    h.getChannel.mockReturnValue(value.channel)
    h.listMembers.mockReturnValue(value.members.filter((member) => member.memberId !== AGENT_ID))
    expect(h.validate(state.reserved)).toBe('unavailable')

    h.listMembers.mockReturnValue(value.members)
    h.authoritySnapshot.mockReturnValue(null)
    expect(h.validate(state.reserved)).toBe('unavailable')
    h.authoritySnapshot.mockImplementation(() => {
      throw new Error('authority path /Users/alice/private')
    })
    expect(h.validate(state.reserved)).toBe('unavailable')
    expect(inspectChannelAgentDispatchConsumption(h.authority as never, state.consuming)).toEqual({
      kind: 'unavailable'
    })
  })

  it('rejects present metadata, delegation, grant, or consumption rebinding', () => {
    const value = fixture()
    const state = snapshots(value)
    const h = harness(value)
    h.getChannel.mockReturnValue({ ...value.channel, chatId: 'chat-rebound' })
    expect(h.validate(state.reserved)).toBe('invalid')

    h.getChannel.mockReturnValue(value.channel)
    h.listMembers.mockReturnValue(
      value.members.map((member) =>
        member.memberId === AGENT_ID ? { ...member, agentSeatId: 'pooled-agent-rebound' } : member
      ) as ChannelMember[]
    )
    expect(h.validate(state.reserved)).toBe('invalid')

    h.listMembers.mockReturnValue(value.members)
    h.authoritySnapshot.mockReturnValue({
      ...value.authorityBefore,
      delegations: []
    })
    expect(h.validate(state.reserved)).toBe('invalid')
    h.authoritySnapshot.mockReturnValue({
      ...value.authorityBefore,
      dispatchGrants: []
    })
    expect(h.validate(state.reserved)).toBe('invalid')

    h.authoritySnapshot.mockReturnValue({
      ...value.authorityAfter,
      consumptions: [{ ...value.consumption, workspaceIdentityHash: 'e'.repeat(64) }]
    })
    expect(h.validate(state.consuming)).toBe('invalid')
    expect(inspectChannelAgentDispatchConsumption(h.authority as never, state.consuming)).toEqual({
      kind: 'unavailable'
    })
  })

  it('does not reinterpret consumed authority as a pristine reservation', () => {
    const value = fixture()
    const state = snapshots(value)
    const h = harness(value)
    h.authoritySnapshot.mockReturnValue(value.authorityAfter)
    expect(h.validate(state.reserved)).toBe('unavailable')
    expect(
      h.validate({
        ...state.reserved,
        binding: { ...state.reserved.binding, delegationId: 'delegation-rebound' }
      })
    ).toBe('invalid')
  })
})
