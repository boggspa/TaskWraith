import { createHash } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { ChannelHumanPolicyStore } from './ChannelHumanPolicyStore'
import { contributionRulesForPreset } from './HumanContributionRules'
import { PeopleToChannelMigrationAdmissionAuthority } from './PeopleToChannelMigrationAdmissionAuthority'
import {
  PeopleToChannelMigrationAdmissionReissue,
  type PeopleToChannelReissuedAdmission
} from './PeopleToChannelMigrationAdmissionReissue'
import type { PeopleToChannelMigrationExecution } from './PeopleToChannelMigrationExecutionStore'
import type { PeopleToChannelMigrationFinalizationExecution } from './PeopleToChannelMigrationFinalizationExecutionStore'
import {
  PeopleToChannelMigrationFinalizationAdmissions,
  PeopleToChannelMigrationFinalizationAdmissionsError
} from './PeopleToChannelMigrationFinalizationAdmissions'
import {
  PEOPLE_TO_CHANNEL_HISTORY_MATERIALIZATION_VERSION,
  type PeopleToChannelMigrationHistoryMaterialization
} from './PeopleToChannelMigrationHistory'
import {
  PEOPLE_TO_CHANNEL_MATERIALIZATION_VERSION,
  type PeopleToChannelMigrationMaterialization,
  type PeopleToChannelPendingAdmissionReissue
} from './PeopleToChannelMigrationMaterializer'
import { ChannelStore, type ChannelStoreMigrationMutation } from './ChannelStore'
import { channelStoreSubsetDigest } from './ChannelStoreSubsetDigest'

const INITIAL_PLAN_ID = 'a'.repeat(64)
const INITIAL_PLAN_DIGEST = 'b'.repeat(64)
const TERMINAL_PLAN_ID = 'c'.repeat(64)

const roots: string[] = []

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) =>
    Buffer.from(Buffer.from(value, 'utf8').map((byte) => byte ^ 0x5a)),
  decryptString: (value: Buffer) =>
    Buffer.from(Buffer.from(value).map((byte) => byte ^ 0x5a)).toString('utf8')
}

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'taskwraith-p4-terminal-admissions-'))
  roots.push(value)
  return value
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

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function sealBase(
  value: Omit<PeopleToChannelMigrationMaterialization, 'materializationDigest'>
): PeopleToChannelMigrationMaterialization {
  return { ...value, materializationDigest: sha256(canonicalJson(value)) }
}

function sealHistory(
  value: Omit<PeopleToChannelMigrationHistoryMaterialization, 'executionDigest'>
): PeopleToChannelMigrationHistoryMaterialization {
  return { ...value, executionDigest: sha256(canonicalJson(value)) }
}

function metadata(store: ChannelStore, channelId: string): ChannelStoreMigrationMutation[] {
  const channel = store.getChannel(channelId)!
  const members = store.listMembers(channelId)
  const invites = store.listInvites(channelId)
  return [
    {
      mode: 'merge',
      beforeDigest: channelStoreSubsetDigest(channel, members, invites),
      channel,
      members,
      invites
    }
  ]
}

function pending(
  channelId: string,
  policy = contributionRulesForPreset('comments')
): PeopleToChannelPendingAdmissionReissue {
  return {
    sourceShareId: 'share_one',
    channelId,
    pendingCollaboratorIds: ['person_pending'],
    pendingCollaboratorLabels: [
      { sourceCollaboratorId: 'person_pending', recipientLabel: 'Pending colleague' }
    ],
    pendingMemberPresentations: [],
    openInviteCount: 1,
    policy: {
      sourceDigest: 'd'.repeat(64),
      rules: policy,
      requiresHostApproval: false,
      fullHistory: false
    }
  }
}

function baseFor(args: {
  planId: string
  sourceDigest: string
  migrationAt: number
  mutations: ChannelStoreMigrationMutation[]
  pendingAdmissions: PeopleToChannelPendingAdmissionReissue[]
}): PeopleToChannelMigrationMaterialization {
  return sealBase({
    schemaVersion: PEOPLE_TO_CHANNEL_MATERIALIZATION_VERSION,
    planId: args.planId,
    sourceDigest: args.sourceDigest,
    migrationAt: args.migrationAt,
    mutations: args.mutations.map(clone),
    policies: [],
    pendingAdmissionReissues: args.pendingAdmissions.map(clone),
    migratedShareIds: ['share_one'],
    retainedShareIds: [],
    generalChatIds: ['chat_pending'],
    backfilledGeneralChatIds: [],
    existingGeneralChatIds: [],
    requirements: args.pendingAdmissions.length > 0 ? ['pending_admission_reissue'] : []
  })
}

function historyFor(
  base: PeopleToChannelMigrationMaterialization,
  mutations: ChannelStoreMigrationMutation[]
): PeopleToChannelMigrationHistoryMaterialization {
  return sealHistory({
    schemaVersion: PEOPLE_TO_CHANNEL_HISTORY_MATERIALIZATION_VERSION,
    planId: base.planId,
    sourceDigest: base.sourceDigest,
    baseMaterializationDigest: base.materializationDigest,
    migrationAt: base.migrationAt,
    metadataMutations: mutations.map(clone),
    logMutations: [],
    importedContributionCount: 0
  })
}

function execution(args: {
  planId: string
  planDigest: string
  base: PeopleToChannelMigrationMaterialization
  history: PeopleToChannelMigrationHistoryMaterialization
}): PeopleToChannelMigrationExecution {
  return {
    planDigest: args.planDigest,
    plan: { planId: args.planId },
    base: args.base,
    history: args.history
  } as unknown as PeopleToChannelMigrationExecution
}

function finalization(args: {
  initial: PeopleToChannelMigrationExecution
  base: PeopleToChannelMigrationMaterialization
  history: PeopleToChannelMigrationHistoryMaterialization
}): PeopleToChannelMigrationFinalizationExecution {
  return {
    initialPlanId: args.initial.plan.planId,
    initialPlanDigest: args.initial.planDigest,
    scope: {
      schemaVersion: 1,
      retireShareIds: ['share_one'],
      retainedWorkspaceBootstrapShareIds: []
    },
    delta: execution({
      planId: args.base.planId,
      planDigest: 'e'.repeat(64),
      base: args.base,
      history: args.history
    })
  } as unknown as PeopleToChannelMigrationFinalizationExecution
}

function fixture(args: { terminalPending?: boolean } = {}) {
  const directory = root()
  let serial = 0
  const randomId = () => `migration_id_${++serial}`
  const randomToken = () => `token_${String(++serial).padStart(26, 'x')}`
  const store = new ChannelStore(join(directory, 'channels.json'))
  const { channel } = store.createChannel({
    chatId: 'chat_pending',
    title: 'Pending migration',
    owner: { displayName: 'Host', identityPublicKey: 'host_identity' },
    now: 1_000
  })
  const initialMutations = metadata(store, channel.channelId)
  const initialBase = baseFor({
    planId: INITIAL_PLAN_ID,
    sourceDigest: 'f'.repeat(64),
    migrationAt: 1_100,
    mutations: initialMutations,
    pendingAdmissions: [pending(channel.channelId)]
  })
  const initialHistory = historyFor(initialBase, initialMutations)
  const initial = execution({
    planId: INITIAL_PLAN_ID,
    planDigest: INITIAL_PLAN_DIGEST,
    base: initialBase,
    history: initialHistory
  })
  const initialEscrow = new PeopleToChannelMigrationAdmissionReissue({
    storagePath: join(directory, 'initial-admission-escrow.json'),
    safeStorage,
    channels: store,
    now: () => 1_200,
    randomId,
    randomToken
  }).apply({ base: initialBase, history: initialHistory })

  const terminalMutations = metadata(store, channel.channelId)
  const terminalPending = args.terminalPending ?? true
  const terminalBase = baseFor({
    planId: TERMINAL_PLAN_ID,
    sourceDigest: '1'.repeat(64),
    migrationAt: 2_000,
    mutations: terminalMutations,
    pendingAdmissions: terminalPending
      ? [pending(channel.channelId, contributionRulesForPreset('readOnly'))]
      : []
  })
  const terminalHistory = historyFor(terminalBase, terminalMutations)
  const terminal = finalization({ initial, base: terminalBase, history: terminalHistory })
  const terminalEscrowPath = join(directory, 'terminal-admission-escrow.json')
  const options = {
    storagePath: terminalEscrowPath,
    safeStorage,
    channels: store,
    randomId,
    randomToken
  }
  return {
    directory,
    store,
    initial,
    initialInvitations: initialEscrow.invitations,
    terminal,
    terminalEscrowPath,
    options
  }
}

function initialByPurpose(
  invitations: readonly PeopleToChannelReissuedAdmission[],
  purpose: PeopleToChannelReissuedAdmission['purpose']
): PeopleToChannelReissuedAdmission {
  return invitations.find((invitation) => invitation.purpose === purpose)!
}

describe('PeopleToChannelMigrationFinalizationAdmissions', () => {
  it('rotates pending and open credentials, retires the additive set, and binds terminal policy after restart', () => {
    const built = fixture()
    const finalizer = new PeopleToChannelMigrationFinalizationAdmissions(built.options)
    const result = finalizer.apply({
      initial: built.initial,
      finalization: built.terminal,
      initialInvitations: built.initialInvitations
    })

    expect(result).toMatchObject({
      initialPlanId: INITIAL_PLAN_ID,
      planId: TERMINAL_PLAN_ID,
      retiredInvitationCount: 2,
      invitations: [{ purpose: 'pending-collaborator' }, { purpose: 'open-invite' }]
    })
    expect(result.invitations.map((invitation) => invitation.inviteToken)).not.toEqual(
      built.initialInvitations.map((invitation) => invitation.inviteToken)
    )
    expect(
      built.initialInvitations.every(
        (source) => built.store.getInvite(source.channelId, source.inviteId)?.revokedAt === 2_000
      )
    ).toBe(true)
    expect(
      result.invitations.every(
        (source) =>
          built.store.getInvite(source.channelId, source.inviteId)?.revokedAt === undefined
      )
    ).toBe(true)
    const encrypted = readFileSync(built.terminalEscrowPath, 'utf8')
    expect(encrypted).not.toContain('Pending colleague')
    expect(encrypted).not.toContain('person_pending')
    expect(encrypted).not.toContain(result.invitations[0].inviteToken)

    const recovered = new PeopleToChannelMigrationFinalizationAdmissions(built.options).recover({
      initial: built.initial,
      finalization: built.terminal,
      initialInvitations: built.initialInvitations
    })
    expect(recovered.invitations).toEqual(result.invitations)

    const policies = new ChannelHumanPolicyStore(join(built.directory, 'human-policies.json'))
    const authority = new PeopleToChannelMigrationAdmissionAuthority({
      initialMigrationPlanId: INITIAL_PLAN_ID,
      migrationPlanId: TERMINAL_PLAN_ID,
      invitations: result.invitations
    })
    const pendingInvitation = initialByPurpose(result.invitations, 'pending-collaborator')
    const pending = built.store.beginMemberAdmission({
      channelId: pendingInvitation.channelId,
      inviteId: pendingInvitation.inviteId,
      inviteToken: pendingInvitation.inviteToken,
      roomId: pendingInvitation.roomId,
      displayName: 'Pending colleague',
      identityPublicKey: 'pending_identity',
      now: 2_100
    })
    authority.bind({
      store: built.store,
      policies,
      channelId: pendingInvitation.channelId,
      inviteId: pendingInvitation.inviteId,
      memberId: pending.member.memberId,
      roomId: pending.invite.roomId,
      tokenHash: pending.invite.tokenHash,
      expiresAt: pending.invite.expiresAt
    })
    expect(
      policies.evaluate({
        channelId: pendingInvitation.channelId,
        memberId: pending.member.memberId,
        intent: 'comment',
        contentBytes: 10
      })
    ).toMatchObject({ outcome: 'deny', code: 'read_only' })

    const openInvitation = initialByPurpose(result.invitations, 'open-invite')
    const open = built.store.beginMemberAdmission({
      channelId: openInvitation.channelId,
      inviteId: openInvitation.inviteId,
      inviteToken: openInvitation.inviteToken,
      roomId: openInvitation.roomId,
      displayName: 'Open guest',
      identityPublicKey: 'open_identity',
      now: 2_101
    })
    authority.bind({
      store: built.store,
      policies,
      channelId: openInvitation.channelId,
      inviteId: openInvitation.inviteId,
      memberId: open.member.memberId,
      roomId: open.invite.roomId,
      tokenHash: open.invite.tokenHash,
      expiresAt: open.invite.expiresAt
    })
    expect(
      policies.get(openInvitation.channelId, open.member.memberId)?.sourceCollaboratorId
    ).toMatch(/^migration_open_[a-f0-9]{32}$/)
  })

  it('recovers after the terminal escrow becomes durable before either metadata batch', () => {
    const built = fixture()
    const crashing = new PeopleToChannelMigrationFinalizationAdmissions({
      ...built.options,
      afterStage: (stage) => {
        if (stage === 'terminal_escrow_durable') throw new Error('injected terminal crash')
      }
    })
    expect(() =>
      crashing.apply({
        initial: built.initial,
        finalization: built.terminal,
        initialInvitations: built.initialInvitations
      })
    ).toThrow('injected terminal crash')
    expect(existsSync(built.terminalEscrowPath)).toBe(true)
    expect(
      built.initialInvitations.every(
        (source) =>
          built.store.getInvite(source.channelId, source.inviteId)?.revokedAt === undefined
      )
    ).toBe(true)

    const resumed = new PeopleToChannelMigrationFinalizationAdmissions(built.options).apply({
      initial: built.initial,
      finalization: built.terminal,
      initialInvitations: built.initialInvitations
    })
    expect(resumed.retiredInvitationCount).toBe(2)
    expect(
      resumed.invitations.every(
        (source) =>
          built.store.getInvite(source.channelId, source.inviteId)?.revokedAt === undefined
      )
    ).toBe(true)
  })

  it('recovers a committed escrow across live drift but refuses a usable additive credential', () => {
    const built = fixture()
    const applied = new PeopleToChannelMigrationFinalizationAdmissions(built.options).apply({
      initial: built.initial,
      finalization: built.terminal,
      initialInvitations: built.initialInvitations
    })

    const channelId = applied.channelIds[0]!
    const channel = built.store.getChannel(channelId)!
    built.store.recordCommittedMessage(channelId, channel.messageCount + 1, 9_000)

    const drifted = new PeopleToChannelMigrationFinalizationAdmissions(built.options)
    expect(() =>
      drifted.recover({
        initial: built.initial,
        finalization: built.terminal,
        initialInvitations: built.initialInvitations
      })
    ).toThrow(/not recoverable/)
    expect(
      drifted.recoverCommitted({
        initial: built.initial,
        finalization: built.terminal,
        initialInvitations: built.initialInvitations
      }).invitations
    ).toEqual(applied.invitations)

    const unretired = fixture()
    expect(() =>
      new PeopleToChannelMigrationFinalizationAdmissions({
        ...unretired.options,
        afterStage: (stage) => {
          if (stage === 'terminal_escrow_durable') throw new Error('injected crash')
        }
      }).apply({
        initial: unretired.initial,
        finalization: unretired.terminal,
        initialInvitations: unretired.initialInvitations
      })
    ).toThrow(/injected crash/)
    expect(() =>
      new PeopleToChannelMigrationFinalizationAdmissions(unretired.options).recoverCommitted({
        initial: unretired.initial,
        finalization: unretired.terminal,
        initialInvitations: unretired.initialInvitations
      })
    ).toThrow(/remains usable|in-flight/)
  })

  it('blocks an in-flight additive credential before it mints a terminal replacement', () => {
    const built = fixture()
    const source = initialByPurpose(built.initialInvitations, 'pending-collaborator')
    built.store.beginMemberAdmission({
      channelId: source.channelId,
      inviteId: source.inviteId,
      inviteToken: source.inviteToken,
      roomId: source.roomId,
      displayName: 'Still handshaking',
      identityPublicKey: 'in_flight_identity',
      now: 1_500
    })

    expect(() =>
      new PeopleToChannelMigrationFinalizationAdmissions(built.options).apply({
        initial: built.initial,
        finalization: built.terminal,
        initialInvitations: built.initialInvitations
      })
    ).toThrow(PeopleToChannelMigrationFinalizationAdmissionsError)
    expect(existsSync(built.terminalEscrowPath)).toBe(false)
  })

  it('retires the additive credentials even when the terminal source has no remaining admissions', () => {
    const built = fixture({ terminalPending: false })
    const result = new PeopleToChannelMigrationFinalizationAdmissions(built.options).apply({
      initial: built.initial,
      finalization: built.terminal,
      initialInvitations: built.initialInvitations
    })
    expect(result).toMatchObject({ invitations: [], retiredInvitationCount: 2 })
    expect(existsSync(built.terminalEscrowPath)).toBe(false)
    expect(
      built.initialInvitations.every(
        (source) => built.store.getInvite(source.channelId, source.inviteId)?.revokedAt === 2_000
      )
    ).toBe(true)
    expect(
      new PeopleToChannelMigrationFinalizationAdmissions(built.options).recover({
        initial: built.initial,
        finalization: built.terminal,
        initialInvitations: built.initialInvitations
      }).invitations
    ).toEqual([])
  })
})
