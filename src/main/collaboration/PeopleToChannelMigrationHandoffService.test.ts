import { describe, expect, it, vi } from 'vitest'

import { contributionRulesForPreset } from './HumanContributionRules'
import type { PeopleToChannelReissuedAdmission } from './PeopleToChannelMigrationAdmissionReissue'
import {
  PEOPLE_TO_CHANNEL_HANDOFF_VERSION,
  PeopleToChannelMigrationHandoffError,
  PeopleToChannelMigrationHandoffService,
  type PeopleToChannelMigrationHandoffInput
} from './PeopleToChannelMigrationHandoffService'
import type { ChannelProductionInviteResult } from './ChannelProductionService'
import { PEOPLE_TO_CHANNEL_PRODUCTION_RUNNER_VERSION } from './PeopleToChannelMigrationProductionRunner'

function admission(
  overrides: Partial<PeopleToChannelReissuedAdmission> = {}
): PeopleToChannelReissuedAdmission {
  return {
    sourceShareId: 'private_share',
    channelId: 'channel-a',
    purpose: 'pending-collaborator',
    sourceCollaboratorId: 'collaborator-a',
    memberPresentation: { seatOrder: 3, colorIndex: 5, seatDisabled: true },
    policy: {
      sourceDigest: 'a'.repeat(64),
      rules: contributionRulesForPreset('comments'),
      requiresHostApproval: false,
      fullHistory: false
    },
    inviteId: 'invite-a',
    roomId: 'room-a',
    inviteToken: 'private-token-a',
    createdAt: 1_000,
    expiresAt: 10_000,
    ...overrides
  }
}

function projected(
  source: PeopleToChannelReissuedAdmission,
  overrides: Partial<ChannelProductionInviteResult> = {}
): ChannelProductionInviteResult {
  return {
    channelId: source.channelId,
    inviteId: source.inviteId,
    inviteToken: source.inviteToken,
    roomId: source.roomId,
    expiresAt: source.expiresAt,
    relayUrls: ['wss://relay.example'],
    hostRoomOpened: true,
    ...overrides
  }
}

function migration(
  overrides: Partial<PeopleToChannelMigrationHandoffInput> = {}
): PeopleToChannelMigrationHandoffInput {
  return {
    schemaVersion: PEOPLE_TO_CHANNEL_PRODUCTION_RUNNER_VERSION,
    planId: 'f'.repeat(64),
    phase: 'cutover_applied',
    routes: [
      { chatId: 'chat-a', channelId: 'channel-a', origin: 'general-and-people' },
      { chatId: 'chat-b', channelId: 'channel-b', origin: 'general' }
    ],
    invitations: [],
    ...overrides
  }
}

describe('PeopleToChannelMigrationHandoffService', () => {
  it('projects only active chat-scoped credentials and strips private migration authority', () => {
    const ready = admission()
    const retired = admission({
      purpose: 'open-invite',
      sourceCollaboratorId: undefined,
      openInviteOrdinal: 0,
      inviteId: 'invite-retired',
      roomId: 'room-retired',
      inviteToken: 'private-token-retired'
    })
    const unavailable = admission({
      sourceShareId: 'private_share_b',
      channelId: 'channel-b',
      purpose: 'open-invite',
      sourceCollaboratorId: undefined,
      openInviteOrdinal: 0,
      inviteId: 'invite-b',
      roomId: 'room-b',
      inviteToken: 'private-token-b',
      memberPresentation: undefined
    })
    const describeExistingInvite = vi.fn((credential: { inviteId: string }) => {
      if (credential.inviteId === retired.inviteId) return null
      if (credential.inviteId === unavailable.inviteId) {
        return projected(unavailable, { relayUrls: [], hostRoomOpened: false })
      }
      return projected(ready)
    })
    const service = new PeopleToChannelMigrationHandoffService({
      migration: migration({ invitations: [ready, retired, unavailable] }),
      channels: { describeExistingInvite }
    })

    const chatA = service.snapshot({ chatId: 'chat-a' })
    expect(chatA).toMatchObject({
      schemaVersion: PEOPLE_TO_CHANNEL_HANDOFF_VERSION,
      planId: 'f'.repeat(64),
      phase: 'cutover_applied',
      routes: [{ chatId: 'chat-a', channelId: 'channel-a' }],
      invitations: [
        {
          channelId: 'channel-a',
          chatId: 'chat-a',
          purpose: 'pending-collaborator',
          sourceCollaboratorId: 'collaborator-a',
          status: 'ready',
          invite: { inviteToken: 'private-token-a', relayUrls: ['wss://relay.example'] }
        }
      ],
      retiredInvitationCount: 1,
      relayUnavailableInvitationCount: 0
    })
    const chatASerialized = JSON.stringify(chatA)
    expect(chatASerialized).not.toMatch(
      /private_share|private-token-retired|memberPresentation|seatDisabled|sourceDigest|rules|requiresHostApproval|fullHistory/
    )

    const chatB = service.snapshot({ chatId: 'chat-b' })
    expect(chatB).toMatchObject({
      invitations: [
        {
          channelId: 'channel-b',
          status: 'relay_unavailable',
          invite: null
        }
      ],
      retiredInvitationCount: 0,
      relayUnavailableInvitationCount: 1
    })
    expect(JSON.stringify(chatB)).not.toContain('private-token-b')
    expect(describeExistingInvite).toHaveBeenCalledTimes(3)
  })

  it('fails closed when live projection changes a frozen invite credential', () => {
    const source = admission()
    const service = new PeopleToChannelMigrationHandoffService({
      migration: migration({ invitations: [source] }),
      channels: {
        describeExistingInvite: () =>
          projected(source, { inviteToken: 'different-authority-token' })
      }
    })

    expect(() => service.snapshot()).toThrow(PeopleToChannelMigrationHandoffError)
    expect(() => service.snapshot()).toThrow(/changed its invite authority/)
  })

  it('rejects duplicate routes, unrouted invitations, and malformed purpose authority', () => {
    expect(
      () =>
        new PeopleToChannelMigrationHandoffService({
          migration: migration({
            routes: [
              { chatId: 'chat-a', channelId: 'channel-a', origin: 'general' },
              { chatId: 'chat-a', channelId: 'channel-b', origin: 'people' }
            ]
          }),
          channels: { describeExistingInvite: () => null }
        })
    ).toThrow(/route is duplicated/)

    expect(
      () =>
        new PeopleToChannelMigrationHandoffService({
          migration: migration({ invitations: [admission({ channelId: 'channel-missing' })] }),
          channels: { describeExistingInvite: () => null }
        })
    ).toThrow(/no unique cutover route/)

    expect(
      () =>
        new PeopleToChannelMigrationHandoffService({
          migration: migration({
            invitations: [admission({ purpose: 'open-invite', openInviteOrdinal: undefined })]
          }),
          channels: { describeExistingInvite: () => null }
        })
    ).toThrow(/invitation is invalid/)
  })

  it('returns a content-free empty handoff when no admissions were reissued', () => {
    const service = new PeopleToChannelMigrationHandoffService({
      migration: migration(),
      channels: { describeExistingInvite: () => null }
    })
    expect(service.snapshot({ chatId: 'chat-a' })).toEqual({
      schemaVersion: PEOPLE_TO_CHANNEL_HANDOFF_VERSION,
      planId: 'f'.repeat(64),
      phase: 'cutover_applied',
      routes: [{ chatId: 'chat-a', channelId: 'channel-a', origin: 'general-and-people' }],
      invitations: [],
      retiredInvitationCount: 0,
      relayUnavailableInvitationCount: 0
    })
  })
})
