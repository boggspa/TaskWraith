import { createHash } from 'crypto'

import {
  ChannelHumanPolicyError,
  ChannelHumanPolicyStore,
  type ChannelHumanMigrationPolicyInput,
  type ChannelHumanPolicyRecord
} from './ChannelHumanPolicyStore'
import type { PeopleToChannelMigrationExecution } from './PeopleToChannelMigrationExecutionStore'
import type { PeopleToChannelMigrationFinalizationExecution } from './PeopleToChannelMigrationFinalizationExecutionStore'
import {
  PEOPLE_TO_CHANNEL_HISTORY_MATERIALIZATION_VERSION,
  type PeopleToChannelMigrationHistoryMaterialization
} from './PeopleToChannelMigrationHistory'
import {
  PEOPLE_TO_CHANNEL_MATERIALIZATION_VERSION,
  type PeopleToChannelMigrationMaterialization,
  type PeopleToChannelPendingAdmissionReissue
} from './PeopleToChannelMigrationMaterializer'
import { validatePeopleToChannelMigrationFinalizationScope } from './PeopleToChannelMigrationFinalizationScope'

export const PEOPLE_TO_CHANNEL_FINALIZATION_POLICY_WRITE_VERSION = 1

export interface PeopleToChannelMigrationFinalizationPolicyWriteResult {
  schemaVersion: typeof PEOPLE_TO_CHANNEL_FINALIZATION_POLICY_WRITE_VERSION
  initialPlanId: string
  planId: string
  baseMaterializationDigest: string
  policyDigest: string
  policyCount: number
  newPolicyCount: number
  updatedPolicyCount: number
  policiesApplied: boolean
  records: ChannelHumanPolicyRecord[]
}

export interface PeopleToChannelMigrationFinalizationPolicyWriterOptions {
  policies: ChannelHumanPolicyStore
  now?: () => number
}

export class PeopleToChannelMigrationFinalizationPolicyWriterError extends Error {
  readonly code = 'recovery_blocked'

  constructor(message: string) {
    super(message)
    this.name = 'PeopleToChannelMigrationFinalizationPolicyWriterError'
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/

function blocked(message: string): never {
  throw new PeopleToChannelMigrationFinalizationPolicyWriterError(message)
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
    blocked('People migration terminal policy inputs do not match')
  }
}

function policyAuthority(
  policy: ChannelHumanMigrationPolicyInput | PeopleToChannelPendingAdmissionReissue['policy']
): unknown {
  return {
    rules: policy.rules,
    requiresHostApproval: policy.requiresHostApproval,
    fullHistory: policy.fullHistory
  }
}

function policyIdentity(
  value: ChannelHumanMigrationPolicyInput | ChannelHumanPolicyRecord
): unknown {
  return {
    channelId: value.channelId,
    memberId: value.memberId,
    sourceShareId: value.sourceShareId,
    sourceCollaboratorId: value.sourceCollaboratorId,
    sourceDigest: value.sourceDigest,
    rules: value.rules,
    requiresHostApproval: value.requiresHostApproval,
    fullHistory: value.fullHistory
  }
}

function policyKey(
  value: Pick<ChannelHumanMigrationPolicyInput, 'channelId' | 'memberId'>
): string {
  return `${value.channelId}\u0000${value.memberId}`
}

function policiesFor(args: {
  base: PeopleToChannelMigrationMaterialization
  history: PeopleToChannelMigrationHistoryMaterialization
  retireShareIds: readonly string[]
}): ChannelHumanMigrationPolicyInput[] {
  const metadataByChannel = new Map(
    args.history.metadataMutations.map(
      (mutation) => [mutation.channel.channelId, mutation] as const
    )
  )
  if (metadataByChannel.size !== args.history.metadataMutations.length) {
    blocked('People migration terminal policy metadata target is duplicated')
  }
  const migratedShareIds = new Set(args.base.migratedShareIds)
  const retiredShareIds = new Set(args.retireShareIds)
  if (
    migratedShareIds.size !== args.base.migratedShareIds.length ||
    retiredShareIds.size !== args.retireShareIds.length
  ) {
    blocked('People migration terminal policy share manifest is duplicated')
  }

  const memberKeys = new Set<string>()
  const sourceKeys = new Set<string>()
  const channelByShare = new Map<string, string>()
  const authorityByShare = new Map<string, string>()
  const policies = [...args.base.policies].sort((left, right) =>
    compareText(policyKey(left), policyKey(right))
  )
  for (const policy of policies) {
    const memberKey = policyKey(policy)
    const sourceKey = `${policy.sourceShareId}\u0000${policy.sourceCollaboratorId}`
    const metadata = metadataByChannel.get(policy.channelId)
    const member = metadata?.members.find((candidate) => candidate.memberId === policy.memberId)
    if (
      memberKeys.has(memberKey) ||
      sourceKeys.has(sourceKey) ||
      !migratedShareIds.has(policy.sourceShareId) ||
      !retiredShareIds.has(policy.sourceShareId) ||
      !metadata ||
      metadata.channel.status !== 'active' ||
      !member ||
      member.kind !== 'human' ||
      member.status !== 'active' ||
      member.memberId === metadata.channel.ownerMemberId
    ) {
      blocked('People migration terminal policy target is not an active retired-scope human')
    }
    memberKeys.add(memberKey)
    sourceKeys.add(sourceKey)
    const priorChannel = channelByShare.get(policy.sourceShareId)
    if (priorChannel && priorChannel !== policy.channelId) {
      blocked('People migration terminal policy share targets more than one Channel')
    }
    channelByShare.set(policy.sourceShareId, policy.channelId)
    const authority = canonicalJson(policyAuthority(policy))
    const priorAuthority = authorityByShare.get(policy.sourceShareId)
    if (priorAuthority && priorAuthority !== authority) {
      blocked('People migration terminal policy authority diverges within one share')
    }
    authorityByShare.set(policy.sourceShareId, authority)
  }

  const pendingShares = new Set<string>()
  for (const pending of args.base.pendingAdmissionReissues) {
    if (pendingShares.has(pending.sourceShareId)) {
      blocked('People migration terminal pending policy share is duplicated')
    }
    pendingShares.add(pending.sourceShareId)
    const activeAuthority = authorityByShare.get(pending.sourceShareId)
    if (
      activeAuthority &&
      (channelByShare.get(pending.sourceShareId) !== pending.channelId ||
        activeAuthority !== canonicalJson(policyAuthority(pending.policy)))
    ) {
      blocked('People migration terminal pending and active policy authority diverge')
    }
  }
  return policies.map(clone)
}

function policyDigest(
  initialPlanId: string,
  planId: string,
  baseMaterializationDigest: string,
  policies: readonly ChannelHumanMigrationPolicyInput[]
): string {
  return sha256(canonicalJson({ initialPlanId, planId, baseMaterializationDigest, policies }))
}

function assertNoPolicyRemoval(args: {
  initial: PeopleToChannelMigrationExecution
  nextPolicies: readonly ChannelHumanMigrationPolicyInput[]
}): void {
  const nextKeys = new Set(args.nextPolicies.map(policyKey))
  if (args.initial.base.policies.some((policy) => !nextKeys.has(policyKey(policy)))) {
    blocked('People migration terminal policy removal requires member retirement reconciliation')
  }
}

function assertDurableCoverage(args: {
  policies: ChannelHumanPolicyStore
  initialPlanId: string
  planId: string
  initialPolicies: readonly ChannelHumanMigrationPolicyInput[]
  nextPolicies: readonly ChannelHumanMigrationPolicyInput[]
}): void {
  const initialByKey = new Map(args.initialPolicies.map((policy) => [policyKey(policy), policy]))
  for (const next of args.nextPolicies) {
    const prior = initialByKey.get(policyKey(next))
    const durable = args.policies.get(next.channelId, next.memberId)
    if (!prior) {
      if (
        durable &&
        (durable.migrationPlanId !== args.planId ||
          canonicalJson(policyIdentity(durable)) !== canonicalJson(policyIdentity(next)))
      ) {
        blocked('People migration terminal policy conflicts with durable authority')
      }
      continue
    }
    if (!durable) {
      blocked('People migration terminal policy is missing from durable authority')
    }
    const matchesInitial =
      durable.migrationPlanId === args.initialPlanId &&
      canonicalJson(policyIdentity(durable)) === canonicalJson(policyIdentity(prior))
    const matchesFinal =
      durable.migrationPlanId === args.planId &&
      canonicalJson(policyIdentity(durable)) === canonicalJson(policyIdentity(next))
    if (!matchesInitial && !matchesFinal) {
      blocked('People migration terminal policy conflicts with durable authority')
    }
  }
}

/**
 * Reconciles a fenced final policy inventory before its matching Channel
 * metadata is exposed. A terminal execution may add active people or narrow a
 * migrated rule, but it cannot erase/move an existing policy without the
 * separate member-retirement authority.
 */
export class PeopleToChannelMigrationFinalizationPolicyWriter {
  private readonly now: () => number

  constructor(private readonly options: PeopleToChannelMigrationFinalizationPolicyWriterOptions) {
    this.now = options.now ?? Date.now
  }

  apply(args: {
    initial: PeopleToChannelMigrationExecution
    finalization: PeopleToChannelMigrationFinalizationExecution
  }): PeopleToChannelMigrationFinalizationPolicyWriteResult {
    const { initial, finalization } = args
    validateInputs({ base: initial.base, history: initial.history })
    validateInputs({ base: finalization.delta.base, history: finalization.delta.history })
    const scope = validatePeopleToChannelMigrationFinalizationScope(finalization.scope)
    if (
      !SHA256_PATTERN.test(initial.plan.planId) ||
      !SHA256_PATTERN.test(initial.planDigest) ||
      !SHA256_PATTERN.test(finalization.initialPlanId) ||
      !SHA256_PATTERN.test(finalization.initialPlanDigest) ||
      finalization.initialPlanId !== initial.plan.planId ||
      finalization.initialPlanDigest !== initial.planDigest ||
      initial.base.planId !== initial.plan.planId ||
      finalization.delta.base.planId !== finalization.delta.plan.planId
    ) {
      blocked('People migration terminal policy does not match its initial authority')
    }

    const policies = policiesFor({
      base: finalization.delta.base,
      history: finalization.delta.history,
      retireShareIds: scope.retireShareIds
    })
    assertNoPolicyRemoval({ initial, nextPolicies: policies })
    assertDurableCoverage({
      policies: this.options.policies,
      initialPlanId: initial.plan.planId,
      planId: finalization.delta.base.planId,
      initialPolicies: initial.base.policies,
      nextPolicies: policies
    })

    const before = new Map(
      this.options.policies.list().map((record) => [policyKey(record), record] as const)
    )
    const newPolicyCount = policies.filter((policy) => !before.has(policyKey(policy))).length
    const updatedPolicyCount = policies.filter((policy) => {
      const prior = before.get(policyKey(policy))
      return (
        prior !== undefined &&
        (prior.migrationPlanId !== finalization.delta.base.planId ||
          canonicalJson(policyIdentity(prior)) !== canonicalJson(policyIdentity(policy)))
      )
    }).length
    const records = this.options.policies.reconcileMigrationPolicies({
      initialMigrationPlanId: initial.plan.planId,
      migrationPlanId: finalization.delta.base.planId,
      policies,
      now: this.now()
    })
    if (records.length !== policies.length) {
      blocked('People migration terminal policy store returned an incomplete batch')
    }
    return {
      schemaVersion: PEOPLE_TO_CHANNEL_FINALIZATION_POLICY_WRITE_VERSION,
      initialPlanId: initial.plan.planId,
      planId: finalization.delta.base.planId,
      baseMaterializationDigest: finalization.delta.base.materializationDigest,
      policyDigest: policyDigest(
        initial.plan.planId,
        finalization.delta.base.planId,
        finalization.delta.base.materializationDigest,
        policies
      ),
      policyCount: policies.length,
      newPolicyCount,
      updatedPolicyCount,
      policiesApplied: newPolicyCount + updatedPolicyCount > 0,
      records: records.map(clone)
    }
  }
}

export function isPeopleToChannelMigrationFinalizationPolicyWriterError(
  error: unknown
): error is PeopleToChannelMigrationFinalizationPolicyWriterError | ChannelHumanPolicyError {
  return (
    (error instanceof PeopleToChannelMigrationFinalizationPolicyWriterError ||
      error instanceof ChannelHumanPolicyError) &&
    error.code === 'recovery_blocked'
  )
}
