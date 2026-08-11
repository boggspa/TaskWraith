import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { contributionRulesForPreset } from './HumanContributionRules'
import { ChannelHumanPolicyStore } from './ChannelHumanPolicyStore'
import {
  PeopleToChannelMigrationAdmissionAuthority,
  isPeopleToChannelMigrationAdmissionAuthorityError
} from './PeopleToChannelMigrationAdmissionAuthority'
import type { PeopleToChannelReissuedAdmission } from './PeopleToChannelMigrationAdmissionReissue'
import { ChannelError, ChannelStore, hashChannelInviteToken } from './ChannelStore'

const roots: string[] = []

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'taskwraith-migrated-admission-'))
  roots.push(value)
  return value
}

function invitation(
  channelId: string,
  issued: {
    invite: { inviteId: string; roomId: string; createdAt: number; expiresAt: number }
    inviteToken: string
  },
  overrides: Partial<PeopleToChannelReissuedAdmission> = {}
): PeopleToChannelReissuedAdmission {
  return {
    sourceShareId: 'legacy_share',
    channelId,
    purpose: 'pending-collaborator',
    sourceCollaboratorId: 'legacy_alex',
    recipientLabel: 'Alex Legacy',
    policy: {
      sourceDigest: 'a'.repeat(64),
      rules: contributionRulesForPreset('comments'),
      requiresHostApproval: true,
      fullHistory: false
    },
    inviteId: issued.invite.inviteId,
    roomId: issued.invite.roomId,
    inviteToken: issued.inviteToken,
    createdAt: issued.invite.createdAt,
    expiresAt: issued.invite.expiresAt,
    ...overrides
  }
}

function fixture() {
  const directory = root()
  const store = new ChannelStore(join(directory, 'channels.json'))
  const { channel } = store.createChannel({
    chatId: 'chat-migrated',
    title: 'Migrated Channel',
    owner: { displayName: 'Host', identityPublicKey: 'host_identity' },
    now: 1_000
  })
  const issued = store.createInvite({ channelId: channel.channelId, now: 2_000 })
  const policies = new ChannelHumanPolicyStore(join(directory, 'human-policies.json'))
  return { directory, store, channel, issued, policies }
}

describe('PeopleToChannelMigrationAdmissionAuthority', () => {
  it('binds the frozen pending policy before confirmation without retaining its recipient label', () => {
    const built = fixture()
    const source = invitation(built.channel.channelId, built.issued)
    const authority = new PeopleToChannelMigrationAdmissionAuthority({
      migrationPlanId: 'f'.repeat(64),
      invitations: [source]
    })
    const admitted = built.store.beginMemberAdmission({
      channelId: built.channel.channelId,
      inviteId: built.issued.invite.inviteId,
      inviteToken: built.issued.inviteToken,
      roomId: built.issued.invite.roomId,
      displayName: 'Alex now',
      identityPublicKey: 'alex_identity',
      now: 2_100
    })

    expect(
      authority.bind({
        store: built.store,
        policies: built.policies,
        channelId: built.channel.channelId,
        inviteId: built.issued.invite.inviteId,
        memberId: admitted.member.memberId,
        roomId: admitted.invite.roomId,
        tokenHash: admitted.invite.tokenHash,
        expiresAt: admitted.invite.expiresAt
      })
    ).toBe(true)
    expect(built.policies.get(built.channel.channelId, admitted.member.memberId)).toMatchObject({
      migrationPlanId: 'f'.repeat(64),
      sourceShareId: 'legacy_share',
      sourceCollaboratorId: 'legacy_alex',
      requiresHostApproval: true
    })
    expect(JSON.stringify(built.policies.list())).not.toContain('Alex Legacy')
  })

  it('reconciles a crash after durable member binding before it serves the Channel again', () => {
    const built = fixture()
    const source = invitation(built.channel.channelId, built.issued)
    const admitted = built.store.beginMemberAdmission({
      channelId: built.channel.channelId,
      inviteId: built.issued.invite.inviteId,
      inviteToken: built.issued.inviteToken,
      roomId: built.issued.invite.roomId,
      displayName: 'Alex',
      identityPublicKey: 'alex_identity',
      now: 2_100
    })
    const authority = new PeopleToChannelMigrationAdmissionAuthority({
      migrationPlanId: 'f'.repeat(64),
      invitations: [source]
    })

    expect(authority.reconcile({ store: built.store, policies: built.policies })).toBe(1)
    const restartedPolicies = new ChannelHumanPolicyStore(
      join(built.directory, 'human-policies.json')
    )
    const restartedAuthority = new PeopleToChannelMigrationAdmissionAuthority({
      migrationPlanId: 'f'.repeat(64),
      invitations: [source]
    })
    expect(restartedAuthority.reconcile({ store: built.store, policies: restartedPolicies })).toBe(
      1
    )
    expect(restartedPolicies.get(built.channel.channelId, admitted.member.memberId)).toMatchObject({
      sourceCollaboratorId: 'legacy_alex'
    })
  })

  it('maps an open invite to a synthetic subject so a legacy allow-list cannot widen', () => {
    const built = fixture()
    const source = invitation(built.channel.channelId, built.issued, {
      purpose: 'open-invite',
      sourceCollaboratorId: undefined,
      recipientLabel: undefined,
      openInviteOrdinal: 1,
      policy: {
        sourceDigest: 'a'.repeat(64),
        rules: {
          ...contributionRulesForPreset('comments'),
          allowedCollaboratorIds: ['legacy_alex']
        },
        requiresHostApproval: false,
        fullHistory: false
      }
    })
    const authority = new PeopleToChannelMigrationAdmissionAuthority({
      migrationPlanId: 'f'.repeat(64),
      invitations: [source]
    })
    const admitted = built.store.beginMemberAdmission({
      channelId: built.channel.channelId,
      inviteId: built.issued.invite.inviteId,
      inviteToken: built.issued.inviteToken,
      roomId: built.issued.invite.roomId,
      displayName: 'New person',
      identityPublicKey: 'new_identity',
      now: 2_100
    })
    authority.bind({
      store: built.store,
      policies: built.policies,
      channelId: built.channel.channelId,
      inviteId: built.issued.invite.inviteId,
      memberId: admitted.member.memberId,
      roomId: admitted.invite.roomId,
      tokenHash: admitted.invite.tokenHash,
      expiresAt: admitted.invite.expiresAt
    })

    const policy = built.policies.get(built.channel.channelId, admitted.member.memberId)
    expect(policy?.sourceCollaboratorId).toMatch(/^migration_open_[a-f0-9]{32}$/)
    expect(
      built.policies.evaluate({
        channelId: built.channel.channelId,
        memberId: admitted.member.memberId,
        intent: 'comment',
        contentBytes: 4
      })
    ).toMatchObject({ outcome: 'deny', code: 'rule_denied' })
  })

  it('fails closed before policy writes when the durable invitation diverges', () => {
    const built = fixture()
    const source = invitation(built.channel.channelId, {
      ...built.issued,
      inviteToken: 'x'.repeat(32)
    })
    const authority = new PeopleToChannelMigrationAdmissionAuthority({
      migrationPlanId: 'f'.repeat(64),
      invitations: [source]
    })

    let failure: unknown
    try {
      authority.reconcile({ store: built.store, policies: built.policies })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(ChannelError)
    expect((failure as ChannelError).code).toBe('recovery_blocked')
    expect(isPeopleToChannelMigrationAdmissionAuthorityError(failure)).toBe(false)
    expect(built.policies.list()).toEqual([])
    expect(hashChannelInviteToken(built.issued.inviteToken)).not.toBe(
      hashChannelInviteToken('x'.repeat(32))
    )
  })
})
