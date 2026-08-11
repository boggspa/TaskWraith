import { describe, expect, it, vi } from 'vitest'

import type {
  ChannelProductionExistingInviteCredential,
  ChannelProductionStatus
} from './ChannelProductionService'
import { contributionRulesForPreset } from './HumanContributionRules'
import type {
  PeopleToChannelMigrationStartupBootstrap,
  PeopleToChannelMigrationStartupBootstrapDependencies
} from './PeopleToChannelMigrationStartup'
import { startPeopleToChannelMigrationBootstrap } from './PeopleToChannelMigrationStartup'
import {
  PEOPLE_TO_CHANNEL_PRODUCTION_RUNNER_VERSION,
  type PeopleToChannelMigrationProductionRunResult
} from './PeopleToChannelMigrationProductionRunner'

const PLAN_ID = 'a'.repeat(64)
const SOURCE_DIGEST = 'b'.repeat(64)
const INVITE_TOKEN = 'c'.repeat(32)

function migration(): PeopleToChannelMigrationProductionRunResult {
  return {
    schemaVersion: PEOPLE_TO_CHANNEL_PRODUCTION_RUNNER_VERSION,
    planId: PLAN_ID,
    phase: 'cutover_applied',
    executionCreatedThisRun: false,
    routes: [{ chatId: 'chat-a', channelId: 'channel-a', origin: 'people' }],
    invitations: [
      {
        sourceShareId: 'share-a',
        channelId: 'channel-a',
        purpose: 'pending-collaborator',
        sourceCollaboratorId: 'collaborator-a',
        recipientLabel: 'Alex Pending',
        policy: {
          sourceDigest: SOURCE_DIGEST,
          rules: contributionRulesForPreset('comments'),
          requiresHostApproval: true,
          fullHistory: true
        },
        inviteId: 'invite-a',
        roomId: 'room-a',
        inviteToken: INVITE_TOKEN,
        createdAt: 100,
        expiresAt: 60_000
      }
    ],
    recovery: {} as PeopleToChannelMigrationProductionRunResult['recovery']
  }
}

function bootstrap(
  events: string[],
  startError?: Error
): {
  bootstrap: PeopleToChannelMigrationStartupBootstrap
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  describeExistingInvite: ReturnType<typeof vi.fn>
} {
  const status: ChannelProductionStatus = {
    state: 'running',
    channelCount: 1,
    recoveryBlockedChannelCount: 0,
    openRoomCount: 1
  }
  const describeExistingInvite = vi.fn((credential: ChannelProductionExistingInviteCredential) => ({
    ...credential,
    relayUrls: ['wss://relay.example'],
    hostRoomOpened: true
  }))
  const start = vi.fn(() => {
    events.push('channels:start')
    if (startError) throw startError
    return status
  })
  const stop = vi.fn(async () => {
    events.push('channels:stop')
  })
  return {
    bootstrap: { service: { describeExistingInvite }, start, stop },
    start,
    stop,
    describeExistingInvite
  }
}

describe('startPeopleToChannelMigrationBootstrap', () => {
  it('recovers before constructing Channels, then creates both migration authorities before serving', () => {
    const events: string[] = []
    const runToSoak = vi.fn(() => {
      events.push('migration:run')
      return migration()
    })
    const built = bootstrap(events)
    const captured: { dependencies: PeopleToChannelMigrationStartupBootstrapDependencies | null } =
      {
        dependencies: null
      }

    const result = startPeopleToChannelMigrationBootstrap({
      runner: { runToSoak },
      createBootstrap: (next) => {
        events.push('channels:constructed')
        captured.dependencies = next
        expect(() => next.migrationHandoff.snapshot({ chatId: 'chat-a' })).toThrow(
          'People migration handoff was requested before startup completed'
        )
        return built.bootstrap
      }
    })

    expect(events).toEqual(['migration:run', 'channels:constructed', 'channels:start'])
    expect(runToSoak).toHaveBeenCalledOnce()
    expect(result.status).toMatchObject({ state: 'running', channelCount: 1 })
    expect(result.admissionAuthority.affectedChannelIds()).toEqual(['channel-a'])
    if (!captured.dependencies) throw new Error('startup did not construct dependencies')
    expect(captured.dependencies.migratedAdmissionAuthority).toBe(result.admissionAuthority)

    const handoff = captured.dependencies.migrationHandoff.snapshot({ chatId: 'chat-a' })
    expect(handoff).toMatchObject({
      invitations: [
        {
          channelId: 'channel-a',
          recipientLabel: 'Alex Pending',
          status: 'ready',
          invite: { inviteId: 'invite-a' }
        }
      ]
    })
    expect(built.describeExistingInvite).toHaveBeenCalledWith({
      channelId: 'channel-a',
      inviteId: 'invite-a',
      inviteToken: INVITE_TOKEN,
      roomId: 'room-a',
      expiresAt: 60_000
    })
    const projected = JSON.stringify(handoff)
    expect(projected).not.toContain('share-a')
    expect(projected).not.toContain('collaborator-a')
    expect(projected).not.toContain(SOURCE_DIGEST)
  })

  it('does not construct or serve Channels until an interrupted migration recovers on restart', () => {
    const events: string[] = []
    const runToSoak = vi.fn<() => PeopleToChannelMigrationProductionRunResult>(() => {
      throw new Error('injected crash before migration recovery completed')
    })
    const createBootstrap = vi.fn(() => bootstrap(events).bootstrap)

    expect(() =>
      startPeopleToChannelMigrationBootstrap({ runner: { runToSoak }, createBootstrap })
    ).toThrow('injected crash before migration recovery completed')
    expect(createBootstrap).not.toHaveBeenCalled()
    expect(events).toEqual([])

    runToSoak.mockImplementation(() => {
      events.push('migration:recovered')
      return migration()
    })
    const result = startPeopleToChannelMigrationBootstrap({
      runner: { runToSoak },
      createBootstrap
    })

    expect(result.migration.executionCreatedThisRun).toBe(false)
    expect(createBootstrap).toHaveBeenCalledOnce()
    expect(events).toEqual(['migration:recovered', 'channels:start'])
  })

  it('stops a constructed bootstrap when Channel serving cannot start', () => {
    const events: string[] = []
    const built = bootstrap(events, new Error('channel identity unavailable'))

    expect(() =>
      startPeopleToChannelMigrationBootstrap({
        runner: { runToSoak: migration },
        createBootstrap: () => built.bootstrap
      })
    ).toThrow('channel identity unavailable')

    expect(built.start).toHaveBeenCalledOnce()
    expect(built.stop).toHaveBeenCalledOnce()
    expect(events).toEqual(['channels:start', 'channels:stop'])
  })
})
