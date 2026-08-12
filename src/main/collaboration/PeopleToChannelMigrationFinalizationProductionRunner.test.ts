import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  exportRawEd25519PublicKey,
  generateIdentityKeyPair,
  type KeyPair
} from '../../shared/e2ee/keys'
import type { ChatMessage } from '../store/types'
import { ChannelHumanPolicyStore } from './ChannelHumanPolicyStore'
import { channelProductionDataPaths } from './ChannelProductionService'
import { ChannelStore } from './ChannelStore'
import type { HumanCollaborationSafeStorage } from './HumanCollaborationIdentityStore'
import { contributionRulesForPreset } from './HumanContributionRules'
import { HUMAN_COLLABORATOR_COMMENT_KIND } from './HumanCollaboratorMessages'
import { HumanCollaborationStore } from './HumanCollaborationStore'
import {
  PEOPLE_TO_CHANNEL_FINALIZATION_ADMISSION_ESCROW_FILENAME,
  PEOPLE_TO_CHANNEL_FINALIZATION_PRODUCTION_RUNNER_VERSION,
  PeopleToChannelMigrationFinalizationProductionRunner,
  type PeopleToChannelMigrationFinalizationProductionRunnerOptions,
  type PeopleToChannelMigrationFinalizationProductionRunnerStage
} from './PeopleToChannelMigrationFinalizationProductionRunner'
import { peopleToChannelMigrationFinalizationExecutionPath } from './PeopleToChannelMigrationFinalizationExecutionStore'
import {
  PeopleToChannelMigrationRecoveryStore,
  peopleToChannelMigrationRecoveryPaths
} from './PeopleToChannelMigrationRecoveryStore'

const directories: string[] = []

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'taskwraith-channel-terminal-migration-'))
  directories.push(path)
  return path
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function xor(value: Buffer): Buffer {
  return Buffer.from(value.map((byte) => byte ^ 0x96))
}

function safeStorage(available = true): HumanCollaborationSafeStorage {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => xor(Buffer.from(plain, 'utf8')),
    decryptString: (encrypted) => xor(encrypted).toString('utf8')
  }
}

function donorMessage(content = 'review /Users/private/terminal-source.txt'): ChatMessage {
  return {
    id: 'legacy_message_one',
    role: 'system',
    content,
    timestamp: new Date(200).toISOString(),
    metadata: {
      kind: HUMAN_COLLABORATOR_COMMENT_KIND,
      sourceTrust: 'external_untrusted',
      shareId: 'share_one',
      collaboratorId: 'active_person',
      collaboratorDisplayName: 'Active Person',
      clientMessageId: 'legacy_client_one',
      sequence: 1
    }
  }
}

function peopleSource(args: {
  activeKey: string
  pendingKey: string
  includeP5?: boolean
}): unknown {
  return {
    shares: [
      {
        shareId: 'share_one',
        chatId: 'chat_one',
        mode: 'comments',
        enabled: true,
        createdAt: 100,
        updatedAt: 300,
        nextSequence: 2,
        participants: [
          {
            collaboratorId: 'active_person',
            displayName: 'Active Person',
            publicKeyId: args.activeKey,
            status: 'active',
            joinedAt: 150,
            seatOrder: 2,
            colorIndex: 5
          },
          {
            collaboratorId: 'pending_person',
            displayName: 'Pending Person',
            publicKeyId: args.pendingKey,
            status: 'pending',
            seatOrder: 3,
            colorIndex: 2,
            seatDisabled: true
          }
        ],
        invites: [
          {
            inviteId: 'active_invite',
            tokenHash: 'legacy_consumed_token_hash',
            createdAt: 120,
            expiresAt: 20_000,
            consumedAt: 150,
            collaboratorId: 'active_person',
            roomId: 'active_room'
          },
          {
            inviteId: 'open_invite',
            tokenHash: 'legacy_open_token_hash',
            createdAt: 400,
            expiresAt: 20_000,
            roomId: 'legacy_open_room'
          }
        ],
        idempotency: {},
        contributionRules: contributionRulesForPreset('requestHostAction'),
        requiresHostApproval: true,
        fullHistory: true
      },
      ...(args.includeP5
        ? [
            {
              shareId: 'p5_workspace_bootstrap',
              chatId: 'workspace-bootstrap',
              mode: 'comments' as const,
              enabled: false,
              createdAt: 100,
              updatedAt: 300,
              nextSequence: 1,
              participants: [],
              invites: [],
              idempotency: {},
              contributionRules: contributionRulesForPreset('requestHostAction')
            }
          ]
        : [])
    ]
  }
}

interface Fixture {
  userDataPath: string
  identity: KeyPair
  now: number
  sourcePath: string
  empty: boolean
  chat: {
    appChatId: string
    title: string
    scope: 'global'
    chatKind: 'single'
    messages: ChatMessage[]
  }
}

function fixture(args: { empty?: boolean; noShares?: boolean; includeP5?: boolean } = {}): Fixture {
  const userDataPath = directory()
  const identity = generateIdentityKeyPair()
  const sourcePath = join(userDataPath, 'human-collaboration.json')
  const activeKey = exportRawEd25519PublicKey(generateIdentityKeyPair().publicKey).toString(
    'base64'
  )
  const pendingKey = exportRawEd25519PublicKey(generateIdentityKeyPair().publicKey).toString(
    'base64'
  )
  writeFileSync(
    sourcePath,
    JSON.stringify(
      args.empty || args.noShares
        ? { shares: [] }
        : peopleSource({ activeKey, pendingKey, includeP5: args.includeP5 })
    ),
    { mode: 0o600 }
  )
  return {
    userDataPath,
    identity,
    now: 1_000,
    sourcePath,
    empty: args.empty === true,
    chat: {
      appChatId: 'chat_one',
      title: 'Private terminal migration chat',
      scope: 'global',
      chatKind: 'single',
      messages: [donorMessage()]
    }
  }
}

function runner(
  built: Fixture,
  options: {
    crashAt?: PeopleToChannelMigrationFinalizationProductionRunnerStage
    retainedWorkspaceBootstrapShareIds?: () => readonly string[]
    safeStorage?: HumanCollaborationSafeStorage
  } = {}
): PeopleToChannelMigrationFinalizationProductionRunner {
  const input: PeopleToChannelMigrationFinalizationProductionRunnerOptions = {
    userDataPath: built.userDataPath,
    safeStorage: options.safeStorage ?? safeStorage(),
    loadIdentity: () => built.identity,
    hostDisplayName: 'Private Host Person',
    listChats: () => (built.empty ? [] : [built.chat]),
    listWorkflowChatIds: () => [],
    now: () => ++built.now,
    ...(options.retainedWorkspaceBootstrapShareIds
      ? { retainedWorkspaceBootstrapShareIds: options.retainedWorkspaceBootstrapShareIds }
      : {}),
    ...(options.crashAt
      ? {
          afterStage: (stage: PeopleToChannelMigrationFinalizationProductionRunnerStage) => {
            if (stage === options.crashAt) throw new Error(`injected crash at ${stage}`)
          }
        }
      : {})
  }
  return new PeopleToChannelMigrationFinalizationProductionRunner(input)
}

function durableState(built: Fixture) {
  const paths = channelProductionDataPaths(built.userDataPath)
  const channels = new ChannelStore(paths.metadata)
  return {
    paths,
    channels,
    channel: channels.listChannels()[0],
    people: new HumanCollaborationStore(built.sourcePath),
    recovery: new PeopleToChannelMigrationRecoveryStore({ userDataPath: built.userDataPath })
  }
}

describe('PeopleToChannelMigrationFinalizationProductionRunner', () => {
  it('commits an empty clean-profile migration without a retirement transition', () => {
    const built = fixture({ empty: true })
    const completed = runner(built).runToCompletion()

    expect(completed).toMatchObject({
      migration: { phase: 'committed', routes: [], recovery: { phase: 'committed' } },
      finalization: {
        phase: 'committed',
        retireShareIds: [],
        retainedWorkspaceBootstrapShareIds: []
      }
    })
    expect(completed.legacyWriteGate.isQuiesced()).toBe(true)
    expect(durableState(built).people.listShares()).toEqual([])
    expect(runner(built).runToCompletion().terminalPlanId).toBe(completed.terminalPlanId)
  })

  it('fences a terminal delta, retires ordinary People, and exposes only rotated credentials', () => {
    const built = fixture()
    const completed = runner(built).runToCompletion()
    const durable = durableState(built)

    expect(completed).toMatchObject({
      schemaVersion: PEOPLE_TO_CHANNEL_FINALIZATION_PRODUCTION_RUNNER_VERSION,
      migration: {
        phase: 'committed',
        routes: [{ chatId: 'chat_one', origin: 'general-and-people' }],
        recovery: { phase: 'committed' }
      },
      finalization: { phase: 'committed', retireShareIds: ['share_one'] }
    })
    expect(completed.terminalPlanId).not.toBe(completed.migration.planId)
    expect(completed.migration.invitations).toHaveLength(2)
    expect(completed.legacyWriteGate.isQuiesced()).toBe(true)
    expect(() => completed.legacyWriteGate.assertOrdinaryWriteAllowed('share_one')).toThrow(
      /quiesced/
    )

    expect(durable.people.listShares()).toEqual([])
    expect(durable.recovery.load()).toMatchObject({
      phase: 'committed',
      finalizationDigest: completed.finalization.finalizationDigest
    })
    expect(durable.channel).toMatchObject({ chatId: 'chat_one', messageCount: 1 })
    const invites = durable.channels.listInvites(durable.channel!.channelId)
    expect(invites.filter((invite) => invite.revokedAt === undefined)).toHaveLength(2)
    expect(invites.filter((invite) => invite.revokedAt !== undefined)).toHaveLength(2)
    expect(new ChannelHumanPolicyStore(durable.paths.humanPolicies).list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ migrationPlanId: completed.terminalPlanId })
      ])
    )

    const finalizationAtRest = readFileSync(
      peopleToChannelMigrationFinalizationExecutionPath(built.userDataPath),
      'utf8'
    )
    for (const secret of [
      'Private terminal migration chat',
      'Private Host Person',
      'Active Person',
      'review /Users/private/terminal-source.txt',
      'legacy_open_token_hash'
    ]) {
      expect(finalizationAtRest).not.toContain(secret)
    }
    expect(
      readFileSync(
        join(
          peopleToChannelMigrationRecoveryPaths(built.userDataPath).root,
          PEOPLE_TO_CHANNEL_FINALIZATION_ADMISSION_ESCROW_FILENAME
        ),
        'utf8'
      )
    ).not.toContain('Pending Person')

    const resumed = runner(built).runToCompletion()
    expect(resumed.migration).toMatchObject({
      phase: 'committed',
      invitations: completed.migration.invitations
    })
    expect(resumed.terminalPlanId).toBe(completed.terminalPlanId)
    expect(durableState(built).people.listShares()).toEqual([])
  })

  it.each([
    'write_gate_quiesced',
    'finalization_execution_durable',
    'recovery_fenced',
    'logs_durable',
    'policies_durable',
    'admission:terminal_escrow_durable',
    'admission:terminal_metadata_durable',
    'admission:superseded_invitations_retired',
    'admissions_durable',
    'legacy_retired',
    'receipt_durable'
  ] as const)(
    'recovers interrupted terminal startup after %s',
    (crashAt) => {
      const built = fixture()
      expect(() => runner(built, { crashAt }).runToCompletion()).toThrow(
        `injected crash at ${crashAt}`
      )

      const resumed = runner(built).runToCompletion()
      const durable = durableState(built)
      expect(resumed.migration).toMatchObject({
        phase: 'committed',
        recovery: { phase: 'committed' }
      })
      expect(resumed.migration.invitations).toHaveLength(2)
      expect(durable.people.listShares()).toEqual([])
      expect(durable.recovery.load()?.phase).toBe('committed')
      expect(durable.channels.listChannels()).toHaveLength(1)
    },
    15_000
  )

  it('preserves only the explicit P5 workspace-bootstrap exception across terminal recovery', () => {
    const built = fixture({ includeP5: true })
    const completed = runner(built, {
      retainedWorkspaceBootstrapShareIds: () => ['p5_workspace_bootstrap']
    }).runToCompletion()
    const durable = durableState(built)

    expect(completed.finalization).toMatchObject({
      retireShareIds: ['share_one'],
      retainedWorkspaceBootstrapShareIds: ['p5_workspace_bootstrap']
    })
    expect(durable.people.listShares().map((share) => share.shareId)).toEqual([
      'p5_workspace_bootstrap'
    ])
    expect(() =>
      completed.legacyWriteGate.assertOrdinaryWriteAllowed('p5_workspace_bootstrap')
    ).not.toThrow()
    expect(() => completed.legacyWriteGate.assertOrdinaryWriteAllowed('share_one')).toThrow(
      /quiesced/
    )
  })

  it('fails before any People retirement when terminal encryption is unavailable', () => {
    const built = fixture()
    expect(() => runner(built, { safeStorage: safeStorage(false) }).runToCompletion()).toThrow(
      /execution encryption is unavailable/
    )
    expect(
      durableState(built)
        .people.listShares()
        .map((share) => share.shareId)
    ).toEqual(['share_one'])
  })

  it('commits a chats-present zero-share upgrade profile and stays committed', () => {
    const built = fixture({ noShares: true })
    const completed = runner(built).runToCompletion()

    expect(completed).toMatchObject({
      migration: { phase: 'committed', recovery: { phase: 'committed' } },
      finalization: {
        phase: 'committed',
        retireShareIds: [],
        retainedWorkspaceBootstrapShareIds: []
      }
    })
    expect(completed.migration.routes).toHaveLength(1)
    expect(completed.legacyWriteGate.isQuiesced()).toBe(true)
    expect(durableState(built).people.listShares()).toEqual([])
    expect(runner(built).runToCompletion().terminalPlanId).toBe(completed.terminalPlanId)
  })

  it('boots after a post-commit message append instead of demanding a frozen world', () => {
    const built = fixture()
    const completed = runner(built).runToCompletion()
    const durable = durableState(built)
    const channel = durable.channels.listChannels()[0]!
    durable.channels.recordCommittedMessage(channel.channelId, channel.messageCount + 1, 900_000)

    const rebooted = runner(built).runToCompletion()
    expect(rebooted.terminalPlanId).toBe(completed.terminalPlanId)
    expect(rebooted.migration).toMatchObject({
      phase: 'committed',
      planId: completed.migration.planId
    })
    expect(rebooted.migration.routes).toEqual(completed.migration.routes)
    expect(rebooted.legacyWriteGate.isQuiesced()).toBe(true)
  })

  it('boots after a migrated channel closes post-commit and keeps the durable routes', () => {
    const built = fixture()
    const completed = runner(built).runToCompletion()
    const durable = durableState(built)
    durable.channels.closeChannel({
      channelId: completed.migration.routes[0]!.channelId,
      now: 900_000
    })

    const rebooted = runner(built).runToCompletion()
    expect(rebooted.terminalPlanId).toBe(completed.terminalPlanId)
    expect(rebooted.migration.routes).toEqual(completed.migration.routes)
  })

  it('boots after post-commit history deletion purges every channel', () => {
    const built = fixture()
    const completed = runner(built).runToCompletion()
    durableState(built).channels.purgeAllChannels()

    const rebooted = runner(built).runToCompletion()
    expect(rebooted.terminalPlanId).toBe(completed.terminalPlanId)
    expect(rebooted.migration.phase).toBe('committed')
  })

  it('deletes the plaintext People source backup once the receipt commits', () => {
    const built = fixture()
    const completed = runner(built).runToCompletion()

    const backups = peopleToChannelMigrationRecoveryPaths(built.userDataPath).backups
    expect(readdirSync(backups)).toEqual([])
    expect(runner(built).runToCompletion().terminalPlanId).toBe(completed.terminalPlanId)
  })

  it('converges an empty profile across a crash at the recovery fence', () => {
    const built = fixture({ empty: true })
    expect(() => runner(built, { crashAt: 'recovery_fenced' }).runToCompletion()).toThrow(
      /injected crash/
    )

    const completed = runner(built).runToCompletion()
    expect(completed.migration.phase).toBe('committed')
    expect(completed.finalization.retireShareIds).toEqual([])
  })
})
