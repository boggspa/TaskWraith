import { createHash, createPublicKey, type KeyObject } from 'crypto'

import {
  CHANNEL_AGENT_MAX_DISPATCHES,
  CHANNEL_AGENT_MAX_POST_BYTES,
  CHANNEL_AGENT_PROTOCOL_VERSION,
  channelAgentPublicKeyFingerprint,
  signChannelAgentDelegation,
  signChannelAgentDispatchGrant,
  signChannelAgentRevocation,
  type ChannelAgentRevocationReason,
  type SignedChannelAgentDelegation,
  type SignedChannelAgentDispatchGrant,
  type SignedChannelAgentRevocation
} from '../../shared/collaboration/ChannelAgentProtocol'
import { exportRawEd25519PublicKey, type KeyPair } from '../../shared/e2ee/keys'
import type {
  ChannelAgentAuthoritySnapshot,
  RecordedChannelAgentDelegation,
  RecordedChannelAgentDispatchGrant,
  RecordedChannelAgentRevocation
} from './ChannelAgentAuthorityState'
import type { ChannelAgentAuthorityStore } from './ChannelAgentAuthorityStore'
import type {
  ChannelAgentIdentityMaterial,
  ChannelAgentIdentityStore,
  ChannelAgentPublicKeyHistory,
  ChannelAgentPublicKeyRecord
} from './ChannelAgentIdentityStore'
import type { ChannelAgentSeatCandidate } from './ChannelAgentSeatAuthority'
import type {
  AgentChannelMember,
  Channel,
  ChannelMember,
  ChannelStore,
  HumanChannelMember
} from './ChannelStore'

export const CHANNEL_AGENT_DEFAULT_GRANT_TTL_MS = 60 * 60 * 1_000
export const CHANNEL_AGENT_MIN_GRANT_TTL_MS = 5 * 60 * 1_000
export const CHANNEL_AGENT_MAX_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1_000
export const CHANNEL_AGENT_DEFAULT_MAX_DISPATCHES = 1
export const CHANNEL_AGENT_MANAGED_MAX_DISPATCHES = 100

const DELEGATION_TTL_MS = 365 * 24 * 60 * 60 * 1_000
const MAX_IDENTIFIER_LENGTH = 512
const MAX_DISPLAY_NAME_LENGTH = 120
const MANAGEMENT_ID_DOMAIN = 'taskwraith.channel.agent-management-id.v1'

export type ChannelAgentManagementErrorCode =
  | 'authority_expired'
  | 'channel_unavailable'
  | 'idempotency_conflict'
  | 'identity_mismatch'
  | 'invalid_input'
  | 'not_enrolled'
  | 'recovery_blocked'
  | 'rotation_required'

export class ChannelAgentManagementError extends Error {
  constructor(
    readonly code: ChannelAgentManagementErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ChannelAgentManagementError'
  }
}

export interface ChannelAgentManagementChannelPort {
  listChannels(): Channel[]
  getChannel(channelId: string): Channel | null
  getMember(channelId: string, memberId: string): ChannelMember | null
  listMembers(channelId: string): ChannelMember[]
  registerAgentMember(args: {
    channelId: string
    displayName: string
    signedDelegation: SignedChannelAgentDelegation
    now?: number
  }): AgentChannelMember
  revokeMember(args: { channelId: string; memberId: string; now?: number }): ChannelMember
}

export type ChannelAgentManagementIdentityPort = Pick<
  ChannelAgentIdentityStore,
  'loadOrCreate' | 'load' | 'publicHistory' | 'rotate'
>

export type ChannelAgentManagementAuthorityPort = Pick<
  ChannelAgentAuthorityStore,
  'registerDelegation' | 'registerDispatchGrant' | 'registerRevocation' | 'snapshot'
>

export interface ChannelAgentManagementServiceOptions {
  readonly channels: ChannelAgentManagementChannelPort
  readonly identities: ChannelAgentManagementIdentityPort
  readonly authority: ChannelAgentManagementAuthorityPort
  readonly loadOwnerIdentity: () => KeyPair
  readonly now?: () => number
}

export interface ChannelAgentEnrollmentResult {
  readonly member: AgentChannelMember
  readonly identity: ChannelAgentPublicKeyRecord
  readonly signedDelegation: SignedChannelAgentDelegation
}

export interface ChannelAgentDispatchGrantResult extends ChannelAgentEnrollmentResult {
  readonly signedDispatchGrant: SignedChannelAgentDispatchGrant
}

export interface ChannelAgentRevocationResult {
  readonly member: AgentChannelMember
  readonly signedRevocation: SignedChannelAgentRevocation
  readonly alreadyRevoked: boolean
}

export interface ChannelAgentRotationResult {
  readonly identity: ChannelAgentPublicKeyRecord
  readonly channels: readonly ChannelAgentEnrollmentResult[]
  readonly resumed: boolean
}

interface OwnerContext {
  readonly channel: Channel
  readonly owner: HumanChannelMember
  readonly keyPair: KeyPair
}

interface AgentBinding {
  readonly agentSeatId: string
  readonly agentMemberId: string
  readonly agentPublicKeyB64: string
  readonly keyGeneration: number
}

function managementError(
  code: ChannelAgentManagementErrorCode,
  message: string
): ChannelAgentManagementError {
  return new ChannelAgentManagementError(code, message)
}

function safeIdentifier(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.trim() !== value
  ) {
    return false
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function safeDisplayName(value: unknown): value is string {
  if (!safeIdentifier(value) || Array.from(value).length > MAX_DISPLAY_NAME_LENGTH) return false
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (
      codePoint === 0x00ad ||
      codePoint === 0x034f ||
      codePoint === 0x061c ||
      codePoint === 0x180e ||
      (codePoint >= 0x200b && codePoint <= 0x200f) ||
      (codePoint >= 0x2028 && codePoint <= 0x202e) ||
      codePoint === 0x2060 ||
      (codePoint >= 0x2066 && codePoint <= 0x2069) ||
      codePoint === 0xfeff
    ) {
      return false
    }
  }
  return true
}

function safeHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function safeTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function safeAddTimestamp(value: number, delta: number): number {
  const result = value + delta
  if (!Number.isSafeInteger(result) || result <= value) {
    throw managementError('invalid_input', 'Channel agent authority time is out of range')
  }
  return result
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function publicRecord(identity: ChannelAgentIdentityMaterial): ChannelAgentPublicKeyRecord {
  return {
    agentSeatId: identity.agentSeatId,
    keyGeneration: identity.keyGeneration,
    publicKeyB64: identity.publicKeyB64,
    fingerprint: identity.fingerprint,
    createdAt: identity.createdAt
  }
}

function bindingFromMember(member: AgentChannelMember): AgentBinding {
  return {
    agentSeatId: member.agentSeatId,
    agentMemberId: member.memberId,
    agentPublicKeyB64: member.identityPublicKey,
    keyGeneration: member.keyGeneration
  }
}

function bindingFromDelegation(record: RecordedChannelAgentDelegation): AgentBinding {
  const value = record.signedDelegation.delegation
  return {
    agentSeatId: value.agentSeatId,
    agentMemberId: value.agentMemberId,
    agentPublicKeyB64: value.agentPublicKeyB64,
    keyGeneration: value.keyGeneration
  }
}

function sameBinding(left: AgentBinding, right: AgentBinding): boolean {
  return (
    left.agentSeatId === right.agentSeatId &&
    left.agentMemberId === right.agentMemberId &&
    left.agentPublicKeyB64 === right.agentPublicKeyB64 &&
    left.keyGeneration === right.keyGeneration
  )
}

function operationId(
  kind: string,
  requestId: string,
  channelId: string,
  agentSeatId: string,
  keyGeneration: number
): string {
  if (!safeIdentifier(requestId)) {
    throw managementError('invalid_input', 'Channel agent operation id is invalid')
  }
  const digest = createHash('sha256')
    .update(
      `${MANAGEMENT_ID_DOMAIN}\n${kind}\n${requestId}\n${channelId}\n${agentSeatId}\n${keyGeneration}`
    )
    .digest('hex')
  return `channel-agent-${kind}-${digest}`
}

function revocationEffective(record: RecordedChannelAgentRevocation, at: number): boolean {
  return record.signedRevocation.revocation.revokedAt <= at
}

function revocationMatchesBinding(
  record: RecordedChannelAgentRevocation,
  binding: AgentBinding
): boolean {
  const value = record.signedRevocation.revocation
  return value.agentSeatId === binding.agentSeatId && value.keyGeneration === binding.keyGeneration
}

function keyRevocation(
  snapshot: ChannelAgentAuthoritySnapshot | null,
  binding: AgentBinding,
  at: number
): RecordedChannelAgentRevocation | null {
  const fingerprint = channelAgentPublicKeyFingerprint(binding.agentPublicKeyB64)
  return (
    snapshot?.revocations.find(
      (record) =>
        revocationEffective(record, at) &&
        revocationMatchesBinding(record, binding) &&
        record.signedRevocation.revocation.targetKind === 'agent_key' &&
        record.signedRevocation.revocation.targetId === fingerprint
    ) ?? null
  )
}

function delegationRevoked(
  snapshot: ChannelAgentAuthoritySnapshot,
  record: RecordedChannelAgentDelegation,
  at: number
): boolean {
  const binding = bindingFromDelegation(record)
  return snapshot.revocations.some((revocation) => {
    if (!revocationEffective(revocation, at) || !revocationMatchesBinding(revocation, binding)) {
      return false
    }
    const value = revocation.signedRevocation.revocation
    return (
      (value.targetKind === 'agent_key' &&
        value.targetId === channelAgentPublicKeyFingerprint(binding.agentPublicKeyB64)) ||
      (value.targetKind === 'delegation' &&
        value.targetId === record.signedDelegation.delegation.delegationId)
    )
  })
}

function grantRevoked(
  snapshot: ChannelAgentAuthoritySnapshot,
  record: RecordedChannelAgentDispatchGrant,
  at: number
): boolean {
  const grant = record.signedDispatchGrant.grant
  const binding: AgentBinding = {
    agentSeatId: grant.agentSeatId,
    agentMemberId: grant.agentMemberId,
    agentPublicKeyB64: grant.agentPublicKeyB64,
    keyGeneration: grant.keyGeneration
  }
  return snapshot.revocations.some((revocation) => {
    if (!revocationEffective(revocation, at) || !revocationMatchesBinding(revocation, binding)) {
      return false
    }
    const value = revocation.signedRevocation.revocation
    return (
      (value.targetKind === 'agent_key' &&
        value.targetId === channelAgentPublicKeyFingerprint(binding.agentPublicKeyB64)) ||
      (value.targetKind === 'delegation' && value.targetId === grant.delegationId) ||
      (value.targetKind === 'dispatch_grant' && value.targetId === grant.grantId)
    )
  })
}

function agentMembers(
  members: readonly ChannelMember[],
  agentSeatId: string
): AgentChannelMember[] {
  return members
    .filter(
      (member): member is AgentChannelMember =>
        member.kind === 'agent' && member.agentSeatId === agentSeatId
    )
    .sort((left, right) => left.keyGeneration - right.keyGeneration)
}

function latestMember(members: readonly AgentChannelMember[]): AgentChannelMember | null {
  return members.length > 0 ? members[members.length - 1] : null
}

function identityRecords(history: ChannelAgentPublicKeyHistory): ChannelAgentPublicKeyRecord[] {
  return [...history.retired, history.current].sort(
    (left, right) => left.keyGeneration - right.keyGeneration
  )
}

export class ChannelAgentManagementService {
  private readonly now: () => number

  constructor(private readonly options: ChannelAgentManagementServiceOptions) {
    if (
      !options ||
      typeof options !== 'object' ||
      !options.channels ||
      !options.identities ||
      !options.authority ||
      typeof options.loadOwnerIdentity !== 'function'
    ) {
      throw managementError('invalid_input', 'Channel agent management options are required')
    }
    this.now = options.now ?? Date.now
  }

  enrollAgent(args: {
    channelId: string
    seat: Pick<ChannelAgentSeatCandidate, 'agentSeatId' | 'displayName'>
    operationId: string
  }): ChannelAgentEnrollmentResult {
    const channelId = this.requireIdentifier(args?.channelId, 'Channel id')
    const agentSeatId = this.requireSeat(args?.seat?.agentSeatId)
    const displayName = this.requireDisplayName(args?.seat?.displayName)
    this.requireIdentifier(args?.operationId, 'Operation id')
    const owner = this.ownerContext(channelId)
    const identity = this.options.identities.loadOrCreate(agentSeatId)
    return this.reconcileEnrollment(owner, identity, displayName, args.operationId)
  }

  grantDispatch(args: {
    channelId: string
    agentSeatId: string
    operationId: string
    allowedMentionerMemberIds: readonly string[]
    workspaceIdentityHash: string
    permissionPostureHash: string
    ttlMs?: number
    maxDispatches?: number
  }): ChannelAgentDispatchGrantResult {
    const channelId = this.requireIdentifier(args?.channelId, 'Channel id')
    const agentSeatId = this.requireSeat(args?.agentSeatId)
    const requestId = this.requireIdentifier(args?.operationId, 'Operation id')
    if (!safeHash(args?.workspaceIdentityHash) || !safeHash(args?.permissionPostureHash)) {
      throw managementError('invalid_input', 'Channel agent authority hashes are invalid')
    }
    const now = this.requireNow()
    const ttlMs = this.grantTtl(args.ttlMs)
    const maxDispatches = this.dispatchBudget(args.maxDispatches)
    const expiresAt = safeAddTimestamp(now, ttlMs)
    const owner = this.ownerContext(channelId)
    const identity = this.options.identities.load(agentSeatId)
    if (!identity) throw managementError('not_enrolled', 'Channel agent identity is unavailable')
    const member = this.currentActiveMember(channelId, identity)
    const mentioners = this.allowedMentioners(channelId, args.allowedMentionerMemberIds)
    const grantId = operationId('grant', requestId, channelId, agentSeatId, identity.keyGeneration)
    const existing = this.options.authority
      .snapshot(channelId)
      ?.dispatchGrants.find((record) => record.signedDispatchGrant.grant.grantId === grantId)
    if (existing) {
      return this.existingGrantResult({
        existing,
        member,
        identity,
        mentioners,
        workspaceIdentityHash: args.workspaceIdentityHash,
        permissionPostureHash: args.permissionPostureHash,
        maxDispatches,
        now
      })
    }

    const delegation = this.ensureDelegation({
      owner,
      identity,
      member,
      operationId: requestId,
      minimumExpiresAt: expiresAt,
      now,
      allowRevoked: false
    })
    const snapshot = this.options.authority.snapshot(channelId)
    if (!snapshot) {
      throw managementError('recovery_blocked', 'Channel agent authority did not persist')
    }
    for (const record of snapshot.dispatchGrants) {
      const value = record.signedDispatchGrant.grant
      if (
        value.agentSeatId !== agentSeatId ||
        value.keyGeneration !== identity.keyGeneration ||
        value.expiresAt <= now ||
        grantRevoked(snapshot, record, now)
      ) {
        continue
      }
      this.ensureGrantRevocation(owner, record, requestId, now)
    }

    const signedDispatchGrant = signChannelAgentDispatchGrant(owner.keyPair.privateKey, {
      schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
      grantId,
      channelId,
      ownerMemberId: owner.channel.ownerMemberId,
      agentMemberId: member.memberId,
      agentSeatId,
      agentPublicKeyB64: identity.publicKeyB64,
      keyGeneration: identity.keyGeneration,
      delegationId: delegation.delegation.delegationId,
      trigger: 'mention',
      allowedMentionerMemberIds: mentioners,
      workspaceIdentityHash: args.workspaceIdentityHash,
      permissionPostureHash: args.permissionPostureHash,
      issuedAt: now,
      notBefore: now,
      expiresAt,
      maxDispatches
    })
    this.options.authority.registerDispatchGrant(signedDispatchGrant)
    return {
      member,
      identity: publicRecord(identity),
      signedDelegation: delegation,
      signedDispatchGrant
    }
  }

  revokeAgent(args: {
    channelId: string
    agentSeatId: string
    operationId: string
  }): ChannelAgentRevocationResult {
    const channelId = this.requireIdentifier(args?.channelId, 'Channel id')
    const agentSeatId = this.requireSeat(args?.agentSeatId)
    const requestId = this.requireIdentifier(args?.operationId, 'Operation id')
    const now = this.requireNow()
    const owner = this.ownerContext(channelId)
    const members = agentMembers(this.options.channels.listMembers(channelId), agentSeatId)
    const member = latestMember(members)
    if (!member) throw managementError('not_enrolled', 'Channel agent is not enrolled')
    const snapshot = this.options.authority.snapshot(channelId)
    const delegation = this.findDelegation(snapshot, bindingFromMember(member), now, 0, true)
    if (!delegation) {
      throw managementError('recovery_blocked', 'Channel agent membership has no delegation')
    }
    const existing = keyRevocation(snapshot, bindingFromMember(member), now)
    const signedRevocation =
      existing?.signedRevocation ??
      this.ensureKeyRevocation(owner, delegation, requestId, now, 'agent_removed', true)
    const alreadyRevoked = member.status === 'revoked'
    const persisted = alreadyRevoked
      ? member
      : this.requireAgentMember(
          this.options.channels.revokeMember({ channelId, memberId: member.memberId, now })
        )
    return { member: persisted, signedRevocation, alreadyRevoked }
  }

  rotateAgentKey(args: {
    agentSeatId: string
    operationId: string
    reEnrollChannelIds?: readonly string[]
  }): ChannelAgentRotationResult {
    const agentSeatId = this.requireSeat(args?.agentSeatId)
    const requestId = this.requireIdentifier(args?.operationId, 'Operation id')
    const now = this.requireNow()
    const current = this.options.identities.load(agentSeatId)
    if (!current) throw managementError('not_enrolled', 'Channel agent identity is unavailable')
    const activeChannels = this.options.channels
      .listChannels()
      .filter((channel) => channel.status === 'active')
      .sort((left, right) => left.channelId.localeCompare(right.channelId))

    const priorMarkers =
      current.keyGeneration > 1
        ? this.rotationMarkerChannels(
            activeChannels,
            agentSeatId,
            current.keyGeneration - 1,
            requestId,
            now
          )
        : []
    if (priorMarkers.length > 0) {
      const completed = priorMarkers.map(({ owner, displayName }) =>
        this.reconcileEnrollment(owner, current, displayName, requestId)
      )
      return { identity: publicRecord(current), channels: completed, resumed: true }
    }

    const currentMarkers = this.rotationMarkerChannels(
      activeChannels,
      agentSeatId,
      current.keyGeneration,
      requestId,
      now
    )
    const requestedChannels = new Set(
      (args.reEnrollChannelIds ?? []).map((channelId) =>
        this.requireIdentifier(channelId, 'Re-enrollment Channel id')
      )
    )
    const targets = new Map<string, { owner: OwnerContext; member: AgentChannelMember }>()
    for (const channel of activeChannels) {
      const member = agentMembers(
        this.options.channels.listMembers(channel.channelId),
        agentSeatId
      ).find((candidate) => candidate.keyGeneration === current.keyGeneration)
      const marker = currentMarkers.find(
        (candidate) => candidate.owner.channel.channelId === channel.channelId
      )
      const requested = requestedChannels.has(channel.channelId)
      if (member?.status === 'active' || marker || requested) {
        if (!member) {
          throw managementError(
            'not_enrolled',
            'Requested Channel has no matching agent generation to rotate'
          )
        }
        const owner = marker?.owner ?? this.ownerContext(channel.channelId)
        const exactMember = marker?.member ?? member
        this.assertIdentityBinding(exactMember, current)
        targets.set(channel.channelId, { owner, member: exactMember })
        requestedChannels.delete(channel.channelId)
      }
    }
    if (requestedChannels.size > 0) {
      throw managementError('channel_unavailable', 'Requested re-enrollment Channel is unavailable')
    }
    if (targets.size === 0) {
      throw managementError('not_enrolled', 'Channel agent has no active Channel membership')
    }

    for (const { owner, member } of targets.values()) {
      const snapshot = this.options.authority.snapshot(owner.channel.channelId)
      const delegation = this.findDelegation(snapshot, bindingFromMember(member), now, 0, true)
      if (!delegation) {
        throw managementError('recovery_blocked', 'Channel agent membership has no delegation')
      }
      this.ensureKeyRevocation(owner, delegation, requestId, now, 'key_rotated', false)
      if (member.status !== 'revoked') {
        this.options.channels.revokeMember({
          channelId: owner.channel.channelId,
          memberId: member.memberId,
          now
        })
      }
    }

    const rotation = this.options.identities.rotate(agentSeatId)
    const enrolled = [...targets.values()].map(({ owner, member }) =>
      this.reconcileEnrollment(owner, rotation.identity, member.displayName, requestId)
    )
    return {
      identity: publicRecord(rotation.identity),
      channels: enrolled,
      resumed: currentMarkers.length > 0
    }
  }

  private reconcileEnrollment(
    owner: OwnerContext,
    identity: ChannelAgentIdentityMaterial,
    displayName: string,
    requestId: string
  ): ChannelAgentEnrollmentResult {
    const now = this.requireNow()
    const history = this.options.identities.publicHistory(identity.agentSeatId)
    if (
      !history ||
      history.current.agentSeatId !== identity.agentSeatId ||
      history.current.keyGeneration !== identity.keyGeneration ||
      history.current.publicKeyB64 !== identity.publicKeyB64
    ) {
      throw managementError('recovery_blocked', 'Channel agent identity history is unavailable')
    }
    const records = identityRecords(history)
    const members = agentMembers(
      this.options.channels.listMembers(owner.channel.channelId),
      identity.agentSeatId
    )
    const byGeneration = new Map<number, AgentChannelMember>()
    for (const member of members) {
      if (byGeneration.has(member.keyGeneration)) {
        throw managementError(
          'recovery_blocked',
          'Channel agent membership generation is ambiguous'
        )
      }
      const record = records.find((candidate) => candidate.keyGeneration === member.keyGeneration)
      if (!record || record.publicKeyB64 !== member.identityPublicKey) {
        throw managementError(
          'identity_mismatch',
          'Channel agent membership key does not match custody'
        )
      }
      byGeneration.set(member.keyGeneration, member)
    }

    let currentResult: ChannelAgentEnrollmentResult | null = null
    for (const record of records) {
      const isCurrent = record.keyGeneration === identity.keyGeneration
      let member = byGeneration.get(record.keyGeneration) ?? null
      if (member && member.status !== 'active' && member.status !== 'revoked') {
        throw managementError('recovery_blocked', 'Channel agent membership state is invalid')
      }
      if (member && isCurrent && member.status === 'revoked') {
        throw managementError(
          'rotation_required',
          'Revoked Channel agent membership requires a new key generation'
        )
      }

      const delegation = this.ensureDelegation({
        owner,
        identityRecord: record,
        member,
        operationId: requestId,
        minimumExpiresAt: !isCurrent && member ? 0 : safeAddTimestamp(now, 1),
        now,
        allowRevoked: !isCurrent
      })
      if (!member) {
        member = this.options.channels.registerAgentMember({
          channelId: owner.channel.channelId,
          displayName,
          signedDelegation: delegation,
          now
        })
        byGeneration.set(record.keyGeneration, member)
      }
      if (
        !sameBinding(
          bindingFromMember(member),
          bindingFromDelegation({ recordedRevision: 0, signedDelegation: delegation })
        )
      ) {
        throw managementError(
          'identity_mismatch',
          'Channel agent delegation does not match membership'
        )
      }

      if (!isCurrent) {
        this.ensureKeyRevocation(
          owner,
          { recordedRevision: 0, signedDelegation: delegation },
          requestId,
          now,
          'key_rotated',
          true
        )
        if (member.status !== 'revoked') {
          member = this.requireAgentMember(
            this.options.channels.revokeMember({
              channelId: owner.channel.channelId,
              memberId: member.memberId,
              now
            })
          )
        }
        continue
      }

      if (
        keyRevocation(
          this.options.authority.snapshot(owner.channel.channelId),
          bindingFromMember(member),
          now
        )
      ) {
        if (member.status !== 'revoked') {
          this.options.channels.revokeMember({
            channelId: owner.channel.channelId,
            memberId: member.memberId,
            now
          })
        }
        throw managementError(
          'rotation_required',
          'Revoked Channel agent key requires a new generation'
        )
      }
      currentResult = { member, identity: publicRecord(identity), signedDelegation: delegation }
    }
    if (!currentResult) {
      throw managementError(
        'recovery_blocked',
        'Channel agent enrollment did not reach current custody'
      )
    }
    return currentResult
  }

  private ensureDelegation(args: {
    owner: OwnerContext
    identity?: ChannelAgentIdentityMaterial
    identityRecord?: ChannelAgentPublicKeyRecord
    member: AgentChannelMember | null
    operationId: string
    minimumExpiresAt: number
    now: number
    allowRevoked: boolean
  }): SignedChannelAgentDelegation {
    const record = args.identityRecord ?? (args.identity ? publicRecord(args.identity) : null)
    if (!record) throw managementError('invalid_input', 'Channel agent identity record is required')
    let snapshot = this.options.authority.snapshot(args.owner.channel.channelId)
    const partialBinding: AgentBinding = {
      agentSeatId: record.agentSeatId,
      agentMemberId: args.member?.memberId ?? '',
      agentPublicKeyB64: record.publicKeyB64,
      keyGeneration: record.keyGeneration
    }
    if (!args.allowRevoked && keyRevocation(snapshot, partialBinding, args.now)) {
      throw managementError('rotation_required', 'Channel agent key has been revoked')
    }
    const existing = this.findDelegation(
      snapshot,
      partialBinding,
      args.now,
      args.minimumExpiresAt,
      args.allowRevoked,
      args.member === null
    )
    if (existing) return existing.signedDelegation

    const agentMemberId =
      args.member?.memberId ??
      operationId(
        'member',
        args.operationId,
        args.owner.channel.channelId,
        record.agentSeatId,
        record.keyGeneration
      )
    const delegationId = operationId(
      'delegation',
      args.operationId,
      args.owner.channel.channelId,
      record.agentSeatId,
      record.keyGeneration
    )
    const sameId = snapshot?.delegations.find(
      (candidate) => candidate.signedDelegation.delegation.delegationId === delegationId
    )
    if (sameId) {
      throw managementError('idempotency_conflict', 'Channel agent delegation operation conflicts')
    }
    const expiresAt = Math.max(args.minimumExpiresAt, safeAddTimestamp(args.now, DELEGATION_TTL_MS))
    const signed = signChannelAgentDelegation(args.owner.keyPair.privateKey, {
      schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
      delegationId,
      channelId: args.owner.channel.channelId,
      ownerMemberId: args.owner.channel.ownerMemberId,
      agentMemberId,
      agentSeatId: record.agentSeatId,
      agentPublicKeyB64: record.publicKeyB64,
      keyGeneration: record.keyGeneration,
      scopes: ['channel.dispatch', 'channel.post'],
      issuedAt: args.now,
      notBefore: args.now,
      expiresAt,
      maxPostBytes: CHANNEL_AGENT_MAX_POST_BYTES
    })
    this.options.authority.registerDelegation(signed)
    snapshot = this.options.authority.snapshot(args.owner.channel.channelId)
    const persisted = snapshot?.delegations.find(
      (candidate) => candidate.signedDelegation.delegation.delegationId === delegationId
    )
    if (!persisted) {
      throw managementError('recovery_blocked', 'Channel agent delegation did not persist')
    }
    return persisted.signedDelegation
  }

  private findDelegation(
    snapshot: ChannelAgentAuthoritySnapshot | null,
    binding: AgentBinding,
    at: number,
    minimumExpiresAt: number,
    allowRevoked: boolean,
    ignoreMemberId = false
  ): RecordedChannelAgentDelegation | null {
    if (!snapshot) return null
    return (
      [...snapshot.delegations]
        .sort((left, right) => right.recordedRevision - left.recordedRevision)
        .find((record) => {
          const value = record.signedDelegation.delegation
          return (
            value.agentSeatId === binding.agentSeatId &&
            (ignoreMemberId || value.agentMemberId === binding.agentMemberId) &&
            value.agentPublicKeyB64 === binding.agentPublicKeyB64 &&
            value.keyGeneration === binding.keyGeneration &&
            value.scopes.includes('channel.dispatch') &&
            value.scopes.includes('channel.post') &&
            value.notBefore <= at &&
            value.expiresAt >= minimumExpiresAt &&
            (allowRevoked || !delegationRevoked(snapshot, record, at))
          )
        }) ?? null
    )
  }

  private ensureKeyRevocation(
    owner: OwnerContext,
    delegation: RecordedChannelAgentDelegation,
    requestId: string,
    now: number,
    reason: ChannelAgentRevocationReason,
    reuseAny: boolean
  ): SignedChannelAgentRevocation {
    const binding = bindingFromDelegation(delegation)
    const snapshot = this.options.authority.snapshot(owner.channel.channelId)
    const revocationId = operationId(
      reason === 'key_rotated' ? 'rotate-key' : 'remove-key',
      requestId,
      owner.channel.channelId,
      binding.agentSeatId,
      binding.keyGeneration
    )
    const sameId = snapshot?.revocations.find(
      (record) => record.signedRevocation.revocation.revocationId === revocationId
    )
    if (sameId) {
      const value = sameId.signedRevocation.revocation
      if (
        value.channelId !== owner.channel.channelId ||
        value.ownerMemberId !== owner.channel.ownerMemberId ||
        value.agentSeatId !== binding.agentSeatId ||
        value.keyGeneration !== binding.keyGeneration ||
        value.targetKind !== 'agent_key' ||
        value.targetId !== channelAgentPublicKeyFingerprint(binding.agentPublicKeyB64) ||
        value.reason !== reason
      ) {
        throw managementError(
          'idempotency_conflict',
          'Channel agent revocation operation conflicts'
        )
      }
      return sameId.signedRevocation
    }
    if (reuseAny) {
      const existing = keyRevocation(snapshot, binding, now)
      if (existing) return existing.signedRevocation
    }
    const signed = signChannelAgentRevocation(owner.keyPair.privateKey, {
      schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
      revocationId,
      channelId: owner.channel.channelId,
      ownerMemberId: owner.channel.ownerMemberId,
      agentSeatId: binding.agentSeatId,
      keyGeneration: binding.keyGeneration,
      targetKind: 'agent_key',
      targetId: channelAgentPublicKeyFingerprint(binding.agentPublicKeyB64),
      revokedAt: now,
      reason
    })
    this.options.authority.registerRevocation(signed)
    return signed
  }

  private ensureGrantRevocation(
    owner: OwnerContext,
    grant: RecordedChannelAgentDispatchGrant,
    requestId: string,
    now: number
  ): SignedChannelAgentRevocation {
    const value = grant.signedDispatchGrant.grant
    const revocationId = operationId(
      'replace-grant',
      requestId,
      owner.channel.channelId,
      value.agentSeatId,
      value.keyGeneration
    )
    const signed = signChannelAgentRevocation(owner.keyPair.privateKey, {
      schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
      revocationId: `${revocationId}-${createHash('sha256').update(value.grantId).digest('hex').slice(0, 32)}`,
      channelId: owner.channel.channelId,
      ownerMemberId: owner.channel.ownerMemberId,
      agentSeatId: value.agentSeatId,
      keyGeneration: value.keyGeneration,
      targetKind: 'dispatch_grant',
      targetId: value.grantId,
      revokedAt: now,
      reason: 'owner_revoked'
    })
    this.options.authority.registerRevocation(signed)
    return signed
  }

  private existingGrantResult(args: {
    existing: RecordedChannelAgentDispatchGrant
    member: AgentChannelMember
    identity: ChannelAgentIdentityMaterial
    mentioners: readonly string[]
    workspaceIdentityHash: string
    permissionPostureHash: string
    maxDispatches: number
    now: number
  }): ChannelAgentDispatchGrantResult {
    const value = args.existing.signedDispatchGrant.grant
    const snapshot = this.options.authority.snapshot(value.channelId)
    if (
      value.agentMemberId !== args.member.memberId ||
      value.agentSeatId !== args.identity.agentSeatId ||
      value.agentPublicKeyB64 !== args.identity.publicKeyB64 ||
      value.keyGeneration !== args.identity.keyGeneration ||
      !sameStrings(value.allowedMentionerMemberIds, args.mentioners) ||
      value.workspaceIdentityHash !== args.workspaceIdentityHash ||
      value.permissionPostureHash !== args.permissionPostureHash ||
      value.maxDispatches !== args.maxDispatches
    ) {
      throw managementError('idempotency_conflict', 'Channel agent grant operation conflicts')
    }
    if (!snapshot || grantRevoked(snapshot, args.existing, args.now)) {
      throw managementError('idempotency_conflict', 'Channel agent grant operation was revoked')
    }
    if (value.expiresAt <= args.now) {
      throw managementError('authority_expired', 'Channel agent grant operation has expired')
    }
    const delegation = snapshot.delegations.find(
      (record) => record.signedDelegation.delegation.delegationId === value.delegationId
    )
    if (!delegation || delegationRevoked(snapshot, delegation, args.now)) {
      throw managementError('recovery_blocked', 'Channel agent grant delegation is unavailable')
    }
    return {
      member: args.member,
      identity: publicRecord(args.identity),
      signedDelegation: delegation.signedDelegation,
      signedDispatchGrant: args.existing.signedDispatchGrant
    }
  }

  private rotationMarkerChannels(
    channels: readonly Channel[],
    agentSeatId: string,
    keyGeneration: number,
    requestId: string,
    at: number
  ): Array<{ owner: OwnerContext; member: AgentChannelMember; displayName: string }> {
    const matches: Array<{
      owner: OwnerContext
      member: AgentChannelMember
      displayName: string
    }> = []
    for (const channel of channels) {
      const expected = operationId(
        'rotate-key',
        requestId,
        channel.channelId,
        agentSeatId,
        keyGeneration
      )
      const record = this.options.authority
        .snapshot(channel.channelId)
        ?.revocations.find((candidate) => {
          const value = candidate.signedRevocation.revocation
          return (
            value.revocationId === expected &&
            value.agentSeatId === agentSeatId &&
            value.keyGeneration === keyGeneration &&
            value.targetKind === 'agent_key' &&
            value.reason === 'key_rotated' &&
            value.revokedAt <= at
          )
        })
      if (!record) continue
      const member = agentMembers(
        this.options.channels.listMembers(channel.channelId),
        agentSeatId
      ).find((candidate) => candidate.keyGeneration === keyGeneration)
      if (!member) {
        throw managementError('recovery_blocked', 'Rotation marker has no Channel membership')
      }
      if (
        record.signedRevocation.revocation.targetId !==
        channelAgentPublicKeyFingerprint(member.identityPublicKey)
      ) {
        throw managementError('idempotency_conflict', 'Channel agent rotation marker conflicts')
      }
      matches.push({
        owner: this.ownerContext(channel.channelId),
        member,
        displayName: member.displayName
      })
    }
    return matches
  }

  private currentActiveMember(
    channelId: string,
    identity: ChannelAgentIdentityMaterial
  ): AgentChannelMember {
    const members = agentMembers(this.options.channels.listMembers(channelId), identity.agentSeatId)
    const member = members.find(
      (candidate) =>
        candidate.status === 'active' && candidate.keyGeneration === identity.keyGeneration
    )
    if (!member) throw managementError('not_enrolled', 'Channel agent is not actively enrolled')
    this.assertIdentityBinding(member, identity)
    if (
      keyRevocation(
        this.options.authority.snapshot(channelId),
        bindingFromMember(member),
        this.requireNow()
      )
    ) {
      throw managementError('rotation_required', 'Channel agent key has been revoked')
    }
    return member
  }

  private assertIdentityBinding(
    member: AgentChannelMember,
    identity: ChannelAgentIdentityMaterial
  ): void {
    if (
      member.agentSeatId !== identity.agentSeatId ||
      member.keyGeneration !== identity.keyGeneration ||
      member.identityPublicKey !== identity.publicKeyB64
    ) {
      throw managementError('identity_mismatch', 'Channel agent membership does not match custody')
    }
  }

  private allowedMentioners(channelId: string, values: readonly string[]): string[] {
    if (!Array.isArray(values)) {
      throw managementError('invalid_input', 'Allowed Channel mentioners are required')
    }
    const sorted = [...new Set(values)].sort()
    if (
      sorted.length === 0 ||
      sorted.length > 8 ||
      sorted.some((value) => !safeIdentifier(value))
    ) {
      throw managementError('invalid_input', 'Allowed Channel mentioners are invalid')
    }
    for (const memberId of sorted) {
      const member = this.options.channels.getMember(channelId, memberId)
      if (!member || member.kind !== 'human' || member.status !== 'active') {
        throw managementError('invalid_input', 'Allowed mentioner is not an active human member')
      }
    }
    return sorted
  }

  private ownerContext(channelId: string): OwnerContext {
    const channel = this.options.channels.getChannel(channelId)
    if (!channel || channel.status !== 'active') {
      throw managementError('channel_unavailable', 'Channel is unavailable for agent management')
    }
    const owner = this.options.channels.getMember(channelId, channel.ownerMemberId)
    if (!owner || owner.kind !== 'human' || owner.status !== 'active') {
      throw managementError('recovery_blocked', 'Pinned Channel owner is unavailable')
    }
    let keyPair: KeyPair
    let derivedPublic: KeyObject
    try {
      keyPair = this.options.loadOwnerIdentity()
      derivedPublic = createPublicKey(keyPair.privateKey)
      const derived = exportRawEd25519PublicKey(derivedPublic).toString('base64')
      const supplied = exportRawEd25519PublicKey(keyPair.publicKey).toString('base64')
      if (derived !== supplied || supplied !== owner.identityPublicKey) {
        throw new Error('owner mismatch')
      }
    } catch {
      throw managementError('identity_mismatch', 'Local identity does not own this Channel')
    }
    return { channel, owner, keyPair }
  }

  private grantTtl(value: number | undefined): number {
    const ttl = value ?? CHANNEL_AGENT_DEFAULT_GRANT_TTL_MS
    if (
      !Number.isSafeInteger(ttl) ||
      ttl < CHANNEL_AGENT_MIN_GRANT_TTL_MS ||
      ttl > CHANNEL_AGENT_MAX_GRANT_TTL_MS
    ) {
      throw managementError('invalid_input', 'Channel agent grant lifetime is out of range')
    }
    return ttl
  }

  private dispatchBudget(value: number | undefined): number {
    const budget = value ?? CHANNEL_AGENT_DEFAULT_MAX_DISPATCHES
    if (
      !Number.isSafeInteger(budget) ||
      budget < 1 ||
      budget > CHANNEL_AGENT_MANAGED_MAX_DISPATCHES ||
      budget > CHANNEL_AGENT_MAX_DISPATCHES
    ) {
      throw managementError('invalid_input', 'Channel agent dispatch budget is out of range')
    }
    return budget
  }

  private requireNow(): number {
    const value = this.now()
    if (!safeTimestamp(value)) {
      throw managementError('invalid_input', 'Channel agent management clock is invalid')
    }
    return value
  }

  private requireSeat(value: unknown): string {
    if (!safeIdentifier(value) || !value.startsWith('pooled-agent-') || value === 'pooled-agent-') {
      throw managementError('invalid_input', 'Channel agent seat id is invalid')
    }
    return value
  }

  private requireIdentifier(value: unknown, label: string): string {
    if (!safeIdentifier(value)) throw managementError('invalid_input', `${label} is invalid`)
    return value
  }

  private requireDisplayName(value: unknown): string {
    if (!safeDisplayName(value)) {
      throw managementError('invalid_input', 'Channel agent display name is invalid')
    }
    return value
  }

  private requireAgentMember(value: ChannelMember): AgentChannelMember {
    if (value.kind !== 'agent') {
      throw managementError('recovery_blocked', 'Channel agent membership changed kind')
    }
    return value
  }
}

export function createChannelAgentManagementService(options: {
  readonly channels: ChannelStore
  readonly identities: ChannelAgentIdentityStore
  readonly authority: ChannelAgentAuthorityStore
  readonly loadOwnerIdentity: () => KeyPair
  readonly now?: () => number
}): ChannelAgentManagementService {
  return new ChannelAgentManagementService(options)
}
