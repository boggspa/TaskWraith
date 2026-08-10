import { channelAgentPublicKeyFingerprint } from '../../shared/collaboration/ChannelAgentProtocol'
import type {
  ChannelAgentAuthoritySnapshot,
  ChannelAgentDispatchConsumption,
  RecordedChannelAgentDelegation,
  RecordedChannelAgentDispatchGrant
} from './ChannelAgentAuthorityState'
import type { ChannelAgentAuthorityStore } from './ChannelAgentAuthorityStore'
import {
  ChannelAgentDispatchJournalState,
  type ChannelAgentConsumptionIntentEvent,
  type ChannelAgentDispatchJournalBinding,
  type ChannelAgentDispatchJournalSnapshot
} from './ChannelAgentDispatchJournalState'
import type { ChannelAgentDispatchJournalValidationResult } from './ChannelAgentDispatchJournalStore'
import type { ChannelStore } from './ChannelStore'

type AuthorityPort = Pick<ChannelAgentAuthorityStore, 'snapshot'>
type ChannelPort = Pick<ChannelStore, 'getChannel' | 'listMembers'>

export interface ChannelAgentDispatchJournalAuthorityOptions {
  readonly authority: AuthorityPort
  readonly channels: ChannelPort
}

export type ChannelAgentDispatchConsumptionInspection =
  | { readonly kind: 'found'; readonly consumption: ChannelAgentDispatchConsumption }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unavailable' }

interface BoundAuthority {
  readonly delegation: RecordedChannelAgentDelegation
  readonly grant: RecordedChannelAgentDispatchGrant
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function boundAuthority(
  authority: ChannelAgentAuthoritySnapshot,
  binding: ChannelAgentDispatchJournalBinding
): BoundAuthority | null {
  if (
    authority.channelId !== binding.channelId ||
    authority.ownerMemberId !== binding.ownerMemberId
  ) {
    return null
  }
  const delegations = authority.delegations.filter((record) => {
    const delegation = record.signedDelegation.delegation
    let fingerprint = ''
    try {
      fingerprint = channelAgentPublicKeyFingerprint(delegation.agentPublicKeyB64)
    } catch {
      return false
    }
    return (
      record.recordedRevision <= authority.revision &&
      delegation.delegationId === binding.delegationId &&
      delegation.channelId === binding.channelId &&
      delegation.ownerMemberId === binding.ownerMemberId &&
      delegation.agentMemberId === binding.agentMemberId &&
      delegation.agentSeatId === binding.agentSeatId &&
      delegation.keyGeneration === binding.keyGeneration &&
      fingerprint === binding.agentPublicKeyFingerprint &&
      delegation.notBefore === binding.delegationNotBefore &&
      delegation.expiresAt === binding.delegationExpiresAt &&
      delegation.maxPostBytes === binding.maxPostBytes &&
      delegation.scopes.includes('channel.dispatch') &&
      delegation.scopes.includes('channel.post')
    )
  })
  if (delegations.length !== 1) return null
  const delegationValue = delegations[0].signedDelegation.delegation
  const grants = authority.dispatchGrants.filter((record) => {
    const grant = record.signedDispatchGrant.grant
    return (
      record.recordedRevision <= authority.revision &&
      grant.grantId === binding.dispatchGrantId &&
      grant.channelId === binding.channelId &&
      grant.ownerMemberId === binding.ownerMemberId &&
      grant.agentMemberId === binding.agentMemberId &&
      grant.agentSeatId === binding.agentSeatId &&
      grant.agentPublicKeyB64 === delegationValue.agentPublicKeyB64 &&
      grant.keyGeneration === binding.keyGeneration &&
      grant.delegationId === binding.delegationId &&
      grant.trigger === 'mention' &&
      grant.notBefore === binding.dispatchGrantNotBefore &&
      grant.expiresAt === binding.dispatchGrantExpiresAt &&
      grant.workspaceIdentityHash === binding.workspaceIdentityHash &&
      grant.permissionPostureHash === binding.permissionPostureHash &&
      grant.allowedMentionerMemberIds.includes(binding.mentionerMemberId)
    )
  })
  return grants.length === 1 ? { delegation: delegations[0], grant: grants[0] } : null
}

function matchingConsumptions(
  authority: ChannelAgentAuthoritySnapshot,
  binding: ChannelAgentDispatchJournalBinding
): ChannelAgentDispatchConsumption[] {
  return authority.consumptions.filter(
    (consumption) =>
      consumption.grantId === binding.dispatchGrantId &&
      consumption.triggerMessageId === binding.triggerMessageId
  )
}

function exactConsumption(
  consumption: ChannelAgentDispatchConsumption,
  intent: ChannelAgentConsumptionIntentEvent,
  binding: ChannelAgentDispatchJournalBinding,
  authorityRevision: number,
  maximumDispatches: number
): boolean {
  return (
    consumption.channelId === binding.channelId &&
    consumption.mentionerMemberId === binding.mentionerMemberId &&
    consumption.workspaceIdentityHash === binding.workspaceIdentityHash &&
    consumption.permissionPostureHash === binding.permissionPostureHash &&
    consumption.recordedRevision === intent.authorityRevision + 1 &&
    consumption.recordedRevision <= authorityRevision &&
    consumption.dispatchOrdinal === intent.expectedDispatchOrdinal &&
    consumption.dispatchOrdinal <= maximumDispatches &&
    consumption.consumedAt === intent.at
  )
}

function inspectAgainstAuthority(
  snapshot: ChannelAgentDispatchJournalSnapshot,
  authority: ChannelAgentAuthoritySnapshot
): ChannelAgentDispatchConsumptionInspection {
  const state = ChannelAgentDispatchJournalState.restore(snapshot)
  if (state.phase() !== 'consuming') return { kind: 'unavailable' }
  const strict = state.snapshot()
  const intent = strict.events.find((event) => event.kind === 'consumption.intent')
  const bound = boundAuthority(authority, strict.binding)
  if (!intent || !bound || intent.authorityRevision < bound.grant.recordedRevision) {
    return { kind: 'unavailable' }
  }
  const matches = matchingConsumptions(authority, strict.binding)
  if (matches.length === 0) return { kind: 'absent' }
  if (
    matches.length !== 1 ||
    !exactConsumption(
      matches[0],
      intent,
      strict.binding,
      authority.revision,
      bound.grant.signedDispatchGrant.grant.maxDispatches
    )
  ) {
    return { kind: 'unavailable' }
  }
  return { kind: 'found', consumption: matches[0] }
}

/** Inspect only the atomic consumption for a strict `consuming` journal. */
export function inspectChannelAgentDispatchConsumption(
  authorityPort: AuthorityPort,
  snapshot: ChannelAgentDispatchJournalSnapshot
): ChannelAgentDispatchConsumptionInspection {
  try {
    const strict = ChannelAgentDispatchJournalState.restore(snapshot).snapshot()
    const authority = authorityPort.snapshot(strict.binding.channelId)
    return authority ? inspectAgainstAuthority(strict, authority) : { kind: 'unavailable' }
  } catch {
    return { kind: 'unavailable' }
  }
}

/**
 * Rebind one recovered journal to canonical metadata and signed authority.
 * Missing canonical roots preserve evidence as `unavailable`; malformed bytes
 * or a present-but-different root are `invalid` and may be quarantined.
 */
export function validateChannelAgentDispatchJournalSnapshot(
  options: ChannelAgentDispatchJournalAuthorityOptions,
  snapshot: ChannelAgentDispatchJournalSnapshot
): ChannelAgentDispatchJournalValidationResult {
  let strict: ChannelAgentDispatchJournalSnapshot
  try {
    strict = ChannelAgentDispatchJournalState.restore(snapshot).snapshot()
  } catch {
    return 'invalid'
  }
  const binding = strict.binding
  let channel: ReturnType<ChannelPort['getChannel']>
  let members: ReturnType<ChannelPort['listMembers']>
  try {
    channel = options.channels.getChannel(binding.channelId)
    members = options.channels.listMembers(binding.channelId)
  } catch {
    return 'unavailable'
  }
  if (!channel) return 'unavailable'
  if (
    channel.channelId !== binding.channelId ||
    channel.chatId !== binding.chatId ||
    channel.ownerMemberId !== binding.ownerMemberId
  ) {
    return 'invalid'
  }
  const agents = members.filter((member) => member.memberId === binding.agentMemberId)
  const mentioners = members.filter((member) => member.memberId === binding.mentionerMemberId)
  if (agents.length === 0 || mentioners.length === 0) return 'unavailable'
  if (agents.length !== 1 || mentioners.length !== 1) return 'invalid'
  const agent = agents[0]
  const mentioner = mentioners[0]
  let agentFingerprint = ''
  try {
    agentFingerprint = channelAgentPublicKeyFingerprint(agent.identityPublicKey)
  } catch {
    return 'invalid'
  }
  if (
    agent.kind !== 'agent' ||
    agent.channelId !== binding.channelId ||
    (agent.status !== 'active' && agent.status !== 'revoked') ||
    agent.agentSeatId !== binding.agentSeatId ||
    agent.keyGeneration !== binding.keyGeneration ||
    agentFingerprint !== binding.agentPublicKeyFingerprint ||
    mentioner.kind !== 'human' ||
    mentioner.channelId !== binding.channelId ||
    (mentioner.status !== 'active' && mentioner.status !== 'revoked')
  ) {
    return 'invalid'
  }

  let authority: ChannelAgentAuthoritySnapshot | null
  try {
    authority = options.authority.snapshot(binding.channelId)
  } catch {
    return 'unavailable'
  }
  if (!authority) return 'unavailable'
  const bound = boundAuthority(authority, binding)
  if (!bound) return 'invalid'

  const intent = strict.events.find((event) => event.kind === 'consumption.intent')
  const committed = strict.events.find((event) => event.kind === 'consumption.committed')
  const matches = matchingConsumptions(authority, binding)
  if (!committed) {
    if (!intent) return matches.length === 0 ? 'valid' : 'unavailable'
    if (intent.authorityRevision < bound.grant.recordedRevision) return 'invalid'
    if (matches.length === 0) return 'valid'
    return matches.length === 1 &&
      exactConsumption(
        matches[0],
        intent,
        binding,
        authority.revision,
        bound.grant.signedDispatchGrant.grant.maxDispatches
      )
      ? 'valid'
      : 'invalid'
  }
  if (
    !intent ||
    intent.authorityRevision < bound.grant.recordedRevision ||
    matches.length !== 1 ||
    !sameJson(matches[0], committed.consumption) ||
    !exactConsumption(
      matches[0],
      intent,
      binding,
      authority.revision,
      bound.grant.signedDispatchGrant.grant.maxDispatches
    )
  ) {
    return 'invalid'
  }
  return 'valid'
}
