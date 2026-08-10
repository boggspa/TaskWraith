import { createHash } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import type { ChatMessage } from '../store/types'
import type { HumanCollaborationSafeStorage } from './HumanCollaborationIdentityStore'
import type { HumanCollaborationShare } from './HumanCollaborationStore'
import { contributionRulesForPreset } from './HumanContributionRules'
import { HUMAN_COLLABORATOR_COMMENT_KIND } from './HumanCollaboratorMessages'
import { PeopleToChannelMigrationAdmissionReissue } from './PeopleToChannelMigrationAdmissionReissue'
import { ChannelHumanPolicyStore, channelHumanPolicyPath } from './ChannelHumanPolicyStore'
import { ChannelMessageLog } from './ChannelMessageLog'
import { CHANNEL_SCHEMA_VERSION, ChannelStore } from './ChannelStore'
import {
  PEOPLE_TO_CHANNEL_CHANNELS_COORDINATOR_VERSION,
  PeopleToChannelMigrationChannelsCoordinator,
  isPeopleToChannelMigrationChannelsCoordinatorError,
  type PeopleToChannelChannelsCoordinatorStage
} from './PeopleToChannelMigrationChannelsCoordinator'
import {
  materializePeopleToChannelMigrationHistory,
  type PeopleToChannelMigrationHistoryMaterialization
} from './PeopleToChannelMigrationHistory'
import {
  peopleToChannelLegacyContributionEvidenceList,
  type PeopleToChannelInventoryChat
} from './PeopleToChannelMigrationInventory'
import { PeopleToChannelMigrationLogWriter } from './PeopleToChannelMigrationLogWriter'
import { materializePeopleToChannels } from './PeopleToChannelMigrationMaterializer'
import {
  createPeopleToChannelMigrationPlan,
  type PeopleToChannelMigrationPlanInput
} from './PeopleToChannelMigrationPlan'
import { PeopleToChannelMigrationPolicyWriter } from './PeopleToChannelMigrationPolicyWriter'
import { PeopleToChannelMigrationRecoveryStore } from './PeopleToChannelMigrationRecoveryStore'
import { RECORDED_PEOPLE_TO_CHANNEL_CUTOVER_DECISIONS } from './PeopleToChannelMigrationRecordedDecisions'
import { PeopleToChannelMigrationSource } from './PeopleToChannelMigrationSource'

const HOST_KEY = Buffer.alloc(32, 21).toString('base64')
const ACTIVE_KEY = Buffer.alloc(32, 22).toString('base64')
const PENDING_KEY = Buffer.alloc(32, 23).toString('base64')
const MIGRATION_AT = 500
const temporaryPaths: string[] = []

type CrashStage = PeopleToChannelChannelsCoordinatorStage | 'escrow_durable'

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'taskwraith-channels-p4-coordinator-'))
  temporaryPaths.push(path)
  return path
}

afterEach(() => {
  while (temporaryPaths.length) rmSync(temporaryPaths.pop()!, { recursive: true, force: true })
})

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => [key, canonicalize(entry)])
  )
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function xor(value: Buffer): Buffer {
  return Buffer.from(value.map((byte) => byte ^ 0x96))
}

function safeStorage(): HumanCollaborationSafeStorage {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => xor(Buffer.from(plain, 'utf8')),
    decryptString: (encrypted) => xor(encrypted).toString('utf8')
  }
}

function donorMessage(): ChatMessage {
  return {
    id: 'legacy_message_one',
    role: 'system',
    content: 'review /Users/private/source.txt',
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

function share(withPendingAdmissions: boolean): HumanCollaborationShare {
  return {
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
        publicKeyId: ACTIVE_KEY,
        status: 'active',
        joinedAt: 150
      },
      ...(withPendingAdmissions
        ? [
            {
              collaboratorId: 'pending_person',
              displayName: 'Pending Person',
              publicKeyId: PENDING_KEY,
              status: 'pending' as const
            }
          ]
        : [])
    ],
    invites: [
      {
        inviteId: 'active_invite',
        tokenHash: 'legacy_consumed_token_hash',
        createdAt: 120,
        expiresAt: 2_000,
        consumedAt: 150,
        collaboratorId: 'active_person',
        roomId: 'active_room'
      },
      ...(withPendingAdmissions
        ? [
            {
              inviteId: 'open_invite',
              tokenHash: 'legacy_open_token_hash',
              createdAt: 400,
              expiresAt: 2_000,
              roomId: 'legacy_open_room'
            }
          ]
        : [])
    ],
    idempotency: {},
    contributionRules: contributionRulesForPreset('requestHostAction'),
    requiresHostApproval: true,
    fullHistory: true
  }
}

function fixture(args: { withPendingAdmissions?: boolean } = {}) {
  const withPendingAdmissions = args.withPendingAdmissions ?? true
  const userDataPath = temporaryDirectory()
  const sourcePath = join(userDataPath, 'human-collaboration.json')
  const sourceShare = share(withPendingAdmissions)
  writeFileSync(sourcePath, JSON.stringify({ shares: [sourceShare] }, null, 2), {
    mode: 0o600
  })
  const source = new PeopleToChannelMigrationSource(sourcePath).read()
  const message = donorMessage()
  const donorChat: PeopleToChannelInventoryChat = {
    appChatId: 'chat_one',
    title: 'Migrated private chat',
    scope: 'global',
    chatKind: 'single',
    messages: [message]
  }
  const planInput: PeopleToChannelMigrationPlanInput = {
    hostIdentityPublicKey: HOST_KEY,
    people: source.snapshot,
    channels: {
      schemaVersion: CHANNEL_SCHEMA_VERSION,
      channels: [],
      members: [],
      invites: []
    },
    chats: [
      {
        chatId: donorChat.appChatId,
        title: donorChat.title,
        scope: donorChat.scope,
        chatKind: donorChat.chatKind,
        legacyContributions: peopleToChannelLegacyContributionEvidenceList([message])
      }
    ]
  }
  const plan = createPeopleToChannelMigrationPlan(planInput)
  const base = materializePeopleToChannels({
    plan,
    source: planInput,
    hostDisplayName: 'Host',
    migrationAt: MIGRATION_AT
  })
  const history = materializePeopleToChannelMigrationHistory({
    plan,
    base,
    donorChats: [donorChat],
    existingLogs: [],
    legacyProjectionHistory: 'import-then-reset'
  })
  new PeopleToChannelMigrationRecoveryStore({
    userDataPath,
    now: () => 1_000
  }).prepare({
    plan,
    source,
    decisions: RECORDED_PEOPLE_TO_CHANNEL_CUTOVER_DECISIONS
  })
  return {
    userDataPath,
    channelsPath: join(userDataPath, 'channels', 'channels.json'),
    logsPath: join(userDataPath, 'channels', 'logs'),
    policyPath: channelHumanPolicyPath(userDataPath),
    escrowPath: join(userDataPath, 'channels', 'people-to-channel-v1', 'admissions.json'),
    plan,
    base,
    history
  }
}

function runtime(
  built: ReturnType<typeof fixture>,
  args: { crashAt?: CrashStage; events?: string[] } = {}
) {
  const events = args.events ?? []
  const crash = (stage: CrashStage): void => {
    events.push(stage)
    if (args.crashAt === stage) throw new Error(`injected crash at ${stage}`)
  }
  const channels = new ChannelStore(built.channelsPath)
  const messageLog = new ChannelMessageLog(built.logsPath, channels)
  const logs = new PeopleToChannelMigrationLogWriter(messageLog)
  const policyStore = new ChannelHumanPolicyStore(built.policyPath)
  const policies = new PeopleToChannelMigrationPolicyWriter({
    policies: policyStore,
    now: () => 1_500
  })
  let randomId = 0
  let randomToken = 0
  const admissions = new PeopleToChannelMigrationAdmissionReissue({
    storagePath: built.escrowPath,
    safeStorage: safeStorage(),
    channels,
    now: () => 1_500,
    randomId: () => `migration_id_${String((randomId += 1)).padStart(3, '0')}`,
    randomToken: () => sha256(`migration_token_${(randomToken += 1)}`).slice(0, 32),
    afterEscrowDurable: () => crash('escrow_durable'),
    afterChannelApplied: () => events.push('admission_metadata_durable')
  })
  const recovery = new PeopleToChannelMigrationRecoveryStore({
    userDataPath: built.userDataPath,
    now: () => 2_000,
    afterDurableWrite: (stage) => {
      if (stage === 'intent:channels_applied') {
        events.push('intent:channels_applied')
        if (args.crashAt === 'recovery_durable') {
          throw new Error('injected crash at recovery_durable')
        }
      }
    }
  })
  const coordinator = new PeopleToChannelMigrationChannelsCoordinator({
    recovery,
    logs,
    policies,
    admissions,
    channels,
    now: () => 2_000,
    afterStage: (stage) => {
      if (stage === 'recovery_durable') events.push(stage)
      else crash(stage)
    }
  })
  return { coordinator, channels, messageLog, policyStore, recovery, events }
}

function expectRecoveryBlocked(action: () => unknown): void {
  let error: unknown
  try {
    action()
  } catch (caught) {
    error = caught
  }
  expect(isPeopleToChannelMigrationChannelsCoordinatorError(error)).toBe(true)
}

function resealHistory(
  history: PeopleToChannelMigrationHistoryMaterialization
): PeopleToChannelMigrationHistoryMaterialization {
  const { executionDigest: _digest, ...draft } = history
  return { ...draft, executionDigest: sha256(canonicalJson(draft)) }
}

describe('PeopleToChannelMigrationChannelsCoordinator', () => {
  it('makes logs, restrictive policy, escrow, and complete metadata durable before recovery', () => {
    const built = fixture()
    const events: string[] = []
    const active = runtime(built, { events })
    const result = active.coordinator.apply({ base: built.base, history: built.history })

    expect(result).toMatchObject({
      schemaVersion: PEOPLE_TO_CHANNEL_CHANNELS_COORDINATOR_VERSION,
      phase: 'channels_applied',
      planId: built.plan.planId,
      channelStateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      channelIds: [built.base.mutations[0].channel.channelId],
      recoveryAdvancedThisRun: true,
      recovery: { phase: 'channels_applied' }
    })
    expect(result.invitations).toHaveLength(2)
    expect(events).toEqual([
      'logs_durable',
      'policies_durable',
      'escrow_durable',
      'admission_metadata_durable',
      'metadata_durable',
      'intent:channels_applied',
      'recovery_durable'
    ])
    const channelId = result.channelIds[0]
    expect(active.channels.listChannels()).toHaveLength(1)
    expect(active.channels.listInvites(channelId)).toHaveLength(2)
    expect(active.messageLog.replay({ channelId, resumeAfter: 0 }).records).toMatchObject([
      { sequence: 1, content: 'review [redacted-path]' }
    ])
    expect(
      active.policyStore.evaluate({
        channelId,
        memberId: built.base.policies[0].memberId,
        intent: 'requestHostAction',
        contentBytes: 10
      })
    ).toMatchObject({ outcome: 'host_review' })
    const escrow = readFileSync(built.escrowPath, 'utf8')
    expect(escrow).not.toContain('legacy_open_token_hash')
    expect(escrow).not.toContain('pending_person')
  })

  it.each<CrashStage>([
    'logs_durable',
    'policies_durable',
    'escrow_durable',
    'metadata_durable',
    'recovery_durable'
  ])('converges exactly after a crash at %s', (crashAt) => {
    const built = fixture()
    expect(() =>
      runtime(built, { crashAt }).coordinator.apply({ base: built.base, history: built.history })
    ).toThrow(`injected crash at ${crashAt}`)

    const phaseAfterCrash = new PeopleToChannelMigrationRecoveryStore({
      userDataPath: built.userDataPath
    }).load()!.phase
    expect(phaseAfterCrash).toBe(crashAt === 'recovery_durable' ? 'channels_applied' : 'prepared')

    const restarted = runtime(built)
    const recovered = restarted.coordinator.apply({ base: built.base, history: built.history })
    expect(recovered.phase).toBe('channels_applied')
    expect(recovered.recoveryAdvancedThisRun).toBe(crashAt !== 'recovery_durable')
    expect(recovered.invitations).toHaveLength(2)
    expect(restarted.channels.listChannels()).toHaveLength(1)
    expect(
      restarted.messageLog.replay({
        channelId: recovered.channelIds[0],
        resumeAfter: 0
      }).records
    ).toHaveLength(1)

    const third = restarted.coordinator.apply({ base: built.base, history: built.history })
    expect(third).toEqual({ ...recovered, recoveryAdvancedThisRun: false })
  })

  it('uses the direct complete metadata batch when no admissions need escrow', () => {
    const built = fixture({ withPendingAdmissions: false })
    const active = runtime(built)
    const result = active.coordinator.apply({ base: built.base, history: built.history })

    expect(result.invitations).toEqual([])
    expect(result.channelIds).toEqual([built.base.mutations[0].channel.channelId])
    expect(active.channels.listChannels()).toHaveLength(1)
    expect(existsSync(built.escrowPath)).toBe(false)
    expect(active.recovery.load()?.phase).toBe('channels_applied')
  })

  it('blocks a self-consistent history that changes frozen membership before any write', () => {
    const built = fixture()
    const changed = clone(built.history)
    changed.metadataMutations[0].members[0].displayName = 'Changed after freeze'
    const resealed = resealHistory(changed)
    const active = runtime(built)

    expectRecoveryBlocked(() => active.coordinator.apply({ base: built.base, history: resealed }))
    expect(active.recovery.load()?.phase).toBe('prepared')
    expect(active.channels.listChannels()).toEqual([])
    expect(existsSync(built.policyPath)).toBe(false)
    expect(existsSync(built.escrowPath)).toBe(false)

    const unbacked = clone(built.history)
    unbacked.logMutations = []
    unbacked.importedContributionCount = 0
    expectRecoveryBlocked(() =>
      active.coordinator.apply({ base: built.base, history: resealHistory(unbacked) })
    )
    expect(active.recovery.load()?.phase).toBe('prepared')
  })

  it('fails closed if targeted Channel evidence changes after the durable phase marker', () => {
    const built = fixture()
    const first = runtime(built)
    const applied = first.coordinator.apply({ base: built.base, history: built.history })
    first.channels.createInvite({ channelId: applied.channelIds[0], now: 1_800 })

    expectRecoveryBlocked(() =>
      runtime(built).coordinator.apply({ base: built.base, history: built.history })
    )
    expect(
      new PeopleToChannelMigrationRecoveryStore({ userDataPath: built.userDataPath }).load()?.phase
    ).toBe('channels_applied')
  })
})
