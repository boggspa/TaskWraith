import type { KeyObject } from 'crypto'

import {
  channelAgentPublicKeyFingerprint,
  parseSignedChannelAgentDelegation,
  parseSignedChannelAgentDispatchGrant,
  parseSignedChannelAgentRevocation,
  verifyChannelAgentDelegation,
  verifyChannelAgentDispatchGrant,
  verifyChannelAgentRevocation,
  type SignedChannelAgentDelegation,
  type SignedChannelAgentDispatchGrant,
  type SignedChannelAgentRevocation
} from '../../shared/collaboration/ChannelAgentProtocol'

export const CHANNEL_AGENT_AUTHORITY_STATE_VERSION = 1 as const
export const CHANNEL_AGENT_AUTHORITY_MAX_DELEGATIONS = 4_096
export const CHANNEL_AGENT_AUTHORITY_MAX_GRANTS = 4_096
export const CHANNEL_AGENT_AUTHORITY_MAX_REVOCATIONS = 8_192
export const CHANNEL_AGENT_AUTHORITY_MAX_CONSUMPTIONS = 100_000

const MAX_IDENTIFIER_LENGTH = 512

export type ChannelAgentAuthorityStateErrorCode =
  | 'binding_mismatch'
  | 'capacity_exceeded'
  | 'generation_rollback'
  | 'id_conflict'
  | 'invalid_input'
  | 'invalid_snapshot'
  | 'owner_unavailable'
  | 'revocation_conflict'
  | 'signature_invalid'
  | 'target_not_found'

export class ChannelAgentAuthorityStateError extends Error {
  constructor(
    readonly code: ChannelAgentAuthorityStateErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ChannelAgentAuthorityStateError'
  }
}

export type ChannelAgentOwnerPublicKeyResolver = (
  channelId: string,
  ownerMemberId: string
) => KeyObject | null

export interface RecordedChannelAgentDelegation {
  readonly recordedRevision: number
  readonly signedDelegation: SignedChannelAgentDelegation
}

export interface RecordedChannelAgentDispatchGrant {
  readonly recordedRevision: number
  readonly signedDispatchGrant: SignedChannelAgentDispatchGrant
}

export interface RecordedChannelAgentRevocation {
  readonly recordedRevision: number
  readonly signedRevocation: SignedChannelAgentRevocation
}

export interface ChannelAgentDispatchConsumption {
  readonly schemaVersion: typeof CHANNEL_AGENT_AUTHORITY_STATE_VERSION
  readonly recordedRevision: number
  readonly channelId: string
  readonly grantId: string
  readonly triggerMessageId: string
  readonly mentionerMemberId: string
  readonly workspaceIdentityHash: string
  readonly permissionPostureHash: string
  readonly dispatchOrdinal: number
  readonly consumedAt: number
}

export interface ChannelAgentAuthoritySnapshot {
  readonly schemaVersion: typeof CHANNEL_AGENT_AUTHORITY_STATE_VERSION
  readonly channelId: string
  readonly ownerMemberId: string
  readonly revision: number
  readonly delegations: readonly RecordedChannelAgentDelegation[]
  readonly dispatchGrants: readonly RecordedChannelAgentDispatchGrant[]
  readonly revocations: readonly RecordedChannelAgentRevocation[]
  readonly consumptions: readonly ChannelAgentDispatchConsumption[]
}

export type ChannelAgentDispatchDenialReason =
  | 'authority_expired'
  | 'authority_not_yet_valid'
  | 'authority_revoked'
  | 'delegation_missing'
  | 'dispatch_budget_exhausted'
  | 'dispatch_grant_missing'
  | 'mentioner_not_allowed'
  | 'permission_posture_mismatch'
  | 'workspace_identity_mismatch'

export type ChannelAgentDispatchConsumptionResult =
  | {
      readonly kind: 'authorized'
      readonly delegation: SignedChannelAgentDelegation
      readonly dispatchGrant: SignedChannelAgentDispatchGrant
      readonly consumption: ChannelAgentDispatchConsumption
      readonly remainingDispatches: number
    }
  | {
      readonly kind: 'duplicate'
      readonly consumption: ChannelAgentDispatchConsumption
    }
  | {
      readonly kind: 'denied'
      readonly reason: ChannelAgentDispatchDenialReason
    }

export interface ConsumeChannelAgentDispatchInput {
  readonly grantId: string
  readonly triggerMessageId: string
  readonly mentionerMemberId: string
  readonly workspaceIdentityHash: string
  readonly permissionPostureHash: string
  readonly at: number
}

type RecordedMutation =
  | { readonly kind: 'delegation'; readonly value: RecordedChannelAgentDelegation }
  | { readonly kind: 'dispatch_grant'; readonly value: RecordedChannelAgentDispatchGrant }
  | { readonly kind: 'revocation'; readonly value: RecordedChannelAgentRevocation }
  | { readonly kind: 'consumption'; readonly value: ChannelAgentDispatchConsumption }

function stateError(
  code: ChannelAgentAuthorityStateErrorCode,
  message: string
): ChannelAgentAuthorityStateError {
  return new ChannelAgentAuthorityStateError(code, message)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  if (actual.length !== expected.length) return false
  const keys = new Set(expected)
  return actual.every((key) => keys.has(key))
}

function isIdentifier(value: unknown): value is string {
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

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function delegationId(value: RecordedChannelAgentDelegation): string {
  return value.signedDelegation.delegation.delegationId
}

function grantId(value: RecordedChannelAgentDispatchGrant): string {
  return value.signedDispatchGrant.grant.grantId
}

function revocationId(value: RecordedChannelAgentRevocation): string {
  return value.signedRevocation.revocation.revocationId
}

function sortDelegations(values: RecordedChannelAgentDelegation[]): void {
  values.sort((left, right) => compareText(delegationId(left), delegationId(right)))
}

function sortGrants(values: RecordedChannelAgentDispatchGrant[]): void {
  values.sort((left, right) => compareText(grantId(left), grantId(right)))
}

function sortRevocations(values: RecordedChannelAgentRevocation[]): void {
  values.sort((left, right) => compareText(revocationId(left), revocationId(right)))
}

function sortConsumptions(values: ChannelAgentDispatchConsumption[]): void {
  values.sort((left, right) => {
    const byGrant = compareText(left.grantId, right.grantId)
    if (byGrant !== 0) return byGrant
    if (left.dispatchOrdinal !== right.dispatchOrdinal) {
      return left.dispatchOrdinal - right.dispatchOrdinal
    }
    return compareText(left.triggerMessageId, right.triggerMessageId)
  })
}

function parseRecordedDelegation(value: unknown): RecordedChannelAgentDelegation | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['recordedRevision', 'signedDelegation']) ||
    !isPositiveInteger(value.recordedRevision)
  ) {
    return null
  }
  const signedDelegation = parseSignedChannelAgentDelegation(value.signedDelegation)
  return signedDelegation ? { recordedRevision: value.recordedRevision, signedDelegation } : null
}

function parseRecordedGrant(value: unknown): RecordedChannelAgentDispatchGrant | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['recordedRevision', 'signedDispatchGrant']) ||
    !isPositiveInteger(value.recordedRevision)
  ) {
    return null
  }
  const signedDispatchGrant = parseSignedChannelAgentDispatchGrant(value.signedDispatchGrant)
  return signedDispatchGrant
    ? { recordedRevision: value.recordedRevision, signedDispatchGrant }
    : null
}

function parseRecordedRevocation(value: unknown): RecordedChannelAgentRevocation | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['recordedRevision', 'signedRevocation']) ||
    !isPositiveInteger(value.recordedRevision)
  ) {
    return null
  }
  const signedRevocation = parseSignedChannelAgentRevocation(value.signedRevocation)
  return signedRevocation ? { recordedRevision: value.recordedRevision, signedRevocation } : null
}

function parseConsumption(value: unknown): ChannelAgentDispatchConsumption | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'recordedRevision',
      'channelId',
      'grantId',
      'triggerMessageId',
      'mentionerMemberId',
      'workspaceIdentityHash',
      'permissionPostureHash',
      'dispatchOrdinal',
      'consumedAt'
    ]) ||
    value.schemaVersion !== CHANNEL_AGENT_AUTHORITY_STATE_VERSION ||
    !isPositiveInteger(value.recordedRevision) ||
    !isIdentifier(value.channelId) ||
    !isIdentifier(value.grantId) ||
    !isIdentifier(value.triggerMessageId) ||
    !isIdentifier(value.mentionerMemberId) ||
    !isDigest(value.workspaceIdentityHash) ||
    !isDigest(value.permissionPostureHash) ||
    !isPositiveInteger(value.dispatchOrdinal) ||
    !isTimestamp(value.consumedAt)
  ) {
    return null
  }
  return {
    schemaVersion: CHANNEL_AGENT_AUTHORITY_STATE_VERSION,
    recordedRevision: value.recordedRevision,
    channelId: value.channelId,
    grantId: value.grantId,
    triggerMessageId: value.triggerMessageId,
    mentionerMemberId: value.mentionerMemberId,
    workspaceIdentityHash: value.workspaceIdentityHash,
    permissionPostureHash: value.permissionPostureHash,
    dispatchOrdinal: value.dispatchOrdinal,
    consumedAt: value.consumedAt
  }
}

function parseSnapshotShape(value: unknown): ChannelAgentAuthoritySnapshot | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'channelId',
      'ownerMemberId',
      'revision',
      'delegations',
      'dispatchGrants',
      'revocations',
      'consumptions'
    ]) ||
    value.schemaVersion !== CHANNEL_AGENT_AUTHORITY_STATE_VERSION ||
    !isIdentifier(value.channelId) ||
    !isIdentifier(value.ownerMemberId) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Array.isArray(value.delegations) ||
    value.delegations.length > CHANNEL_AGENT_AUTHORITY_MAX_DELEGATIONS ||
    !Array.isArray(value.dispatchGrants) ||
    value.dispatchGrants.length > CHANNEL_AGENT_AUTHORITY_MAX_GRANTS ||
    !Array.isArray(value.revocations) ||
    value.revocations.length > CHANNEL_AGENT_AUTHORITY_MAX_REVOCATIONS ||
    !Array.isArray(value.consumptions) ||
    value.consumptions.length > CHANNEL_AGENT_AUTHORITY_MAX_CONSUMPTIONS
  ) {
    return null
  }
  const delegations = value.delegations.map(parseRecordedDelegation)
  const dispatchGrants = value.dispatchGrants.map(parseRecordedGrant)
  const revocations = value.revocations.map(parseRecordedRevocation)
  const consumptions = value.consumptions.map(parseConsumption)
  if (
    delegations.some((entry) => entry === null) ||
    dispatchGrants.some((entry) => entry === null) ||
    revocations.some((entry) => entry === null) ||
    consumptions.some((entry) => entry === null)
  ) {
    return null
  }
  return {
    schemaVersion: CHANNEL_AGENT_AUTHORITY_STATE_VERSION,
    channelId: value.channelId,
    ownerMemberId: value.ownerMemberId,
    revision: value.revision as number,
    delegations: delegations as RecordedChannelAgentDelegation[],
    dispatchGrants: dispatchGrants as RecordedChannelAgentDispatchGrant[],
    revocations: revocations as RecordedChannelAgentRevocation[],
    consumptions: consumptions as ChannelAgentDispatchConsumption[]
  }
}

function mutationRevision(value: RecordedMutation): number {
  return value.value.recordedRevision
}

function assertCanonicalMutationRevisions(
  snapshot: ChannelAgentAuthoritySnapshot
): RecordedMutation[] {
  const mutations: RecordedMutation[] = [
    ...snapshot.delegations.map((value) => ({ kind: 'delegation' as const, value })),
    ...snapshot.dispatchGrants.map((value) => ({ kind: 'dispatch_grant' as const, value })),
    ...snapshot.revocations.map((value) => ({ kind: 'revocation' as const, value })),
    ...snapshot.consumptions.map((value) => ({ kind: 'consumption' as const, value }))
  ].sort((left, right) => mutationRevision(left) - mutationRevision(right))
  if (mutations.length !== snapshot.revision) {
    throw stateError('invalid_snapshot', 'Channel agent authority revision count is invalid')
  }
  for (let index = 0; index < mutations.length; index += 1) {
    if (mutationRevision(mutations[index]) !== index + 1) {
      throw stateError('invalid_snapshot', 'Channel agent authority revisions are not contiguous')
    }
  }
  return mutations
}

export class ChannelAgentAuthorityState {
  private revision = 0
  private readonly delegations: RecordedChannelAgentDelegation[] = []
  private readonly dispatchGrants: RecordedChannelAgentDispatchGrant[] = []
  private readonly revocations: RecordedChannelAgentRevocation[] = []
  private readonly consumptions: ChannelAgentDispatchConsumption[] = []

  private constructor(
    readonly channelId: string,
    readonly ownerMemberId: string,
    private readonly resolveOwnerPublicKey: ChannelAgentOwnerPublicKeyResolver
  ) {}

  static create(args: {
    readonly channelId: string
    readonly ownerMemberId: string
    readonly resolveOwnerPublicKey: ChannelAgentOwnerPublicKeyResolver
  }): ChannelAgentAuthorityState {
    if (
      !isIdentifier(args?.channelId) ||
      !isIdentifier(args?.ownerMemberId) ||
      typeof args?.resolveOwnerPublicKey !== 'function'
    ) {
      throw stateError('invalid_input', 'Channel agent authority root is invalid')
    }
    return new ChannelAgentAuthorityState(
      args.channelId,
      args.ownerMemberId,
      args.resolveOwnerPublicKey
    )
  }

  static fromSnapshot(
    value: unknown,
    resolveOwnerPublicKey: ChannelAgentOwnerPublicKeyResolver
  ): ChannelAgentAuthorityState {
    if (typeof resolveOwnerPublicKey !== 'function') {
      throw stateError('invalid_input', 'Channel agent owner-key resolver is required')
    }
    const snapshot = parseSnapshotShape(value)
    if (!snapshot) {
      throw stateError('invalid_snapshot', 'Channel agent authority snapshot is malformed')
    }
    const mutations = assertCanonicalMutationRevisions(snapshot)
    const rebuilt = ChannelAgentAuthorityState.create({
      channelId: snapshot.channelId,
      ownerMemberId: snapshot.ownerMemberId,
      resolveOwnerPublicKey
    })
    try {
      rebuilt.ownerPublicKey()
      for (const mutation of mutations) {
        if (mutation.kind === 'delegation') {
          const result = rebuilt.registerDelegation(mutation.value.signedDelegation)
          if (result !== 'stored' || rebuilt.revision !== mutation.value.recordedRevision) {
            throw stateError('invalid_snapshot', 'Delegation revision replay failed')
          }
        } else if (mutation.kind === 'dispatch_grant') {
          const result = rebuilt.registerDispatchGrant(mutation.value.signedDispatchGrant)
          if (result !== 'stored' || rebuilt.revision !== mutation.value.recordedRevision) {
            throw stateError('invalid_snapshot', 'Dispatch-grant revision replay failed')
          }
        } else if (mutation.kind === 'revocation') {
          const result = rebuilt.registerRevocation(mutation.value.signedRevocation)
          if (result !== 'stored' || rebuilt.revision !== mutation.value.recordedRevision) {
            throw stateError('invalid_snapshot', 'Revocation revision replay failed')
          }
        } else {
          const result = rebuilt.consumeDispatch({
            grantId: mutation.value.grantId,
            triggerMessageId: mutation.value.triggerMessageId,
            mentionerMemberId: mutation.value.mentionerMemberId,
            workspaceIdentityHash: mutation.value.workspaceIdentityHash,
            permissionPostureHash: mutation.value.permissionPostureHash,
            at: mutation.value.consumedAt
          })
          if (
            result.kind !== 'authorized' ||
            !sameJson(result.consumption, mutation.value) ||
            rebuilt.revision !== mutation.value.recordedRevision
          ) {
            throw stateError('invalid_snapshot', 'Dispatch-consumption revision replay failed')
          }
        }
      }
    } catch (error) {
      if (error instanceof ChannelAgentAuthorityStateError && error.code === 'owner_unavailable') {
        throw error
      }
      throw stateError('invalid_snapshot', 'Channel agent authority snapshot replay failed')
    }
    if (!sameJson(rebuilt.snapshot(), snapshot)) {
      throw stateError('invalid_snapshot', 'Channel agent authority snapshot is not canonical')
    }
    return rebuilt
  }

  snapshot(): ChannelAgentAuthoritySnapshot {
    return clone({
      schemaVersion: CHANNEL_AGENT_AUTHORITY_STATE_VERSION,
      channelId: this.channelId,
      ownerMemberId: this.ownerMemberId,
      revision: this.revision,
      delegations: this.delegations,
      dispatchGrants: this.dispatchGrants,
      revocations: this.revocations,
      consumptions: this.consumptions
    })
  }

  registerDelegation(value: unknown): 'stored' | 'existing' {
    const signed = parseSignedChannelAgentDelegation(value)
    if (!signed) throw stateError('invalid_input', 'Signed Channel agent delegation is invalid')
    this.assertRootBinding(signed.delegation.channelId, signed.delegation.ownerMemberId)
    const existing = this.delegations.find(
      (entry) => delegationId(entry) === signed.delegation.delegationId
    )
    if (existing) {
      if (sameJson(existing.signedDelegation, signed)) return 'existing'
      throw stateError(
        'id_conflict',
        'Channel agent delegation id conflicts with durable authority'
      )
    }
    if (this.delegations.length >= CHANNEL_AGENT_AUTHORITY_MAX_DELEGATIONS) {
      throw stateError('capacity_exceeded', 'Channel agent delegation capacity is exhausted')
    }
    const ownerPublicKey = this.ownerPublicKey()
    const verified = verifyChannelAgentDelegation(
      ownerPublicKey,
      signed,
      signed.delegation.notBefore
    )
    if (!verified.ok) {
      throw stateError('signature_invalid', 'Channel agent delegation signature is invalid')
    }
    this.assertNextGeneration(signed)
    const recorded: RecordedChannelAgentDelegation = {
      recordedRevision: this.nextRevision(),
      signedDelegation: signed
    }
    this.delegations.push(recorded)
    sortDelegations(this.delegations)
    return 'stored'
  }

  registerDispatchGrant(value: unknown): 'stored' | 'existing' {
    const signed = parseSignedChannelAgentDispatchGrant(value)
    if (!signed) throw stateError('invalid_input', 'Signed Channel agent dispatch grant is invalid')
    this.assertRootBinding(signed.grant.channelId, signed.grant.ownerMemberId)
    const existing = this.dispatchGrants.find((entry) => grantId(entry) === signed.grant.grantId)
    if (existing) {
      if (sameJson(existing.signedDispatchGrant, signed)) return 'existing'
      throw stateError('id_conflict', 'Channel agent grant id conflicts with durable authority')
    }
    if (this.dispatchGrants.length >= CHANNEL_AGENT_AUTHORITY_MAX_GRANTS) {
      throw stateError('capacity_exceeded', 'Channel agent dispatch-grant capacity is exhausted')
    }
    const delegation = this.delegations.find(
      (entry) => delegationId(entry) === signed.grant.delegationId
    )
    if (!delegation) {
      throw stateError('target_not_found', 'Channel agent grant delegation does not exist')
    }
    const verified = verifyChannelAgentDispatchGrant({
      ownerPublicKey: this.ownerPublicKey(),
      delegation: delegation.signedDelegation,
      dispatchGrant: signed,
      mentionerMemberId: signed.grant.allowedMentionerMemberIds[0],
      workspaceIdentityHash: signed.grant.workspaceIdentityHash,
      permissionPostureHash: signed.grant.permissionPostureHash,
      at: signed.grant.notBefore
    })
    if (!verified.ok && verified.error === 'owner_signature_invalid') {
      throw stateError('signature_invalid', 'Channel agent grant signature is invalid')
    }
    if (!verified.ok || signed.grant.expiresAt > delegation.signedDelegation.delegation.expiresAt) {
      throw stateError('binding_mismatch', 'Channel agent grant does not match its delegation')
    }
    if (
      this.isAuthorityRevoked(
        delegation.signedDelegation,
        signed.grant.grantId,
        signed.grant.notBefore,
        this.revision + 1
      )
    ) {
      throw stateError('revocation_conflict', 'Channel agent grant targets revoked authority')
    }
    const recorded: RecordedChannelAgentDispatchGrant = {
      recordedRevision: this.nextRevision(),
      signedDispatchGrant: signed
    }
    this.dispatchGrants.push(recorded)
    sortGrants(this.dispatchGrants)
    return 'stored'
  }

  registerRevocation(value: unknown): 'stored' | 'existing' {
    const signed = parseSignedChannelAgentRevocation(value)
    if (!signed) throw stateError('invalid_input', 'Signed Channel agent revocation is invalid')
    this.assertRootBinding(signed.revocation.channelId, signed.revocation.ownerMemberId)
    const existing = this.revocations.find(
      (entry) => revocationId(entry) === signed.revocation.revocationId
    )
    if (existing) {
      if (sameJson(existing.signedRevocation, signed)) return 'existing'
      throw stateError(
        'id_conflict',
        'Channel agent revocation id conflicts with durable authority'
      )
    }
    if (this.revocations.length >= CHANNEL_AGENT_AUTHORITY_MAX_REVOCATIONS) {
      throw stateError('capacity_exceeded', 'Channel agent revocation capacity is exhausted')
    }
    const verified = verifyChannelAgentRevocation(
      this.ownerPublicKey(),
      signed,
      signed.revocation.revokedAt
    )
    if (!verified.ok) {
      throw stateError('signature_invalid', 'Channel agent revocation signature is invalid')
    }
    const target = this.revocationTarget(signed)
    if (!target)
      throw stateError('target_not_found', 'Channel agent revocation target does not exist')
    for (const consumption of this.consumptions) {
      if (!this.revocationMatchesConsumption(signed, consumption)) continue
      if (consumption.consumedAt > signed.revocation.revokedAt) {
        throw stateError(
          'revocation_conflict',
          'Channel agent revocation would rewrite consumed authority history'
        )
      }
    }
    const recorded: RecordedChannelAgentRevocation = {
      recordedRevision: this.nextRevision(),
      signedRevocation: signed
    }
    this.revocations.push(recorded)
    sortRevocations(this.revocations)
    return 'stored'
  }

  consumeDispatch(input: ConsumeChannelAgentDispatchInput): ChannelAgentDispatchConsumptionResult {
    this.assertConsumptionInput(input)
    const grant = this.dispatchGrants.find((entry) => grantId(entry) === input.grantId)
    if (!grant) return { kind: 'denied', reason: 'dispatch_grant_missing' }
    const duplicate = this.consumptions.find(
      (entry) =>
        entry.grantId === input.grantId && entry.triggerMessageId === input.triggerMessageId
    )
    if (duplicate) return { kind: 'duplicate', consumption: clone(duplicate) }
    const delegation = this.delegations.find(
      (entry) => delegationId(entry) === grant.signedDispatchGrant.grant.delegationId
    )
    if (!delegation) return { kind: 'denied', reason: 'delegation_missing' }
    const delegationValue = delegation.signedDelegation.delegation
    const grantValue = grant.signedDispatchGrant.grant
    if (input.at < delegationValue.notBefore || input.at < grantValue.notBefore) {
      return { kind: 'denied', reason: 'authority_not_yet_valid' }
    }
    if (input.at >= delegationValue.expiresAt || input.at >= grantValue.expiresAt) {
      return { kind: 'denied', reason: 'authority_expired' }
    }
    if (
      this.isAuthorityRevoked(
        delegation.signedDelegation,
        grantValue.grantId,
        input.at,
        this.revision + 1
      )
    ) {
      return { kind: 'denied', reason: 'authority_revoked' }
    }
    if (!grantValue.allowedMentionerMemberIds.includes(input.mentionerMemberId)) {
      return { kind: 'denied', reason: 'mentioner_not_allowed' }
    }
    if (grantValue.workspaceIdentityHash !== input.workspaceIdentityHash) {
      return { kind: 'denied', reason: 'workspace_identity_mismatch' }
    }
    if (grantValue.permissionPostureHash !== input.permissionPostureHash) {
      return { kind: 'denied', reason: 'permission_posture_mismatch' }
    }
    const verified = verifyChannelAgentDispatchGrant({
      ownerPublicKey: this.ownerPublicKey(),
      delegation: delegation.signedDelegation,
      dispatchGrant: grant.signedDispatchGrant,
      mentionerMemberId: input.mentionerMemberId,
      workspaceIdentityHash: input.workspaceIdentityHash,
      permissionPostureHash: input.permissionPostureHash,
      at: input.at
    })
    if (!verified.ok) {
      throw stateError('signature_invalid', 'Stored Channel agent dispatch authority is invalid')
    }
    const prior = this.consumptions.filter((entry) => entry.grantId === input.grantId)
    if (prior.length >= grantValue.maxDispatches) {
      return { kind: 'denied', reason: 'dispatch_budget_exhausted' }
    }
    if (this.consumptions.length >= CHANNEL_AGENT_AUTHORITY_MAX_CONSUMPTIONS) {
      throw stateError('capacity_exceeded', 'Channel agent consumption capacity is exhausted')
    }
    const consumption: ChannelAgentDispatchConsumption = {
      schemaVersion: CHANNEL_AGENT_AUTHORITY_STATE_VERSION,
      recordedRevision: this.nextRevision(),
      channelId: this.channelId,
      grantId: input.grantId,
      triggerMessageId: input.triggerMessageId,
      mentionerMemberId: input.mentionerMemberId,
      workspaceIdentityHash: input.workspaceIdentityHash,
      permissionPostureHash: input.permissionPostureHash,
      dispatchOrdinal: prior.length + 1,
      consumedAt: input.at
    }
    this.consumptions.push(consumption)
    sortConsumptions(this.consumptions)
    return {
      kind: 'authorized',
      delegation: clone(delegation.signedDelegation),
      dispatchGrant: clone(grant.signedDispatchGrant),
      consumption: clone(consumption),
      remainingDispatches: grantValue.maxDispatches - consumption.dispatchOrdinal
    }
  }

  getDelegation(id: string): SignedChannelAgentDelegation | null {
    if (!isIdentifier(id)) return null
    const value = this.delegations.find((entry) => delegationId(entry) === id)
    return value ? clone(value.signedDelegation) : null
  }

  getDispatchGrant(id: string): SignedChannelAgentDispatchGrant | null {
    if (!isIdentifier(id)) return null
    const value = this.dispatchGrants.find((entry) => grantId(entry) === id)
    return value ? clone(value.signedDispatchGrant) : null
  }

  getConsumption(grant: string, triggerMessageId: string): ChannelAgentDispatchConsumption | null {
    if (!isIdentifier(grant) || !isIdentifier(triggerMessageId)) return null
    const value = this.consumptions.find(
      (entry) => entry.grantId === grant && entry.triggerMessageId === triggerMessageId
    )
    return value ? clone(value) : null
  }

  private assertRootBinding(channelId: string, ownerMemberId: string): void {
    if (channelId !== this.channelId || ownerMemberId !== this.ownerMemberId) {
      throw stateError('binding_mismatch', 'Signed Channel agent authority has the wrong root')
    }
  }

  private ownerPublicKey(): KeyObject {
    let value: KeyObject | null
    try {
      value = this.resolveOwnerPublicKey(this.channelId, this.ownerMemberId)
    } catch {
      value = null
    }
    if (!value || value.type !== 'public' || value.asymmetricKeyType !== 'ed25519') {
      throw stateError('owner_unavailable', 'Pinned Channel owner identity is unavailable')
    }
    return value
  }

  private nextRevision(): number {
    if (!Number.isSafeInteger(this.revision + 1)) {
      throw stateError('capacity_exceeded', 'Channel agent authority revision is exhausted')
    }
    this.revision += 1
    return this.revision
  }

  private assertNextGeneration(signed: SignedChannelAgentDelegation): void {
    const candidate = signed.delegation
    const sameSeat = this.delegations.filter(
      (entry) => entry.signedDelegation.delegation.agentSeatId === candidate.agentSeatId
    )
    if (sameSeat.length === 0) {
      if (candidate.keyGeneration !== 1) {
        throw stateError('generation_rollback', 'First Channel agent key generation must be one')
      }
      return
    }
    const maximumGeneration = Math.max(
      ...sameSeat.map((entry) => entry.signedDelegation.delegation.keyGeneration)
    )
    if (candidate.keyGeneration < maximumGeneration) {
      throw stateError('generation_rollback', 'Channel agent key generation moved backwards')
    }
    const current = sameSeat.filter(
      (entry) => entry.signedDelegation.delegation.keyGeneration === maximumGeneration
    )
    const currentPublicKey = current[0].signedDelegation.delegation.agentPublicKeyB64
    if (
      current.some(
        (entry) => entry.signedDelegation.delegation.agentPublicKeyB64 !== currentPublicKey
      )
    ) {
      throw stateError(
        'generation_rollback',
        'Current Channel agent generation has conflicting keys'
      )
    }
    if (candidate.keyGeneration === maximumGeneration) {
      if (candidate.agentPublicKeyB64 !== currentPublicKey) {
        throw stateError(
          'generation_rollback',
          'Channel agent generation cannot change key material'
        )
      }
      const keyRevoked = current.some((entry) =>
        this.hasEffectiveKeyRevocation(
          entry.signedDelegation,
          candidate.notBefore,
          this.revision + 1
        )
      )
      if (keyRevoked) {
        throw stateError('revocation_conflict', 'Revoked Channel agent key cannot be re-delegated')
      }
      return
    }
    if (candidate.keyGeneration !== maximumGeneration + 1) {
      throw stateError('generation_rollback', 'Channel agent key generation is not contiguous')
    }
    const previous = current[0].signedDelegation
    if (!this.hasEffectiveKeyRevocation(previous, candidate.notBefore, this.revision + 1)) {
      throw stateError(
        'revocation_conflict',
        'Prior Channel agent key must be revoked before rotation is delegated'
      )
    }
  }

  private revocationTarget(
    signed: SignedChannelAgentRevocation
  ): RecordedChannelAgentDelegation | RecordedChannelAgentDispatchGrant | null {
    const revocation = signed.revocation
    if (revocation.targetKind === 'delegation') {
      const target = this.delegations.find((entry) => delegationId(entry) === revocation.targetId)
      return target && this.revocationMatchesDelegation(signed, target.signedDelegation)
        ? target
        : null
    }
    if (revocation.targetKind === 'dispatch_grant') {
      const target = this.dispatchGrants.find((entry) => grantId(entry) === revocation.targetId)
      if (!target) return null
      const delegation = this.delegations.find(
        (entry) => delegationId(entry) === target.signedDispatchGrant.grant.delegationId
      )
      return delegation && this.revocationMatchesDelegation(signed, delegation.signedDelegation)
        ? target
        : null
    }
    return (
      this.delegations.find((entry) =>
        this.revocationMatchesDelegation(signed, entry.signedDelegation)
      ) ?? null
    )
  }

  private revocationMatchesDelegation(
    signed: SignedChannelAgentRevocation,
    delegation: SignedChannelAgentDelegation
  ): boolean {
    const revocation = signed.revocation
    const value = delegation.delegation
    if (
      revocation.channelId !== value.channelId ||
      revocation.ownerMemberId !== value.ownerMemberId ||
      revocation.agentSeatId !== value.agentSeatId ||
      revocation.keyGeneration !== value.keyGeneration
    ) {
      return false
    }
    if (revocation.targetKind === 'delegation') {
      return revocation.targetId === value.delegationId
    }
    if (revocation.targetKind === 'agent_key') {
      return revocation.targetId === channelAgentPublicKeyFingerprint(value.agentPublicKeyB64)
    }
    return true
  }

  private revocationMatchesConsumption(
    signed: SignedChannelAgentRevocation,
    consumption: ChannelAgentDispatchConsumption
  ): boolean {
    const grant = this.dispatchGrants.find((entry) => grantId(entry) === consumption.grantId)
    if (!grant) return false
    if (
      signed.revocation.targetKind === 'dispatch_grant' &&
      signed.revocation.targetId !== consumption.grantId
    ) {
      return false
    }
    const delegation = this.delegations.find(
      (entry) => delegationId(entry) === grant.signedDispatchGrant.grant.delegationId
    )
    return Boolean(
      delegation && this.revocationMatchesDelegation(signed, delegation.signedDelegation)
    )
  }

  private hasEffectiveKeyRevocation(
    delegation: SignedChannelAgentDelegation,
    at: number,
    prospectiveRevision: number
  ): boolean {
    return this.revocations.some(
      (entry) =>
        entry.signedRevocation.revocation.targetKind === 'agent_key' &&
        this.revocationMatchesDelegation(entry.signedRevocation, delegation) &&
        this.revocationEffective(entry, at, prospectiveRevision)
    )
  }

  private isAuthorityRevoked(
    delegation: SignedChannelAgentDelegation,
    dispatchGrantId: string,
    at: number,
    prospectiveRevision: number
  ): boolean {
    return this.revocations.some((entry) => {
      const revocation = entry.signedRevocation.revocation
      if (!this.revocationMatchesDelegation(entry.signedRevocation, delegation)) return false
      if (revocation.targetKind === 'dispatch_grant' && revocation.targetId !== dispatchGrantId) {
        return false
      }
      return this.revocationEffective(entry, at, prospectiveRevision)
    })
  }

  private revocationEffective(
    entry: RecordedChannelAgentRevocation,
    at: number,
    prospectiveRevision: number
  ): boolean {
    const revokedAt = entry.signedRevocation.revocation.revokedAt
    return revokedAt < at || (revokedAt === at && entry.recordedRevision < prospectiveRevision)
  }

  private assertConsumptionInput(input: ConsumeChannelAgentDispatchInput): void {
    if (
      !isPlainObject(input) ||
      !hasExactKeys(input, [
        'grantId',
        'triggerMessageId',
        'mentionerMemberId',
        'workspaceIdentityHash',
        'permissionPostureHash',
        'at'
      ]) ||
      !isIdentifier(input.grantId) ||
      !isIdentifier(input.triggerMessageId) ||
      !isIdentifier(input.mentionerMemberId) ||
      !isDigest(input.workspaceIdentityHash) ||
      !isDigest(input.permissionPostureHash) ||
      !isTimestamp(input.at)
    ) {
      throw stateError('invalid_input', 'Channel agent dispatch consumption input is invalid')
    }
  }
}
