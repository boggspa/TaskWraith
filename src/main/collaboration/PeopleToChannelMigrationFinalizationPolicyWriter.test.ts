import { createHash } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
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
import type { PeopleToChannelMigrationExecution } from './PeopleToChannelMigrationExecutionStore'
import type { PeopleToChannelMigrationFinalizationExecution } from './PeopleToChannelMigrationFinalizationExecutionStore'
import {
  PEOPLE_TO_CHANNEL_HISTORY_MATERIALIZATION_VERSION,
  type PeopleToChannelMigrationHistoryMaterialization
} from './PeopleToChannelMigrationHistory'
import {
  PEOPLE_TO_CHANNEL_MATERIALIZATION_VERSION,
  type PeopleToChannelMigrationMaterialization
} from './PeopleToChannelMigrationMaterializer'
import {
  PEOPLE_TO_CHANNEL_FINALIZATION_POLICY_WRITE_VERSION,
  PeopleToChannelMigrationFinalizationPolicyWriter,
  isPeopleToChannelMigrationFinalizationPolicyWriterError
} from './PeopleToChannelMigrationFinalizationPolicyWriter'

const INITIAL_PLAN_ID = 'a'.repeat(64)
const INITIAL_PLAN_DIGEST = 'b'.repeat(64)
const TERMINAL_PLAN_ID = 'c'.repeat(64)

const temporaryPaths: string[] = []

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'taskwraith-channels-p4-terminal-policy-'))
  temporaryPaths.push(path)
  return path
}

afterEach(() => {
  while (temporaryPaths.length) rmSync(temporaryPaths.pop()!, { recursive: true, force: true })
})

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

function baseFor(args: {
  planId: string
  sourceDigest: string
  migrationAt: number
  metadata: PeopleToChannelMigrationHistoryMaterialization['metadataMutations']
  policies: ChannelHumanMigrationPolicyInput[]
}): PeopleToChannelMigrationMaterialization {
  return sealBase({
    schemaVersion: PEOPLE_TO_CHANNEL_MATERIALIZATION_VERSION,
    planId: args.planId,
    sourceDigest: args.sourceDigest,
    migrationAt: args.migrationAt,
    mutations: args.metadata.map(clone),
    policies: args.policies.map(clone),
    pendingAdmissionReissues: [],
    migratedShareIds: ['share_one'],
    retainedShareIds: [],
    generalChatIds: ['chat_one'],
    backfilledGeneralChatIds: [],
    existingGeneralChatIds: [],
    requirements: ['human_policy_projection']
  })
}

function historyFor(
  base: PeopleToChannelMigrationMaterialization,
  metadata: PeopleToChannelMigrationHistoryMaterialization['metadataMutations']
): PeopleToChannelMigrationHistoryMaterialization {
  return sealHistory({
    schemaVersion: PEOPLE_TO_CHANNEL_HISTORY_MATERIALIZATION_VERSION,
    planId: base.planId,
    sourceDigest: base.sourceDigest,
    baseMaterializationDigest: base.materializationDigest,
    migrationAt: base.migrationAt,
    metadataMutations: metadata.map(clone),
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
  retireShareIds?: string[]
  retainedWorkspaceBootstrapShareIds?: string[]
}): PeopleToChannelMigrationFinalizationExecution {
  return {
    initialPlanId: args.initial.plan.planId,
    initialPlanDigest: args.initial.planDigest,
    scope: {
      schemaVersion: 1,
      retireShareIds: args.retireShareIds ?? ['share_one'],
      retainedWorkspaceBootstrapShareIds: args.retainedWorkspaceBootstrapShareIds ?? []
    },
    delta: execution({
      planId: args.base.planId,
      planDigest: 'e'.repeat(64),
      base: args.base,
      history: args.history
    })
  } as unknown as PeopleToChannelMigrationFinalizationExecution
}

function fixture() {
  const directory = temporaryDirectory()
  const policies = new ChannelHumanPolicyStore(join(directory, 'channels', 'human-policies.json'))
  const channels = new ChannelStore()
  const { channel } = channels.createChannel({
    chatId: 'chat_one',
    owner: { displayName: 'Host', identityPublicKey: 'host_key' },
    title: 'Migrated Channel',
    now: 1_000
  })
  const member = channels.admitMember({
    channelId: channel.channelId,
    displayName: 'Collaborator',
    identityPublicKey: 'collaborator_key',
    roomId: 'room_one',
    now: 1_100
  })
  const current = channels.getChannel(channel.channelId)!
  const metadata = [
    {
      mode: 'merge' as const,
      beforeDigest: channelStoreSubsetDigest(
        current,
        channels.listMembers(current.channelId),
        channels.listInvites(current.channelId)
      ),
      channel: current,
      members: channels.listMembers(current.channelId),
      invites: channels.listInvites(current.channelId)
    }
  ]
  const initialPolicy: ChannelHumanMigrationPolicyInput = {
    channelId: current.channelId,
    memberId: member.memberId,
    sourceShareId: 'share_one',
    sourceCollaboratorId: 'collaborator_one',
    sourceDigest: 'd'.repeat(64),
    rules: {
      ...contributionRulesForPreset('comments'),
      maxContributionBytes: 500
    },
    requiresHostApproval: false,
    fullHistory: false
  }
  const initialBase = baseFor({
    planId: INITIAL_PLAN_ID,
    sourceDigest: 'f'.repeat(64),
    migrationAt: 1_000,
    metadata,
    policies: [initialPolicy]
  })
  const initialHistory = historyFor(initialBase, metadata)
  const initial = execution({
    planId: INITIAL_PLAN_ID,
    planDigest: INITIAL_PLAN_DIGEST,
    base: initialBase,
    history: initialHistory
  })
  policies.applyMigrationPolicies({
    migrationPlanId: INITIAL_PLAN_ID,
    policies: [initialPolicy],
    now: 1_200
  })
  return { directory, policies, initial, initialPolicy, metadata, member }
}

function writer(policies: ChannelHumanPolicyStore, now = 2_000) {
  return new PeopleToChannelMigrationFinalizationPolicyWriter({ policies, now: () => now })
}

function expectRecoveryBlocked(action: () => unknown): void {
  let error: unknown
  try {
    action()
  } catch (caught) {
    error = caught
  }
  expect(isPeopleToChannelMigrationFinalizationPolicyWriterError(error)).toBe(true)
}

describe('PeopleToChannelMigrationFinalizationPolicyWriter', () => {
  it('updates a frozen migrated policy and recovers byte-identically after restart', () => {
    const built = fixture()
    const terminalPolicy: ChannelHumanMigrationPolicyInput = {
      ...built.initialPolicy,
      sourceDigest: '1'.repeat(64),
      rules: contributionRulesForPreset('readOnly'),
      requiresHostApproval: true,
      fullHistory: true
    }
    const terminalBase = baseFor({
      planId: TERMINAL_PLAN_ID,
      sourceDigest: '2'.repeat(64),
      migrationAt: 2_000,
      metadata: built.metadata,
      policies: [terminalPolicy]
    })
    const terminalHistory = historyFor(terminalBase, built.metadata)
    const terminal = finalization({
      initial: built.initial,
      base: terminalBase,
      history: terminalHistory
    })

    const first = writer(built.policies).apply({ initial: built.initial, finalization: terminal })
    expect(first).toMatchObject({
      schemaVersion: PEOPLE_TO_CHANNEL_FINALIZATION_POLICY_WRITE_VERSION,
      initialPlanId: INITIAL_PLAN_ID,
      planId: TERMINAL_PLAN_ID,
      policyCount: 1,
      newPolicyCount: 0,
      updatedPolicyCount: 1,
      policiesApplied: true,
      records: [
        {
          migrationPlanId: TERMINAL_PLAN_ID,
          sourceDigest: terminalPolicy.sourceDigest,
          rules: terminalPolicy.rules,
          requiresHostApproval: true,
          fullHistory: true,
          createdAt: 1_200,
          updatedAt: 2_000
        }
      ]
    })
    expect(
      built.policies.evaluate({
        channelId: terminalPolicy.channelId,
        memberId: terminalPolicy.memberId,
        intent: 'comment',
        contentBytes: 10
      })
    ).toMatchObject({ outcome: 'deny', code: 'read_only' })

    const policyPath = join(built.directory, 'channels', 'human-policies.json')
    const before = readFileSync(policyPath)
    expect(
      writer(built.policies, 3_000).apply({ initial: built.initial, finalization: terminal })
    ).toEqual({
      ...first,
      newPolicyCount: 0,
      updatedPolicyCount: 0,
      policiesApplied: false
    })
    expect(readFileSync(policyPath)).toEqual(before)
  })

  it('adds a newly migrated active human without replacing unrelated policy authority', () => {
    const built = fixture()
    const second = {
      ...built.member,
      memberId: 'member_two',
      identityPublicKey: 'collaborator_two_key',
      roomId: 'room_two',
      displayName: 'Second collaborator'
    }
    const terminalMetadata = built.metadata.map(clone)
    terminalMetadata[0].members.push(second)
    terminalMetadata[0].channel = {
      ...terminalMetadata[0].channel,
      membershipRevision: terminalMetadata[0].channel.membershipRevision + 1,
      updatedAt: 2_000,
      display: {
        ...terminalMetadata[0].channel.display,
        memberCount: terminalMetadata[0].channel.display.memberCount + 1
      }
    }
    const terminalPolicies: ChannelHumanMigrationPolicyInput[] = [
      built.initialPolicy,
      {
        ...built.initialPolicy,
        memberId: second.memberId,
        sourceCollaboratorId: 'collaborator_two',
        sourceDigest: built.initialPolicy.sourceDigest
      }
    ]
    const terminalBase = baseFor({
      planId: TERMINAL_PLAN_ID,
      sourceDigest: '4'.repeat(64),
      migrationAt: 2_000,
      metadata: terminalMetadata,
      policies: terminalPolicies
    })
    const terminal = finalization({
      initial: built.initial,
      base: terminalBase,
      history: historyFor(terminalBase, terminalMetadata)
    })

    const result = writer(built.policies).apply({ initial: built.initial, finalization: terminal })
    expect(result).toMatchObject({ newPolicyCount: 1, updatedPolicyCount: 1, policyCount: 2 })
    expect(built.policies.get(terminalPolicies[1].channelId, second.memberId)).toMatchObject({
      migrationPlanId: TERMINAL_PLAN_ID,
      sourceCollaboratorId: 'collaborator_two'
    })
  })

  it('fails closed before writing for policy removal, P5 scope, and missing durable authority', () => {
    const missing = fixture()
    const noPoliciesBase = baseFor({
      planId: TERMINAL_PLAN_ID,
      sourceDigest: '5'.repeat(64),
      migrationAt: 2_000,
      metadata: missing.metadata,
      policies: []
    })
    expectRecoveryBlocked(() =>
      writer(missing.policies).apply({
        initial: missing.initial,
        finalization: finalization({
          initial: missing.initial,
          base: noPoliciesBase,
          history: historyFor(noPoliciesBase, missing.metadata)
        })
      })
    )

    const p5 = fixture()
    const p5Base = baseFor({
      planId: TERMINAL_PLAN_ID,
      sourceDigest: '6'.repeat(64),
      migrationAt: 2_000,
      metadata: p5.metadata,
      policies: [p5.initialPolicy]
    })
    expectRecoveryBlocked(() =>
      writer(p5.policies).apply({
        initial: p5.initial,
        finalization: finalization({
          initial: p5.initial,
          base: p5Base,
          history: historyFor(p5Base, p5.metadata),
          retireShareIds: [],
          retainedWorkspaceBootstrapShareIds: ['share_one']
        })
      })
    )

    const lost = fixture()
    const lostPath = join(lost.directory, 'channels', 'human-policies.json')
    rmSync(lostPath)
    const restarted = new ChannelHumanPolicyStore(lostPath)
    const lostBase = baseFor({
      planId: TERMINAL_PLAN_ID,
      sourceDigest: '7'.repeat(64),
      migrationAt: 2_000,
      metadata: lost.metadata,
      policies: [lost.initialPolicy]
    })
    expectRecoveryBlocked(() =>
      writer(restarted).apply({
        initial: lost.initial,
        finalization: finalization({
          initial: lost.initial,
          base: lostBase,
          history: historyFor(lostBase, lost.metadata)
        })
      })
    )
    expect(existsSync(lostPath)).toBe(false)
  })
})
