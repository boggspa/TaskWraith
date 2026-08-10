import { createHash } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ChannelHumanPolicyStore,
  type ChannelHumanMigrationPolicyInput
} from './ChannelHumanPolicyStore'
import { contributionRulesForPreset } from './HumanContributionRules'
import { ChannelStore } from './ChannelStore'
import { channelStoreSubsetDigest } from './ChannelStoreSubsetDigest'
import {
  PEOPLE_TO_CHANNEL_HISTORY_MATERIALIZATION_VERSION,
  type PeopleToChannelMigrationHistoryMaterialization
} from './PeopleToChannelMigrationHistory'
import {
  PEOPLE_TO_CHANNEL_MATERIALIZATION_VERSION,
  type PeopleToChannelMigrationMaterialization
} from './PeopleToChannelMigrationMaterializer'
import {
  PEOPLE_TO_CHANNEL_POLICY_WRITE_VERSION,
  PeopleToChannelMigrationPolicyWriter,
  isPeopleToChannelMigrationPolicyWriterError
} from './PeopleToChannelMigrationPolicyWriter'

const temporaryPaths: string[] = []

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'taskwraith-channels-p4-policy-writer-'))
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

function rebindHistory(
  history: PeopleToChannelMigrationHistoryMaterialization,
  base: PeopleToChannelMigrationMaterialization
): PeopleToChannelMigrationHistoryMaterialization {
  const { executionDigest: _digest, ...draft } = clone(history)
  draft.baseMaterializationDigest = base.materializationDigest
  return sealHistory(draft)
}

function fixture(args: { activePolicy?: boolean; pending?: boolean } = {}) {
  const directory = temporaryDirectory()
  const policyPath = join(directory, 'channels', 'human-policies.json')
  const channels = new ChannelStore()
  const { channel: created, owner } = channels.createChannel({
    chatId: 'chat_one',
    owner: { displayName: 'Host', identityPublicKey: 'host_key' },
    title: 'Migrated Channel',
    now: 1_000
  })
  const activePolicy = args.activePolicy ?? true
  const pending = args.pending ?? true
  const member = activePolicy
    ? channels.admitMember({
        channelId: created.channelId,
        displayName: 'Collaborator',
        identityPublicKey: 'collaborator_key',
        roomId: 'room_active',
        now: 1_100
      })
    : null
  const channel = channels.getChannel(created.channelId)!
  const members = channels.listMembers(channel.channelId)
  const invites = channels.listInvites(channel.channelId)
  const metadataMutation = {
    mode: 'merge' as const,
    beforeDigest: channelStoreSubsetDigest(channel, members, invites),
    channel,
    members,
    invites
  }
  const authority = {
    sourceDigest: 'c'.repeat(64),
    rules: {
      ...contributionRulesForPreset('comments'),
      maxContributionBytes: 500
    },
    requiresHostApproval: true,
    fullHistory: true
  }
  const policy: ChannelHumanMigrationPolicyInput | null = member
    ? {
        channelId: channel.channelId,
        memberId: member.memberId,
        sourceShareId: 'share_one',
        sourceCollaboratorId: 'collaborator_one',
        ...clone(authority)
      }
    : null
  const base = sealBase({
    schemaVersion: PEOPLE_TO_CHANNEL_MATERIALIZATION_VERSION,
    planId: 'a'.repeat(64),
    sourceDigest: 'b'.repeat(64),
    migrationAt: 1_000,
    mutations: [clone(metadataMutation)],
    policies: policy ? [policy] : [],
    pendingAdmissionReissues: pending
      ? [
          {
            sourceShareId: 'share_one',
            channelId: channel.channelId,
            pendingCollaboratorIds: ['collaborator_pending'],
            openInviteCount: 1,
            policy: clone(authority)
          }
        ]
      : [],
    migratedShareIds: ['share_one'],
    retainedShareIds: [],
    generalChatIds: ['chat_one'],
    backfilledGeneralChatIds: [],
    existingGeneralChatIds: [],
    requirements: [
      'human_policy_projection',
      ...(pending ? (['pending_admission_reissue'] as const) : [])
    ]
  })
  const history = sealHistory({
    schemaVersion: PEOPLE_TO_CHANNEL_HISTORY_MATERIALIZATION_VERSION,
    planId: base.planId,
    sourceDigest: base.sourceDigest,
    baseMaterializationDigest: base.materializationDigest,
    migrationAt: base.migrationAt,
    metadataMutations: [clone(metadataMutation)],
    logMutations: [],
    importedContributionCount: 0
  })
  const policies = new ChannelHumanPolicyStore(policyPath)
  return {
    directory,
    policyPath,
    policies,
    channel,
    owner,
    member,
    base,
    history
  }
}

function writer(
  built: ReturnType<typeof fixture>,
  now = 2_000
): PeopleToChannelMigrationPolicyWriter {
  return new PeopleToChannelMigrationPolicyWriter({ policies: built.policies, now: () => now })
}

function expectRecoveryBlocked(action: () => unknown): void {
  let error: unknown
  try {
    action()
  } catch (caught) {
    error = caught
  }
  expect(isPeopleToChannelMigrationPolicyWriterError(error)).toBe(true)
}

describe('PeopleToChannelMigrationPolicyWriter', () => {
  it('persists exact active-human authority once and reruns byte-identically', () => {
    const built = fixture()
    const first = writer(built).apply({ base: built.base, history: built.history })

    expect(first).toMatchObject({
      schemaVersion: PEOPLE_TO_CHANNEL_POLICY_WRITE_VERSION,
      planId: built.base.planId,
      baseMaterializationDigest: built.base.materializationDigest,
      policyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      policyCount: 1,
      newPolicyCount: 1,
      policiesApplied: true,
      records: [
        {
          sourceShareId: 'share_one',
          sourceCollaboratorId: 'collaborator_one',
          createdAt: 2_000,
          updatedAt: 2_000
        }
      ]
    })
    expect(statSync(built.policyPath).mode & 0o777).toBe(0o600)
    expect(
      built.policies.evaluate({
        channelId: built.channel.channelId,
        memberId: built.member!.memberId,
        intent: 'comment',
        contentBytes: 501
      })
    ).toMatchObject({ outcome: 'deny', code: 'quota_exceeded' })

    const before = readFileSync(built.policyPath)
    const rerun = writer(built, 3_000).apply({ base: built.base, history: built.history })
    expect(rerun).toEqual({
      ...first,
      newPolicyCount: 0,
      policiesApplied: false
    })
    expect(readFileSync(built.policyPath)).toEqual(before)
  })

  it('preserves unrelated durable policy records', () => {
    const built = fixture()
    const unrelated = built.policies.applyMigrationPolicies({
      migrationPlanId: 'f'.repeat(64),
      now: 500,
      policies: [
        {
          channelId: 'other_channel',
          memberId: 'other_member',
          sourceShareId: 'other_share',
          sourceCollaboratorId: 'other_collaborator',
          sourceDigest: 'e'.repeat(64),
          rules: contributionRulesForPreset('readOnly'),
          requiresHostApproval: false,
          fullHistory: false
        }
      ]
    })[0]

    writer(built).apply({ base: built.base, history: built.history })
    expect(built.policies.get('other_channel', 'other_member')).toEqual(unrelated)
    expect(built.policies.list()).toHaveLength(2)
  })

  it('rejects missing, owner, and revoked policy targets before persistence', () => {
    const missing = fixture({ pending: false })
    const { materializationDigest: _missingDigest, ...missingDraft } = clone(missing.base)
    missingDraft.policies[0].memberId = 'missing_member'
    const missingBase = sealBase(missingDraft)
    expectRecoveryBlocked(() =>
      writer(missing).apply({
        base: missingBase,
        history: rebindHistory(missing.history, missingBase)
      })
    )
    expect(existsSync(missing.policyPath)).toBe(false)

    const owner = fixture({ pending: false })
    const { materializationDigest: _ownerDigest, ...ownerDraft } = clone(owner.base)
    ownerDraft.policies[0].memberId = owner.owner.memberId
    const ownerBase = sealBase(ownerDraft)
    expectRecoveryBlocked(() =>
      writer(owner).apply({ base: ownerBase, history: rebindHistory(owner.history, ownerBase) })
    )
    expect(existsSync(owner.policyPath)).toBe(false)

    const revoked = fixture({ pending: false })
    const { executionDigest: _historyDigest, ...revokedHistoryDraft } = clone(revoked.history)
    const target = revokedHistoryDraft.metadataMutations[0].members.find(
      (member) => member.memberId === revoked.member!.memberId
    )!
    target.status = 'revoked'
    target.revokedAt = 1_500
    const revokedHistory = sealHistory(revokedHistoryDraft)
    expectRecoveryBlocked(() =>
      writer(revoked).apply({ base: revoked.base, history: revokedHistory })
    )
    expect(existsSync(revoked.policyPath)).toBe(false)
  })

  it('rejects active and pending authority drift before writing either policy', () => {
    const built = fixture()
    const { materializationDigest: _digest, ...draft } = clone(built.base)
    draft.pendingAdmissionReissues[0].policy.rules = contributionRulesForPreset('readOnly')
    const changed = sealBase(draft)

    expectRecoveryBlocked(() =>
      writer(built).apply({ base: changed, history: rebindHistory(built.history, changed) })
    )
    expect(existsSync(built.policyPath)).toBe(false)
  })

  it('leaves a conflicting durable policy byte-identical and recovery-blocked', () => {
    const built = fixture()
    built.policies.applyMigrationPolicies({
      migrationPlanId: 'f'.repeat(64),
      policies: built.base.policies,
      now: 500
    })
    const before = readFileSync(built.policyPath)

    expectRecoveryBlocked(() => writer(built).apply({ base: built.base, history: built.history }))
    expect(readFileSync(built.policyPath)).toEqual(before)
  })

  it('requires no policy file for an owner-only Channel with pending admissions', () => {
    const built = fixture({ activePolicy: false, pending: true })
    const result = writer(built).apply({ base: built.base, history: built.history })

    expect(result).toMatchObject({
      policyCount: 0,
      newPolicyCount: 0,
      policiesApplied: false,
      records: []
    })
    expect(existsSync(built.policyPath)).toBe(false)
  })
})
