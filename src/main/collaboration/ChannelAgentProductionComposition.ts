import { channelAgentPublicKeyFingerprint } from '../../shared/collaboration/ChannelAgentProtocol'
import type { RunEventAudienceLease, RunEventSink } from '../RunEventBus'
import type { RunSessionChangeEvent } from '../RunManager'
import type { ComposerService } from '../services/ComposerService'
import type { AppSettings, ChatRecord, ProviderId } from '../store/types'
import type { ChannelAuditLike } from './ChannelAuditLog'
import type { ChannelAgentAuthoritySnapshot } from './ChannelAgentAuthorityState'
import type { ChannelAgentAuthorityStore } from './ChannelAgentAuthorityStore'
import {
  resolveChannelAgentDispatchPlan,
  type ChannelAgentDispatchPlanResult
} from './ChannelAgentDispatchAuthority'
import type { ChannelAgentDispatchCoordinatorOptions } from './ChannelAgentDispatchCoordinator'
import {
  ChannelAgentDispatchRecovery,
  type ChannelAgentConsumptionInspection,
  type ChannelAgentRunReconciliation,
  type ChannelAgentTerminalPostRecovery
} from './ChannelAgentDispatchRecovery'
import {
  ChannelAgentDispatchJournalState,
  type ChannelAgentDispatchJournalBinding,
  type ChannelAgentDispatchJournalSnapshot
} from './ChannelAgentDispatchJournalState'
import type { ChannelAgentDispatchJournalStore } from './ChannelAgentDispatchJournalStore'
import type { ChannelAgentIdentityStore } from './ChannelAgentIdentityStore'
import {
  admitAcceptedChannelAgentMentions,
  type ChannelAgentMentionTarget
} from './ChannelAgentMentionAdmission'
import {
  ChannelAgentProductionOrchestrator,
  type ChannelAgentProductionOrchestratorOptions
} from './ChannelAgentProductionOrchestrator'
import { ChannelAgentProductionService } from './ChannelAgentProductionService'
import type { ChannelAgentWorkspacePrincipal } from './ChannelAgentSeatAuthority'
import {
  ChannelAgentTerminalPostSignerError,
  signChannelAgentTerminalPost
} from './ChannelAgentTerminalPostSigner'
import type { ChannelMessageLog, HumanChannelMessage } from './ChannelMessageLog'
import type { ChannelRuntime } from './ChannelRuntime'
import type { ChannelMember, ChannelStore } from './ChannelStore'

type JournalPort = Pick<
  ChannelAgentDispatchJournalStore,
  | 'reserve'
  | 'listChannel'
  | 'snapshot'
  | 'beginConsumption'
  | 'commitConsumption'
  | 'beginLaunch'
  | 'confirmLaunch'
  | 'recordTerminal'
  | 'recordSignedPost'
  | 'recordPosted'
  | 'abandon'
  | 'complete'
>

type AuthorityPort = Pick<
  ChannelAgentAuthorityStore,
  'consumeDispatch' | 'snapshot' | 'verifyPostAuthority'
>
type IdentityPort = Pick<ChannelAgentIdentityStore, 'load'>
type ChannelPort = Pick<ChannelStore, 'getChannel' | 'listMembers'>
type MessagePort = Pick<ChannelMessageLog, 'getMessageById'>
type RuntimePort = Pick<ChannelRuntime, 'appendSignedAgentPost'>
type ComposePort = Pick<
  ComposerService,
  'composeMainOwnedChannelAgentRun'
>['composeMainOwnedChannelAgentRun']

export interface ChannelAgentProductionCompositionOptions {
  readonly journal: JournalPort
  readonly authority: AuthorityPort
  readonly identities: IdentityPort
  readonly channels: ChannelPort
  readonly messages: MessagePort
  readonly runtime: RuntimePort
  readonly getChat: (chatId: string) => ChatRecord | null
  readonly resolveWorkspacePrincipal: (chat: ChatRecord) => ChannelAgentWorkspacePrincipal | null
  readonly getSettings: () => Pick<AppSettings, 'agenticServices' | 'agenticWorkspaceGrants'>
  readonly providerAllowed: (provider: ProviderId) => boolean
  readonly composeMainOwnedChannelAgentRun: ComposePort
  readonly dispatch: ChannelAgentDispatchCoordinatorOptions['dispatch']
  readonly audit: ChannelAuditLike
  readonly subscribeRunEvents: (sink: RunEventSink) => () => void
  readonly subscribeRunSessions: (listener: (event: RunSessionChangeEvent) => void) => () => void
  readonly claimRunAudience: (runId: string, sinkIds: readonly string[]) => RunEventAudienceLease
  /** Read-only exact-run reconciliation. It must never launch or redispatch. */
  readonly reconcileRun: (
    snapshot: ChannelAgentDispatchJournalSnapshot
  ) => ChannelAgentRunReconciliation | Promise<ChannelAgentRunReconciliation>
  readonly now?: () => number
  readonly logger?: (line: string) => void
}

export type ChannelAgentProductionCompositionErrorCode = 'invalid_options'

export class ChannelAgentProductionCompositionError extends Error {
  constructor(
    readonly code: ChannelAgentProductionCompositionErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ChannelAgentProductionCompositionError'
  }
}

function compositionError(message: string): ChannelAgentProductionCompositionError {
  return new ChannelAgentProductionCompositionError('invalid_options', message)
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function currentTime(now: () => number): number {
  let value: number
  try {
    value = now()
  } catch {
    throw compositionError('Channel agent production clock is unavailable')
  }
  if (!isTimestamp(value)) {
    throw compositionError('Channel agent production clock is unavailable')
  }
  return value
}

function canonicalPlan(
  options: ChannelAgentProductionCompositionOptions,
  record: HumanChannelMessage,
  target: ChannelAgentMentionTarget,
  members?: readonly ChannelMember[]
): ChannelAgentDispatchPlanResult {
  const channel = options.channels.getChannel(record.channelId)
  if (!channel) return { kind: 'denied', reason: 'binding_mismatch' }
  const chat = options.getChat(channel.chatId)
  if (!chat || chat.appChatId !== channel.chatId) {
    return { kind: 'denied', reason: 'binding_mismatch' }
  }
  const workspacePrincipal = options.resolveWorkspacePrincipal(chat)
  if (!workspacePrincipal) return { kind: 'denied', reason: 'workspace_identity_mismatch' }
  const authority = options.authority.snapshot(channel.channelId)
  return resolveChannelAgentDispatchPlan({
    channel,
    trigger: record,
    target,
    members: members ?? options.channels.listMembers(channel.channelId),
    chat,
    workspacePrincipal,
    settings: options.getSettings(),
    providerAllowed: options.providerAllowed,
    authority,
    at: currentTime(options.now ?? Date.now)
  })
}

function exactConsumption(
  authority: ChannelAgentAuthoritySnapshot,
  snapshot: ChannelAgentDispatchJournalSnapshot
): ChannelAgentConsumptionInspection {
  const binding = snapshot.binding
  const intent = snapshot.events.find((event) => event.kind === 'consumption.intent')
  const delegations = authority.delegations.filter((record) => {
    const delegation = record.signedDelegation.delegation
    let fingerprint = ''
    try {
      fingerprint = channelAgentPublicKeyFingerprint(delegation.agentPublicKeyB64)
    } catch {
      return false
    }
    return (
      delegation.delegationId === binding.delegationId &&
      delegation.channelId === binding.channelId &&
      delegation.ownerMemberId === binding.ownerMemberId &&
      delegation.agentMemberId === binding.agentMemberId &&
      delegation.agentSeatId === binding.agentSeatId &&
      delegation.keyGeneration === binding.keyGeneration &&
      fingerprint === binding.agentPublicKeyFingerprint &&
      delegation.notBefore === binding.delegationNotBefore &&
      delegation.expiresAt === binding.delegationExpiresAt &&
      delegation.maxPostBytes === binding.maxPostBytes
    )
  })
  const grants = authority.dispatchGrants.filter((record) => {
    const grant = record.signedDispatchGrant.grant
    return (
      grant.grantId === binding.dispatchGrantId &&
      grant.channelId === binding.channelId &&
      grant.ownerMemberId === binding.ownerMemberId &&
      grant.agentMemberId === binding.agentMemberId &&
      grant.agentSeatId === binding.agentSeatId &&
      grant.keyGeneration === binding.keyGeneration &&
      grant.delegationId === binding.delegationId &&
      grant.notBefore === binding.dispatchGrantNotBefore &&
      grant.expiresAt === binding.dispatchGrantExpiresAt &&
      grant.workspaceIdentityHash === binding.workspaceIdentityHash &&
      grant.permissionPostureHash === binding.permissionPostureHash &&
      grant.allowedMentionerMemberIds.includes(binding.mentionerMemberId)
    )
  })
  if (
    !intent ||
    authority.channelId !== binding.channelId ||
    authority.ownerMemberId !== binding.ownerMemberId ||
    delegations.length !== 1 ||
    grants.length !== 1
  ) {
    return { kind: 'unavailable' }
  }
  const matches = authority.consumptions.filter(
    (consumption) =>
      consumption.grantId === binding.dispatchGrantId &&
      consumption.triggerMessageId === binding.triggerMessageId
  )
  if (matches.length === 0) return { kind: 'absent' }
  if (matches.length !== 1) return { kind: 'unavailable' }
  const consumption = matches[0]
  if (
    consumption.channelId !== binding.channelId ||
    consumption.mentionerMemberId !== binding.mentionerMemberId ||
    consumption.workspaceIdentityHash !== binding.workspaceIdentityHash ||
    consumption.permissionPostureHash !== binding.permissionPostureHash ||
    consumption.recordedRevision !== intent.authorityRevision + 1 ||
    consumption.recordedRevision > authority.revision ||
    consumption.dispatchOrdinal !== intent.expectedDispatchOrdinal ||
    consumption.dispatchOrdinal > grants[0].signedDispatchGrant.grant.maxDispatches ||
    consumption.consumedAt !== intent.at
  ) {
    return { kind: 'unavailable' }
  }
  return { kind: 'found', consumption }
}

function inspectConsumption(
  options: ChannelAgentProductionCompositionOptions,
  snapshot: ChannelAgentDispatchJournalSnapshot
): ChannelAgentConsumptionInspection {
  try {
    const strict = ChannelAgentDispatchJournalState.restore(snapshot).snapshot()
    const authority = options.authority.snapshot(strict.binding.channelId)
    return authority ? exactConsumption(authority, strict) : { kind: 'unavailable' }
  } catch {
    return { kind: 'unavailable' }
  }
}

function terminalSigning(
  options: ChannelAgentProductionCompositionOptions,
  snapshot: ChannelAgentDispatchJournalSnapshot,
  at: number
): ChannelAgentTerminalPostRecovery {
  let identity: ReturnType<IdentityPort['load']>
  try {
    identity = options.identities.load(snapshot.binding.agentSeatId)
  } catch {
    return { kind: 'unavailable' }
  }
  if (!identity) return { kind: 'denied' }
  try {
    const signedPost = signChannelAgentTerminalPost({ snapshot, identity, at })
    const authority = options.authority.verifyPostAuthority(snapshot.binding.channelId, {
      signedPost,
      acceptedAt: at
    })
    if (authority.kind !== 'authorized' || !sameJson(authority.signedPost, signedPost)) {
      return { kind: 'denied' }
    }
    return { kind: 'signed', signedPost }
  } catch (error) {
    if (
      error instanceof ChannelAgentTerminalPostSignerError &&
      (error.code === 'authority_expired' || error.code === 'identity_mismatch')
    ) {
      return { kind: 'denied' }
    }
    return { kind: 'unavailable' }
  }
}

function exactReservedTrigger(
  options: ChannelAgentProductionCompositionOptions,
  binding: ChannelAgentDispatchJournalBinding
): HumanChannelMessage | null {
  let record: ReturnType<MessagePort['getMessageById']>
  try {
    record = options.messages.getMessageById(binding.channelId, binding.triggerMessageId)
  } catch {
    return null
  }
  return record?.kind === 'human.text' &&
    record.channelId === binding.channelId &&
    record.messageId === binding.triggerMessageId &&
    record.authorMemberId === binding.mentionerMemberId &&
    record.contentHash === binding.triggerContentHash &&
    record.acceptedAt <= binding.reservedAt
    ? record
    : null
}

function validateOptions(options: ChannelAgentProductionCompositionOptions): void {
  if (
    !options ||
    typeof options.channels?.getChannel !== 'function' ||
    typeof options.channels?.listMembers !== 'function' ||
    typeof options.messages?.getMessageById !== 'function' ||
    typeof options.authority?.snapshot !== 'function' ||
    typeof options.authority?.verifyPostAuthority !== 'function' ||
    typeof options.identities?.load !== 'function' ||
    typeof options.runtime?.appendSignedAgentPost !== 'function' ||
    typeof options.getChat !== 'function' ||
    typeof options.resolveWorkspacePrincipal !== 'function' ||
    typeof options.getSettings !== 'function' ||
    typeof options.providerAllowed !== 'function' ||
    typeof options.reconcileRun !== 'function' ||
    (options.now !== undefined && typeof options.now !== 'function') ||
    (options.logger !== undefined && typeof options.logger !== 'function')
  ) {
    throw compositionError('Channel agent production composition ports are unavailable')
  }
}

/**
 * Compose the source-gated production service over canonical main-owned state.
 * Construction is root-free and inert: the immutable review gate in the
 * returned service must admit participation before subscriptions, recovery,
 * authority planning, provider dispatch, signing, or signed append can run.
 */
export function createChannelAgentProductionComposition(
  options: ChannelAgentProductionCompositionOptions
): ChannelAgentProductionService {
  validateOptions(options)
  const orchestrator = new ChannelAgentProductionOrchestrator({
    journal: options.journal,
    authority: options.authority,
    identities: options.identities,
    composeMainOwnedChannelAgentRun: options.composeMainOwnedChannelAgentRun,
    dispatch: options.dispatch,
    appendSignedPost: (args) => options.runtime.appendSignedAgentPost(args),
    audit: options.audit,
    subscribeRunEvents: options.subscribeRunEvents,
    subscribeRunSessions: options.subscribeRunSessions,
    claimRunAudience: options.claimRunAudience,
    ...(options.now ? { now: options.now } : {})
  } satisfies ChannelAgentProductionOrchestratorOptions)

  const recovery = new ChannelAgentDispatchRecovery({
    journal: options.journal,
    inspectConsumption: (snapshot) => inspectConsumption(options, snapshot),
    retryReserved: async (snapshot) => {
      let state: ChannelAgentDispatchJournalState
      try {
        state = ChannelAgentDispatchJournalState.restore(snapshot)
      } catch {
        return { kind: 'retained' }
      }
      if (state.phase() !== 'reserved') return { kind: 'retained' }
      const binding = state.binding()
      const record = exactReservedTrigger(options, binding)
      if (!record) return { kind: 'retained' }
      let members: readonly ChannelMember[]
      try {
        members = options.channels.listMembers(binding.channelId)
      } catch {
        return { kind: 'retained' }
      }
      const admission = admitAcceptedChannelAgentMentions({ record, members })
      if (admission.kind !== 'admitted') return { kind: 'retained' }
      const targets = admission.targets.filter(
        (target) =>
          target.memberId === binding.agentMemberId &&
          target.agentSeatId === binding.agentSeatId &&
          target.keyGeneration === binding.keyGeneration
      )
      if (targets.length !== 1) return { kind: 'retained' }
      let planResult: ChannelAgentDispatchPlanResult
      try {
        planResult = canonicalPlan(options, record, targets[0], members)
      } catch {
        return { kind: 'retained' }
      }
      if (planResult.kind !== 'authorized') return { kind: 'retained' }
      try {
        const expected = ChannelAgentDispatchJournalState.reserve(
          planResult.plan,
          binding.reservedAt
        ).binding()
        if (!sameJson(expected, binding)) return { kind: 'retained' }
        await orchestrator.dispatchPlan(planResult.plan)
        return { kind: 'retried' }
      } catch {
        return { kind: 'retained' }
      }
    },
    reconcileRun: options.reconcileRun,
    signTerminalPost: ({ snapshot, at }) => terminalSigning(options, snapshot, at),
    appendSignedPost: ({ signedPost, now }) =>
      options.runtime.appendSignedAgentPost({ signedPost, now }),
    audit: options.audit,
    ...(options.now ? { now: options.now } : {})
  })

  return new ChannelAgentProductionService({
    execution: orchestrator,
    recovery,
    getMembers: (channelId) => options.channels.listMembers(channelId),
    resolveDispatchPlan: ({ record, target }) => canonicalPlan(options, record, target),
    audit: options.audit,
    ...(options.logger ? { logger: options.logger } : {})
  })
}
