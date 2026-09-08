import { ChannelAgentAuthorityStore } from './ChannelAgentAuthorityStore'
import { ChannelAgentDispatchJournalStore } from './ChannelAgentDispatchJournalStore'
import {
  ChannelAgentIdentityStore,
  type ChannelAgentIdentitySafeStorage
} from './ChannelAgentIdentityStore'
import { ChannelAuditLog } from './ChannelAuditLog'
import { ChannelHumanPolicyStore } from './ChannelHumanPolicyStore'
import { ChannelHumanReviewStore } from './ChannelHumanReviewStore'
import { ChannelMessageLog } from './ChannelMessageLog'
import { ChannelError, ChannelStore, type Channel } from './ChannelStore'

export type ChannelProductionHistoryDeletionScope =
  | { kind: 'chat' | 'workspace' | 'truncate'; chatIds: readonly string[] }
  | { kind: 'global' }

export interface ChannelProductionHistoryDeletionResult {
  kind: ChannelProductionHistoryDeletionScope['kind']
  purgedChannelIds: string[]
  preservedChannelIds: string[]
}

export interface ChannelHistoryDeletionPaths {
  metadata: string
  logs: string
  audit: string
  agentIdentities: string
  agentAuthority: string
  agentDispatchJournal: string
  humanPolicies: string
  humanReviews: string
}

export interface ChannelHistoryDeletionPlan {
  readonly kind: ChannelProductionHistoryDeletionScope['kind']
  readonly targets: ReadonlyArray<Pick<Channel, 'channelId' | 'chatId'>>
  readonly channelIds: readonly string[]
  readonly humanPolicyChannelIds: readonly string[]
  readonly immediateResult: ChannelProductionHistoryDeletionResult | null
}

export interface ChannelHistoryDeletionStores {
  store: Pick<ChannelStore, 'purgeChannels' | 'purgeAllChannels'>
  log: Pick<ChannelMessageLog, 'purgeChannels' | 'purgeAll'>
  audit: Pick<ChannelAuditLog, 'purgeChannels' | 'purgeAll'>
  agentDispatchJournal: Pick<ChannelAgentDispatchJournalStore, 'eraseChannel' | 'purgeAll'>
  agentAuthority: Pick<ChannelAgentAuthorityStore, 'eraseChannel' | 'purgeAll'>
  agentIdentities?: Pick<ChannelAgentIdentityStore, 'purgeAll'>
  humanPolicies: Pick<ChannelHumanPolicyStore, 'purgeChannels'>
  humanReviews: Pick<ChannelHumanReviewStore, 'purgeChannels' | 'purgeAll'>
}

/**
 * Freeze the exact metadata-derived delete set before a live service quiesces.
 * A cold caller executes the same plan immediately because no runtime exists.
 */
export function planChannelHistoryDeletion(input: {
  scope: ChannelProductionHistoryDeletionScope
  store: Pick<ChannelStore, 'listChannels'>
  listHumanPolicyChannelIds?: () => readonly string[]
}): ChannelHistoryDeletionPlan {
  const channels = input.store.listChannels()
  let targets: Channel[]
  if (input.scope.kind === 'global') {
    targets = channels
  } else {
    if (
      !Array.isArray(input.scope.chatIds) ||
      input.scope.chatIds.some((chatId) => typeof chatId !== 'string' || !chatId.trim())
    ) {
      throw new ChannelError('protocol_unsupported', 'History deletion chat ids are invalid')
    }
    const chatIds = new Set(input.scope.chatIds)
    targets = channels.filter((channel) => chatIds.has(channel.chatId))
  }
  const frozenTargets = targets.map(({ channelId, chatId }) => Object.freeze({ channelId, chatId }))
  const channelIds = frozenTargets.map((target) => target.channelId)
  if (input.scope.kind === 'global' && !input.listHumanPolicyChannelIds) {
    throw new Error('Global Channel history deletion requires the human policy store')
  }
  const humanPolicyChannelIds =
    input.scope.kind === 'global' ? [...input.listHumanPolicyChannelIds!()] : [...channelIds]
  const immediateResult =
    input.scope.kind === 'truncate'
      ? {
          kind: input.scope.kind,
          purgedChannelIds: [],
          preservedChannelIds: [...channelIds]
        }
      : channelIds.length === 0 && input.scope.kind !== 'global'
        ? {
            kind: input.scope.kind,
            purgedChannelIds: [],
            preservedChannelIds: []
          }
        : null
  return Object.freeze({
    kind: input.scope.kind,
    targets: Object.freeze(frozenTargets),
    channelIds: Object.freeze(channelIds),
    humanPolicyChannelIds: Object.freeze(humanPolicyChannelIds),
    immediateResult
  })
}

/**
 * Synchronous store transaction extracted verbatim from the live service.
 * Channel metadata remains after every earlier store until its own purge lands,
 * so a crash can rediscover and retry the same channel ids. Human policy stays
 * after Channel authority as the existing fail-closed ordering requires.
 */
export function executeChannelHistoryDeletion(
  stores: ChannelHistoryDeletionStores,
  plan: ChannelHistoryDeletionPlan
): ChannelProductionHistoryDeletionResult {
  if (plan.immediateResult)
    return {
      ...plan.immediateResult,
      purgedChannelIds: [...plan.immediateResult.purgedChannelIds],
      preservedChannelIds: [...plan.immediateResult.preservedChannelIds]
    }
  if (plan.kind === 'global') {
    if (!stores.agentIdentities) {
      throw new Error('Global Channel history deletion requires the agent identity store')
    }
    stores.log.purgeAll()
    stores.audit.purgeAll()
    stores.agentDispatchJournal.purgeAll()
    stores.agentAuthority.purgeAll()
    stores.agentIdentities.purgeAll()
    stores.store.purgeAllChannels()
    // Delete policy only after Channel authority is gone. A late persistence
    // failure may leave an orphaned policy, but can never widen a live member.
    stores.humanPolicies.purgeChannels(plan.humanPolicyChannelIds)
    stores.humanReviews.purgeAll()
  } else {
    stores.log.purgeChannels(plan.channelIds)
    stores.audit.purgeChannels(plan.channelIds)
    for (const channelId of plan.channelIds) {
      stores.agentDispatchJournal.eraseChannel(channelId)
      stores.agentAuthority.eraseChannel(channelId)
    }
    stores.store.purgeChannels(plan.channelIds)
    stores.humanPolicies.purgeChannels(plan.humanPolicyChannelIds)
    stores.humanReviews.purgeChannels(plan.channelIds)
  }
  return {
    kind: plan.kind,
    purgedChannelIds: [...plan.channelIds],
    preservedChannelIds: []
  }
}

/** Delete-only startup path. It does not start a Channel runtime or transport. */
export function purgeColdChannelHistoryDeletion(input: {
  paths: ChannelHistoryDeletionPaths
  scope: ChannelProductionHistoryDeletionScope
  safeStorage?: ChannelAgentIdentitySafeStorage
}): ChannelProductionHistoryDeletionResult {
  const store = new ChannelStore(input.paths.metadata)
  let humanPolicies: ChannelHumanPolicyStore | undefined
  const plan = planChannelHistoryDeletion({
    scope: input.scope,
    store,
    ...(input.scope.kind === 'global'
      ? {
          listHumanPolicyChannelIds: () => {
            humanPolicies ??= new ChannelHumanPolicyStore(input.paths.humanPolicies)
            return humanPolicies.list().map((record) => record.channelId)
          }
        }
      : {})
  })
  if (plan.immediateResult) {
    return {
      ...plan.immediateResult,
      purgedChannelIds: [...plan.immediateResult.purgedChannelIds],
      preservedChannelIds: [...plan.immediateResult.preservedChannelIds]
    }
  }

  humanPolicies ??= new ChannelHumanPolicyStore(input.paths.humanPolicies)
  const agentAuthority = new ChannelAgentAuthorityStore({
    storageDirectory: input.paths.agentAuthority,
    resolveOwnerPublicKey: () => null
  })
  const agentDispatchJournal = new ChannelAgentDispatchJournalStore({
    storageDirectory: input.paths.agentDispatchJournal,
    validateSnapshot: () => 'unavailable'
  })
  let agentIdentities: ChannelAgentIdentityStore | undefined
  if (plan.kind === 'global') {
    if (!input.safeStorage) {
      throw new ChannelError(
        'host_unavailable',
        'Global Channel history deletion requires safeStorage'
      )
    }
    // Construction retains the adapter but purgeAll never decrypts or loads a key.
    agentIdentities = new ChannelAgentIdentityStore({
      storageDirectory: input.paths.agentIdentities,
      safeStorage: input.safeStorage
    })
  }
  return executeChannelHistoryDeletion(
    {
      store,
      log: new ChannelMessageLog(input.paths.logs, store),
      audit: new ChannelAuditLog(input.paths.audit),
      agentDispatchJournal,
      agentAuthority,
      ...(agentIdentities ? { agentIdentities } : {}),
      humanPolicies,
      humanReviews: new ChannelHumanReviewStore(input.paths.humanReviews)
    },
    plan
  )
}
