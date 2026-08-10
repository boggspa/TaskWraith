import { readFileSync, rmSync, writeFileSync } from 'fs'
import { mkdtempSync } from 'fs'
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
import type { HumanCollaborationSafeStorage } from './HumanCollaborationIdentityStore'
import { contributionRulesForPreset } from './HumanContributionRules'
import { HUMAN_COLLABORATOR_COMMENT_KIND } from './HumanCollaboratorMessages'
import { ChannelMessageLog } from './ChannelMessageLog'
import { channelProductionDataPaths } from './ChannelProductionService'
import { ChannelStore } from './ChannelStore'
import { peopleToChannelMigrationExecutionPath } from './PeopleToChannelMigrationExecutionStore'
import {
  PEOPLE_TO_CHANNEL_PRODUCTION_RUNNER_VERSION,
  PeopleToChannelMigrationProductionRunner,
  type PeopleToChannelMigrationProductionRunnerStage
} from './PeopleToChannelMigrationProductionRunner'
import { PeopleToChannelMigrationRecoveryStore } from './PeopleToChannelMigrationRecoveryStore'

const directories: string[] = []

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'taskwraith-channel-production-migration-'))
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

function donorMessage(content = 'review /Users/private/source.txt'): ChatMessage {
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

function peopleSource(activeKey: string, pendingKey: string): unknown {
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
            publicKeyId: activeKey,
            status: 'active',
            joinedAt: 150,
            seatOrder: 2,
            colorIndex: 5
          },
          {
            collaboratorId: 'pending_person',
            displayName: 'Pending Person',
            publicKeyId: pendingKey,
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
      }
    ]
  }
}

interface Fixture {
  userDataPath: string
  identity: KeyPair
  now: number
  sourcePath: string
  sourceBytes: Buffer
  chat: {
    appChatId: string
    title: string
    scope: 'global'
    chatKind: 'single'
    messages: ChatMessage[]
  }
}

function fixture(): Fixture {
  const userDataPath = directory()
  const identity = generateIdentityKeyPair()
  const sourcePath = join(userDataPath, 'human-collaboration.json')
  const activeKey = exportRawEd25519PublicKey(generateIdentityKeyPair().publicKey).toString(
    'base64'
  )
  const pendingKey = exportRawEd25519PublicKey(generateIdentityKeyPair().publicKey).toString(
    'base64'
  )
  writeFileSync(sourcePath, JSON.stringify(peopleSource(activeKey, pendingKey)), { mode: 0o600 })
  return {
    userDataPath,
    identity,
    now: 1_000,
    sourcePath,
    sourceBytes: readFileSync(sourcePath),
    chat: {
      appChatId: 'chat_one',
      title: 'Private migration chat',
      scope: 'global',
      chatKind: 'single',
      messages: [donorMessage()]
    }
  }
}

function runner(
  built: Fixture,
  options: {
    crashAt?: PeopleToChannelMigrationProductionRunnerStage
    safeStorage?: HumanCollaborationSafeStorage
  } = {}
): PeopleToChannelMigrationProductionRunner {
  return new PeopleToChannelMigrationProductionRunner({
    userDataPath: built.userDataPath,
    safeStorage: options.safeStorage ?? safeStorage(),
    loadIdentity: () => built.identity,
    hostDisplayName: 'Private Host Person',
    listChats: () => [built.chat],
    listWorkflowChatIds: () => [],
    now: () => ++built.now,
    ...(options.crashAt
      ? {
          afterStage: (stage: PeopleToChannelMigrationProductionRunnerStage) => {
            if (stage === options.crashAt) throw new Error(`injected crash at ${stage}`)
          }
        }
      : {})
  })
}

function durableState(built: Fixture) {
  const paths = channelProductionDataPaths(built.userDataPath)
  const channels = new ChannelStore(paths.metadata)
  const channel = channels.listChannels()[0]
  const log = new ChannelMessageLog(paths.logs, channels)
  return {
    paths,
    channels,
    channel,
    log,
    recovery: new PeopleToChannelMigrationRecoveryStore({ userDataPath: built.userDataPath })
  }
}

describe('PeopleToChannelMigrationProductionRunner', () => {
  it('preflights read-only then reaches additive soak without mutating People', () => {
    const built = fixture()
    const active = runner(built)

    expect(active.preflight()).toMatchObject({
      schemaVersion: PEOPLE_TO_CHANNEL_PRODUCTION_RUNNER_VERSION,
      phase: 'ready',
      executionDurable: false,
      summary: { shares: 1, create: 1, blocked: 0, generalChats: 1 }
    })
    expect(readFileSync(built.sourcePath)).toEqual(built.sourceBytes)

    const result = active.runToSoak()
    expect(result).toMatchObject({
      schemaVersion: PEOPLE_TO_CHANNEL_PRODUCTION_RUNNER_VERSION,
      phase: 'cutover_applied',
      executionCreatedThisRun: true,
      routes: [{ chatId: 'chat_one', origin: 'general-and-people' }],
      recovery: { phase: 'cutover_applied' }
    })
    expect(result.invitations).toHaveLength(2)
    expect(new Set(result.invitations.map((invite) => invite.purpose))).toEqual(
      new Set(['pending-collaborator', 'open-invite'])
    )

    const durable = durableState(built)
    expect(durable.channel).toMatchObject({ chatId: 'chat_one', messageCount: 1 })
    expect(durable.channels.listMembers(durable.channel!.channelId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayName: 'Active Person',
          presentation: { seatOrder: 2, colorIndex: 5 }
        })
      ])
    )
    expect(
      durable.log.replay({ channelId: durable.channel!.channelId, resumeAfter: 0 })
    ).toMatchObject({
      records: [{ content: 'review [redacted-path]', sequence: 1 }],
      highWaterSequence: 1
    })
    expect(new ChannelHumanPolicyStore(durable.paths.humanPolicies).list()).toHaveLength(1)
    expect(readFileSync(built.sourcePath)).toEqual(built.sourceBytes)

    const executionAtRest = readFileSync(
      peopleToChannelMigrationExecutionPath(built.userDataPath),
      'utf8'
    )
    for (const secret of [
      'Private migration chat',
      'Private Host Person',
      'Active Person',
      'review /Users/private/source.txt',
      'legacy_open_token_hash'
    ]) {
      expect(executionAtRest).not.toContain(secret)
    }

    expect(active.preflight()).toMatchObject({
      planId: result.planId,
      phase: 'cutover_applied',
      executionDurable: true
    })
    expect(active.runToSoak()).toMatchObject({
      planId: result.planId,
      phase: 'cutover_applied',
      executionCreatedThisRun: false
    })
    expect(durableState(built).log.highWaterSequence(durable.channel!.channelId)).toBe(1)
    expect(readFileSync(built.sourcePath)).toEqual(built.sourceBytes)
  })

  it('snapshots an existing Channel log and preserves its prefix during a production merge', () => {
    const built = fixture()
    const paths = channelProductionDataPaths(built.userDataPath)
    const channels = new ChannelStore(paths.metadata)
    const hostIdentityPublicKey = exportRawEd25519PublicKey(built.identity.publicKey).toString(
      'base64'
    )
    const created = channels.createChannel({
      chatId: built.chat.appChatId,
      title: built.chat.title,
      owner: { displayName: 'Private Host Person', identityPublicKey: hostIdentityPublicKey },
      now: 50
    })
    const log = new ChannelMessageLog(paths.logs, channels)
    log.append({
      channelId: created.channel.channelId,
      principalMemberId: created.owner.memberId,
      identityPublicKey: hostIdentityPublicKey,
      clientMessageId: 'existing_host_prefix',
      content: 'Existing host prefix',
      now: 60
    })

    const result = runner(built).runToSoak()
    const durable = durableState(built)
    expect(result.routes).toEqual([
      {
        chatId: 'chat_one',
        channelId: created.channel.channelId,
        origin: 'general-and-people'
      }
    ])
    expect(durable.channels.listChannels()).toHaveLength(1)
    expect(
      durable.log.replay({ channelId: created.channel.channelId, resumeAfter: 0 }).records
    ).toMatchObject([
      { sequence: 1, content: 'Existing host prefix' },
      { sequence: 2, content: 'review [redacted-path]' }
    ])
    expect(readFileSync(built.sourcePath)).toEqual(built.sourceBytes)
  })

  it.each([
    'execution_durable',
    'recovery_prepared',
    'channels_applied',
    'cutover_applied'
  ] as const)('resumes exactly after a crash at %s', (crashAt) => {
    const built = fixture()
    expect(() => runner(built, { crashAt }).runToSoak()).toThrow(`injected crash at ${crashAt}`)

    const resumed = runner(built).runToSoak()
    const durable = durableState(built)
    expect(resumed.phase).toBe('cutover_applied')
    expect(resumed.invitations).toHaveLength(2)
    expect(durable.recovery.load()?.phase).toBe('cutover_applied')
    expect(durable.channels.listChannels()).toHaveLength(1)
    expect(durable.log.highWaterSequence(durable.channel!.channelId)).toBe(1)
    expect(readFileSync(built.sourcePath)).toEqual(built.sourceBytes)
  })

  it('blocks source drift after an orphan execution before any mutable authority lands', () => {
    const built = fixture()
    expect(() => runner(built, { crashAt: 'execution_durable' }).runToSoak()).toThrow(
      /injected crash/
    )
    built.chat.messages[0] = donorMessage('changed after the frozen execution')

    expect(() => runner(built).runToSoak()).toThrow(/source changed after the orphan execution/)
    const durable = durableState(built)
    expect(durable.recovery.load()).toBeNull()
    expect(durable.channels.listChannels()).toEqual([])
  })

  it('requires encryption before recovery, Channel, policy, or People mutation', () => {
    const built = fixture()
    expect(() => runner(built, { safeStorage: safeStorage(false) }).runToSoak()).toThrow(
      /execution encryption is unavailable/
    )
    const durable = durableState(built)
    expect(durable.recovery.load()).toBeNull()
    expect(durable.channels.listChannels()).toEqual([])
    expect(new ChannelHumanPolicyStore(durable.paths.humanPolicies).list()).toEqual([])
    expect(readFileSync(built.sourcePath)).toEqual(built.sourceBytes)
  })

  it('recognizes a committed recovery boundary without reapplying the migration', () => {
    const built = fixture()
    const first = runner(built).runToSoak()
    const recovery = new PeopleToChannelMigrationRecoveryStore({
      userDataPath: built.userDataPath,
      now: () => 9_000
    })
    recovery.finalize({ planId: first.planId })

    expect(runner(built).runToSoak()).toMatchObject({
      planId: first.planId,
      phase: 'committed',
      invitations: expect.any(Array),
      recovery: { phase: 'committed' }
    })
    const durable = durableState(built)
    expect(durable.channels.listChannels()).toHaveLength(1)
    expect(durable.log.highWaterSequence(durable.channel!.channelId)).toBe(1)
  })
})
