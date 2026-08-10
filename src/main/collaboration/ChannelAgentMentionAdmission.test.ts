import { describe, expect, it } from 'vitest'
import { CHANNEL_AGENT_REVIEW_REQUIRED_CODE } from '../../shared/collaboration/ChannelAgentReviewGate'
import type { ChannelMessage } from './ChannelMessageLog'
import {
  admitAcceptedChannelAgentMentions,
  resolveChannelAgentMentions
} from './ChannelAgentMentionAdmission'
import type { ChannelMember } from './ChannelStore'

const channelId = 'channel-mention-proof'

function human(memberId = 'human-owner', status: 'active' | 'revoked' = 'active'): ChannelMember {
  return {
    memberId,
    channelId,
    kind: 'human',
    displayName: memberId,
    identityPublicKey: 'human-public-key',
    status,
    joinedAt: 1,
    ...(status === 'revoked' ? { revokedAt: 2 } : {})
  }
}

function agent(
  memberId: string,
  displayName: string,
  status: 'active' | 'revoked' = 'active'
): ChannelMember {
  return {
    memberId,
    channelId,
    kind: 'agent',
    displayName,
    identityPublicKey: Buffer.alloc(32, memberId.charCodeAt(0)).toString('base64'),
    status,
    agentSeatId: `pooled-${memberId}`,
    keyGeneration: 1,
    joinedAt: 1,
    ...(status === 'revoked' ? { revokedAt: 2 } : {})
  }
}

function record(content: string): Extract<ChannelMessage, { kind: 'human.text' }> {
  return {
    channelId,
    sequence: 1,
    messageId: 'message-1',
    authorMemberId: 'human-owner',
    clientMessageId: 'client-1',
    kind: 'human.text',
    content,
    acceptedAt: 10,
    contentHash: 'a'.repeat(64)
  }
}

describe('ChannelAgentMentionAdmission', () => {
  it('prefers exact member-id tokens and deduplicates a matching readable alias', () => {
    const members = [human(), agent('agent-build', 'Build Agent')]

    expect(
      resolveChannelAgentMentions(
        channelId,
        'Please ask <@agent-build>, then remind @Build-Agent.',
        members
      )
    ).toEqual({
      targets: [
        {
          memberId: 'agent-build',
          agentSeatId: 'pooled-agent-build',
          keyGeneration: 1,
          displayName: 'Build Agent',
          source: 'structured_member_id'
        }
      ],
      ambiguities: []
    })
  })

  it('resolves case-insensitive multi-word display names only when unique', () => {
    const members = [human(), agent('agent-review', 'Security Review')]

    expect(
      resolveChannelAgentMentions(channelId, 'Could @security review inspect this?', members)
        .targets
    ).toEqual([
      expect.objectContaining({
        memberId: 'agent-review',
        source: 'unique_alias'
      })
    ])
  })

  it('reports duplicate display aliases without choosing a target', () => {
    const members = [
      human(),
      agent('agent-build-a', 'Build Agent'),
      agent('agent-build-b', 'Build Agent')
    ]

    expect(resolveChannelAgentMentions(channelId, '@Build Agent take this.', members)).toEqual({
      targets: [],
      ambiguities: [
        {
          candidateMemberIds: ['agent-build-a', 'agent-build-b']
        }
      ]
    })
    expect(admitAcceptedChannelAgentMentions({ record: record('@Build Agent'), members })).toEqual({
      kind: 'rejected',
      reason: 'ambiguous_agent_mention',
      ambiguities: [{ candidateMemberIds: ['agent-build-a', 'agent-build-b'] }]
    })
  })

  it('fails a readable agent alias closed when an active human shares it', () => {
    const members = [human(), human('human-build'), agent('agent-build', 'Build Agent')]
    members[1] = { ...members[1], displayName: 'Build Agent' }

    expect(resolveChannelAgentMentions(channelId, '@Build Agent take this.', members)).toEqual({
      targets: [],
      ambiguities: [
        {
          candidateMemberIds: ['agent-build', 'human-build']
        }
      ]
    })
  })

  it('ignores email addresses, unknown humans, and revoked agents', () => {
    const members = [human(), human('alex'), agent('agent-retired', 'Retired Agent', 'revoked')]

    expect(
      resolveChannelAgentMentions(
        channelId,
        'mail alex@example.com, ask @Alex, not @Retired Agent or <@agent-retired>',
        members
      )
    ).toEqual({ targets: [], ambiguities: [] })
  })

  it('rejects a record whose claimed author is not an active human member', () => {
    const members = [human('human-owner', 'revoked'), agent('agent-build', 'Build Agent')]

    expect(admitAcceptedChannelAgentMentions({ record: record('@Build Agent'), members })).toEqual({
      kind: 'rejected',
      reason: 'author_not_active_human',
      ambiguities: []
    })
    expect(
      admitAcceptedChannelAgentMentions({
        record: {
          ...record('@Build Agent'),
          kind: 'agent.text',
          authorMemberId: 'agent-build',
          agentProof: {} as never
        },
        members
      })
    ).toEqual({ kind: 'ignored', reason: 'not_human_text', ambiguities: [] })
  })

  it('stops resolved durable human mentions at the immutable review gate', () => {
    const members = [human(), agent('agent-build', 'Build Agent')]
    const admission = admitAcceptedChannelAgentMentions({
      record: record('@Build Agent please inspect this.'),
      members
    })

    expect(admission).toMatchObject({
      kind: 'review_required',
      code: CHANNEL_AGENT_REVIEW_REQUIRED_CODE,
      targets: [{ memberId: 'agent-build' }]
    })
    expect(JSON.stringify(admission)).not.toContain('please inspect this')
  })
})
