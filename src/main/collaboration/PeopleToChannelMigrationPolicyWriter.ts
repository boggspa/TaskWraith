import { createHash } from 'crypto'

import {
  ChannelHumanPolicyError,
  ChannelHumanPolicyStore,
  type ChannelHumanMigrationPolicyInput,
  type ChannelHumanPolicyRecord
} from './ChannelHumanPolicyStore'
import {
  PEOPLE_TO_CHANNEL_HISTORY_MATERIALIZATION_VERSION,
  type PeopleToChannelMigrationHistoryMaterialization
} from './PeopleToChannelMigrationHistory'
import {
  PEOPLE_TO_CHANNEL_MATERIALIZATION_VERSION,
  type PeopleToChannelMigrationMaterialization,
  type PeopleToChannelPendingAdmissionPolicy
} from './PeopleToChannelMigrationMaterializer'

export const PEOPLE_TO_CHANNEL_POLICY_WRITE_VERSION = 1

export interface PeopleToChannelMigrationPolicyWriteResult {
  schemaVersion: typeof PEOPLE_TO_CHANNEL_POLICY_WRITE_VERSION
  planId: string
  baseMaterializationDigest: string
  policyDigest: string
  policyCount: number
  newPolicyCount: number
  policiesApplied: boolean
  records: ChannelHumanPolicyRecord[]
}

export interface PeopleToChannelMigrationPolicyWriterOptions {
  policies: ChannelHumanPolicyStore
  now?: () => number
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/

export class PeopleToChannelMigrationPolicyWriterError extends Error {
  readonly code = 'recovery_blocked'

  constructor(message: string) {
    super(message)
    this.name = 'PeopleToChannelMigrationPolicyWriterError'
  }
}

function blocked(message: string): never {
  throw new PeopleToChannelMigrationPolicyWriterError(message)
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

function materializationDigest(materialization: PeopleToChannelMigrationMaterialization): string {
  const { materializationDigest: _recorded, ...withoutDigest } = materialization
  return sha256(canonicalJson(withoutDigest))
}

function historyExecutionDigest(history: PeopleToChannelMigrationHistoryMaterialization): string {
  const { executionDigest: _recorded, ...withoutDigest } = history
  return sha256(canonicalJson(withoutDigest))
}

function validateInputs(args: {
  base: PeopleToChannelMigrationMaterialization
  history: PeopleToChannelMigrationHistoryMaterialization
}): void {
  const { base, history } = args
  if (
    base.schemaVersion !== PEOPLE_TO_CHANNEL_MATERIALIZATION_VERSION ||
    history.schemaVersion !== PEOPLE_TO_CHANNEL_HISTORY_MATERIALIZATION_VERSION ||
    !SHA256_PATTERN.test(base.planId) ||
    !SHA256_PATTERN.test(base.sourceDigest) ||
    !SHA256_PATTERN.test(base.materializationDigest) ||
    materializationDigest(base) !== base.materializationDigest ||
    !SHA256_PATTERN.test(history.executionDigest) ||
    historyExecutionDigest(history) !== history.executionDigest ||
    history.planId !== base.planId ||
    history.sourceDigest !== base.sourceDigest ||
    history.baseMaterializationDigest !== base.materializationDigest ||
    !Array.isArray(base.policies) ||
    !Array.isArray(base.migratedShareIds) ||
    !Array.isArray(base.pendingAdmissionReissues) ||
    !Array.isArray(history.metadataMutations)
  ) {
    blocked('People migration policy inputs do not match')
  }
}

function policyAuthority(
  policy: ChannelHumanMigrationPolicyInput | PeopleToChannelPendingAdmissionPolicy
): unknown {
  return {
    sourceDigest: policy.sourceDigest,
    rules: policy.rules,
    requiresHostApproval: policy.requiresHostApproval,
    fullHistory: policy.fullHistory
  }
}

function policiesFor(args: {
  base: PeopleToChannelMigrationMaterialization
  history: PeopleToChannelMigrationHistoryMaterialization
}): ChannelHumanMigrationPolicyInput[] {
  const metadataByChannel = new Map(
    args.history.metadataMutations.map(
      (mutation) => [mutation.channel.channelId, mutation] as const
    )
  )
  if (metadataByChannel.size !== args.history.metadataMutations.length) {
    blocked('People migration policy metadata target is duplicated')
  }
  const migratedShareIds = new Set(args.base.migratedShareIds)
  if (migratedShareIds.size !== args.base.migratedShareIds.length) {
    blocked('People migration policy share manifest is duplicated')
  }
  const memberKeys = new Set<string>()
  const sourceKeys = new Set<string>()
  const channelByShare = new Map<string, string>()
  const authorityByShare = new Map<string, string>()
  const policies = [...args.base.policies].sort((left, right) =>
    compareText(
      `${left.channelId}\u0000${left.memberId}`,
      `${right.channelId}\u0000${right.memberId}`
    )
  )

  for (const policy of policies) {
    const memberKey = `${policy.channelId}\u0000${policy.memberId}`
    const sourceKey = JSON.stringify([policy.sourceShareId, policy.sourceCollaboratorId])
    const metadata = metadataByChannel.get(policy.channelId)
    const member = metadata?.members.find((candidate) => candidate.memberId === policy.memberId)
    if (
      memberKeys.has(memberKey) ||
      sourceKeys.has(sourceKey) ||
      !migratedShareIds.has(policy.sourceShareId) ||
      !metadata ||
      metadata.channel.status !== 'active' ||
      !member ||
      member.kind !== 'human' ||
      member.status !== 'active' ||
      member.memberId === metadata.channel.ownerMemberId
    ) {
      blocked('People migration policy target is not an active migrated human')
    }
    memberKeys.add(memberKey)
    sourceKeys.add(sourceKey)
    const priorChannel = channelByShare.get(policy.sourceShareId)
    if (priorChannel && priorChannel !== policy.channelId) {
      blocked('People migration policy share targets more than one Channel')
    }
    channelByShare.set(policy.sourceShareId, policy.channelId)
    const authority = canonicalJson(policyAuthority(policy))
    const priorAuthority = authorityByShare.get(policy.sourceShareId)
    if (priorAuthority && priorAuthority !== authority) {
      blocked('People migration policy authority diverges within one share')
    }
    authorityByShare.set(policy.sourceShareId, authority)
  }

  const pendingShares = new Set<string>()
  for (const pending of args.base.pendingAdmissionReissues) {
    if (pendingShares.has(pending.sourceShareId)) {
      blocked('People migration pending policy share is duplicated')
    }
    pendingShares.add(pending.sourceShareId)
    const activeAuthority = authorityByShare.get(pending.sourceShareId)
    if (
      activeAuthority &&
      (channelByShare.get(pending.sourceShareId) !== pending.channelId ||
        activeAuthority !== canonicalJson(policyAuthority(pending.policy)))
    ) {
      blocked('People migration pending and active policy authority diverge')
    }
  }

  return policies.map(clone)
}

function policyDigest(
  planId: string,
  baseMaterializationDigest: string,
  policies: readonly ChannelHumanMigrationPolicyInput[]
): string {
  return sha256(canonicalJson({ planId, baseMaterializationDigest, policies }))
}

/**
 * Persists active migrated-human policy authority before Channel metadata can
 * expose those members. Pending admissions retain the same authority in their
 * encrypted reissue escrow until a concrete member id exists.
 */
export class PeopleToChannelMigrationPolicyWriter {
  private readonly now: () => number

  constructor(private readonly options: PeopleToChannelMigrationPolicyWriterOptions) {
    this.now = options.now ?? Date.now
  }

  apply(args: {
    base: PeopleToChannelMigrationMaterialization
    history: PeopleToChannelMigrationHistoryMaterialization
  }): PeopleToChannelMigrationPolicyWriteResult {
    validateInputs(args)
    const policies = policiesFor(args)
    const beforeKeys = new Set(
      this.options.policies.list().map((record) => `${record.channelId}\u0000${record.memberId}`)
    )
    const newPolicyCount = policies.filter(
      (policy) => !beforeKeys.has(`${policy.channelId}\u0000${policy.memberId}`)
    ).length
    const records = this.options.policies.applyMigrationPolicies({
      migrationPlanId: args.base.planId,
      policies,
      now: this.now()
    })
    if (records.length !== policies.length) {
      blocked('People migration policy store returned an incomplete batch')
    }
    return {
      schemaVersion: PEOPLE_TO_CHANNEL_POLICY_WRITE_VERSION,
      planId: args.base.planId,
      baseMaterializationDigest: args.base.materializationDigest,
      policyDigest: policyDigest(args.base.planId, args.base.materializationDigest, policies),
      policyCount: policies.length,
      newPolicyCount,
      policiesApplied: newPolicyCount > 0,
      records: records.map(clone)
    }
  }
}

export function isPeopleToChannelMigrationPolicyWriterError(
  error: unknown
): error is PeopleToChannelMigrationPolicyWriterError | ChannelHumanPolicyError {
  return (
    (error instanceof PeopleToChannelMigrationPolicyWriterError ||
      error instanceof ChannelHumanPolicyError) &&
    error.code === 'recovery_blocked'
  )
}
