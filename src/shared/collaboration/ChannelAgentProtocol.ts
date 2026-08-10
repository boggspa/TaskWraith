import { createHash, type KeyObject } from 'crypto'

import { b64, importRawEd25519PublicKey, signEd25519, verifyEd25519 } from '../e2ee/keys'

export const CHANNEL_AGENT_PROTOCOL_VERSION = 1 as const
export const CHANNEL_AGENT_MAX_IDENTIFIER = 512
export const CHANNEL_AGENT_MAX_POST_BYTES = 8_000
export const CHANNEL_AGENT_MAX_MEMBERS = 8
export const CHANNEL_AGENT_MAX_DISPATCHES = 10_000
export const CHANNEL_AGENT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000

export const CHANNEL_AGENT_SIGNATURE_DOMAINS = {
  delegation: 'taskwraith.channel.agent-delegation.v1',
  dispatchGrant: 'taskwraith.channel.agent-dispatch-grant.v1',
  post: 'taskwraith.channel.agent-post.v1',
  revocation: 'taskwraith.channel.agent-revocation.v1'
} as const

export type ChannelAgentSignatureDomain =
  (typeof CHANNEL_AGENT_SIGNATURE_DOMAINS)[keyof typeof CHANNEL_AGENT_SIGNATURE_DOMAINS]

export type ChannelAgentDelegationScope = 'channel.dispatch' | 'channel.post'

export interface ChannelAgentDelegation {
  readonly schemaVersion: typeof CHANNEL_AGENT_PROTOCOL_VERSION
  readonly delegationId: string
  readonly channelId: string
  readonly ownerMemberId: string
  readonly agentMemberId: string
  /** Stable pooled-Agent id or persisted per-chat seat id; never a run id. */
  readonly agentSeatId: string
  /** Canonical base64 raw 32-byte Ed25519 public key. */
  readonly agentPublicKeyB64: string
  /** Monotonic per-seat key generation. Rotation always increments it. */
  readonly keyGeneration: number
  /** Sorted, unique, non-empty authority set. */
  readonly scopes: readonly ChannelAgentDelegationScope[]
  readonly issuedAt: number
  readonly notBefore: number
  readonly expiresAt: number
  readonly maxPostBytes: number
}

export interface SignedChannelAgentDelegation {
  readonly delegation: ChannelAgentDelegation
  /** Owner Channel identity signature over the domain-separated delegation. */
  readonly ownerSignatureB64: string
}

export interface ChannelAgentDispatchGrant {
  readonly schemaVersion: typeof CHANNEL_AGENT_PROTOCOL_VERSION
  readonly grantId: string
  readonly channelId: string
  readonly ownerMemberId: string
  readonly agentMemberId: string
  readonly agentSeatId: string
  readonly agentPublicKeyB64: string
  readonly keyGeneration: number
  readonly delegationId: string
  readonly trigger: 'mention'
  /** Sorted exact human member ids whose mentions may dispatch this seat. */
  readonly allowedMentionerMemberIds: readonly string[]
  /** SHA-256 of the main-resolved workspace principal, never a local path. */
  readonly workspaceIdentityHash: string
  /** SHA-256 of the exact main-authored run-permission posture. */
  readonly permissionPostureHash: string
  readonly issuedAt: number
  readonly notBefore: number
  readonly expiresAt: number
  readonly maxDispatches: number
}

export interface SignedChannelAgentDispatchGrant {
  readonly grant: ChannelAgentDispatchGrant
  readonly ownerSignatureB64: string
}

export interface ChannelAgentPost {
  readonly schemaVersion: typeof CHANNEL_AGENT_PROTOCOL_VERSION
  readonly channelId: string
  readonly agentMemberId: string
  readonly agentSeatId: string
  readonly agentPublicKeyB64: string
  readonly keyGeneration: number
  readonly delegationId: string
  readonly dispatchGrantId: string
  readonly triggerMessageId: string
  readonly runId: string
  /** Digest of the authoritative launch seal and effective run posture. */
  readonly runAuthorityHash: string
  readonly clientMessageId: string
  readonly kind: 'agent.text'
  readonly content: string
  readonly contentHash: string
  readonly createdAt: number
}

export interface SignedChannelAgentPost {
  readonly post: ChannelAgentPost
  readonly agentSignatureB64: string
}

export type ChannelAgentRevocationTarget = 'agent_key' | 'delegation' | 'dispatch_grant'
export type ChannelAgentRevocationReason =
  | 'agent_removed'
  | 'channel_closed'
  | 'key_rotated'
  | 'owner_revoked'

export interface ChannelAgentRevocation {
  readonly schemaVersion: typeof CHANNEL_AGENT_PROTOCOL_VERSION
  readonly revocationId: string
  readonly channelId: string
  readonly ownerMemberId: string
  readonly agentSeatId: string
  readonly keyGeneration: number
  readonly targetKind: ChannelAgentRevocationTarget
  readonly targetId: string
  readonly revokedAt: number
  readonly reason: ChannelAgentRevocationReason
}

export interface SignedChannelAgentRevocation {
  readonly revocation: ChannelAgentRevocation
  readonly ownerSignatureB64: string
}

export type ChannelAgentVerificationError =
  | 'agent_signature_invalid'
  | 'authority_binding_mismatch'
  | 'authority_expired'
  | 'authority_not_yet_valid'
  | 'delegation_invalid'
  | 'delegation_scope_missing'
  | 'dispatch_grant_invalid'
  | 'dispatch_mentioner_not_allowed'
  | 'owner_signature_invalid'
  | 'post_invalid'
  | 'post_timestamp_invalid'
  | 'revocation_invalid'

export type ChannelAgentVerificationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ChannelAgentVerificationError }

function ok<T>(value: T): ChannelAgentVerificationResult<T> {
  return { ok: true, value }
}

function fail(error: ChannelAgentVerificationError): ChannelAgentVerificationResult<never> {
  return { ok: false, error }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  if (actual.length !== keys.length) return false
  const expected = new Set(keys)
  return actual.every((key) => expected.has(key))
}

function isSafeIdentifier(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > CHANNEL_AGENT_MAX_IDENTIFIER
  ) {
    return false
  }
  if (value.trim() !== value) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isPositiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= maximum
}

function isHexHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isCanonicalBase64(value: unknown, expectedBytes: number): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false
  try {
    const decoded = Buffer.from(value, 'base64')
    return decoded.length === expectedBytes && decoded.toString('base64') === value
  } catch {
    return false
  }
}

function isSortedUniqueStrings(
  value: unknown,
  maximumItems: number,
  validate: (entry: unknown) => entry is string
): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumItems) return false
  for (let index = 0; index < value.length; index += 1) {
    if (!validate(value[index])) return false
    if (index > 0 && String(value[index - 1]) >= String(value[index])) return false
  }
  return true
}

function stableJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical Channel agent value is non-finite')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`
  if (!isPlainObject(value)) throw new TypeError('Canonical Channel agent value is not plain JSON')
  const entries = Object.keys(value)
    .sort()
    .map((key) => {
      const entry = value[key]
      if (entry === undefined) {
        throw new TypeError('Canonical Channel agent value contains undefined')
      }
      return `${JSON.stringify(key)}:${stableJson(entry)}`
    })
  return `{${entries.join(',')}}`
}

/** Domain line + canonical UTF-8 JSON. Arrays preserve their validated order. */
export function canonicalChannelAgentStatement(
  domain: ChannelAgentSignatureDomain,
  value: unknown
): Buffer {
  if (!(Object.values(CHANNEL_AGENT_SIGNATURE_DOMAINS) as string[]).includes(domain)) {
    throw new TypeError('Unknown Channel agent signature domain')
  }
  return Buffer.from(`${domain}\n${stableJson(value)}`, 'utf8')
}

export function hashChannelAgentContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export function channelAgentPublicKeyFingerprint(publicKeyB64: string): string {
  if (!isCanonicalBase64(publicKeyB64, 32)) {
    throw new TypeError('Channel agent public key is not canonical raw Ed25519 base64')
  }
  return createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('hex')
}

export function parseChannelAgentDelegation(value: unknown): ChannelAgentDelegation | null {
  if (!isPlainObject(value)) return null
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'delegationId',
      'channelId',
      'ownerMemberId',
      'agentMemberId',
      'agentSeatId',
      'agentPublicKeyB64',
      'keyGeneration',
      'scopes',
      'issuedAt',
      'notBefore',
      'expiresAt',
      'maxPostBytes'
    ]) ||
    value.schemaVersion !== CHANNEL_AGENT_PROTOCOL_VERSION ||
    !isSafeIdentifier(value.delegationId) ||
    !isSafeIdentifier(value.channelId) ||
    !isSafeIdentifier(value.ownerMemberId) ||
    !isSafeIdentifier(value.agentMemberId) ||
    !isSafeIdentifier(value.agentSeatId) ||
    !isCanonicalBase64(value.agentPublicKeyB64, 32) ||
    !isPositiveInteger(value.keyGeneration) ||
    !isSortedUniqueStrings(
      value.scopes,
      2,
      (entry): entry is ChannelAgentDelegationScope =>
        entry === 'channel.dispatch' || entry === 'channel.post'
    ) ||
    !isTimestamp(value.issuedAt) ||
    !isTimestamp(value.notBefore) ||
    !isTimestamp(value.expiresAt) ||
    value.issuedAt > value.notBefore ||
    value.notBefore >= value.expiresAt ||
    !isPositiveInteger(value.maxPostBytes, CHANNEL_AGENT_MAX_POST_BYTES)
  ) {
    return null
  }
  return {
    schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
    delegationId: value.delegationId,
    channelId: value.channelId,
    ownerMemberId: value.ownerMemberId,
    agentMemberId: value.agentMemberId,
    agentSeatId: value.agentSeatId,
    agentPublicKeyB64: value.agentPublicKeyB64,
    keyGeneration: value.keyGeneration,
    scopes: [...value.scopes],
    issuedAt: value.issuedAt,
    notBefore: value.notBefore,
    expiresAt: value.expiresAt,
    maxPostBytes: value.maxPostBytes
  }
}

export function parseSignedChannelAgentDelegation(
  value: unknown
): SignedChannelAgentDelegation | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['delegation', 'ownerSignatureB64']) ||
    !isCanonicalBase64(value.ownerSignatureB64, 64)
  ) {
    return null
  }
  const delegation = parseChannelAgentDelegation(value.delegation)
  return delegation ? { delegation, ownerSignatureB64: value.ownerSignatureB64 } : null
}

export function parseChannelAgentDispatchGrant(value: unknown): ChannelAgentDispatchGrant | null {
  if (!isPlainObject(value)) return null
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'grantId',
      'channelId',
      'ownerMemberId',
      'agentMemberId',
      'agentSeatId',
      'agentPublicKeyB64',
      'keyGeneration',
      'delegationId',
      'trigger',
      'allowedMentionerMemberIds',
      'workspaceIdentityHash',
      'permissionPostureHash',
      'issuedAt',
      'notBefore',
      'expiresAt',
      'maxDispatches'
    ]) ||
    value.schemaVersion !== CHANNEL_AGENT_PROTOCOL_VERSION ||
    !isSafeIdentifier(value.grantId) ||
    !isSafeIdentifier(value.channelId) ||
    !isSafeIdentifier(value.ownerMemberId) ||
    !isSafeIdentifier(value.agentMemberId) ||
    !isSafeIdentifier(value.agentSeatId) ||
    !isCanonicalBase64(value.agentPublicKeyB64, 32) ||
    !isPositiveInteger(value.keyGeneration) ||
    !isSafeIdentifier(value.delegationId) ||
    value.trigger !== 'mention' ||
    !isSortedUniqueStrings(
      value.allowedMentionerMemberIds,
      CHANNEL_AGENT_MAX_MEMBERS,
      isSafeIdentifier
    ) ||
    !isHexHash(value.workspaceIdentityHash) ||
    !isHexHash(value.permissionPostureHash) ||
    !isTimestamp(value.issuedAt) ||
    !isTimestamp(value.notBefore) ||
    !isTimestamp(value.expiresAt) ||
    value.issuedAt > value.notBefore ||
    value.notBefore >= value.expiresAt ||
    !isPositiveInteger(value.maxDispatches, CHANNEL_AGENT_MAX_DISPATCHES)
  ) {
    return null
  }
  return {
    schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
    grantId: value.grantId,
    channelId: value.channelId,
    ownerMemberId: value.ownerMemberId,
    agentMemberId: value.agentMemberId,
    agentSeatId: value.agentSeatId,
    agentPublicKeyB64: value.agentPublicKeyB64,
    keyGeneration: value.keyGeneration,
    delegationId: value.delegationId,
    trigger: 'mention',
    allowedMentionerMemberIds: [...value.allowedMentionerMemberIds],
    workspaceIdentityHash: value.workspaceIdentityHash,
    permissionPostureHash: value.permissionPostureHash,
    issuedAt: value.issuedAt,
    notBefore: value.notBefore,
    expiresAt: value.expiresAt,
    maxDispatches: value.maxDispatches
  }
}

export function parseSignedChannelAgentDispatchGrant(
  value: unknown
): SignedChannelAgentDispatchGrant | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['grant', 'ownerSignatureB64']) ||
    !isCanonicalBase64(value.ownerSignatureB64, 64)
  ) {
    return null
  }
  const grant = parseChannelAgentDispatchGrant(value.grant)
  return grant ? { grant, ownerSignatureB64: value.ownerSignatureB64 } : null
}

export function parseChannelAgentPost(value: unknown): ChannelAgentPost | null {
  if (!isPlainObject(value)) return null
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'channelId',
      'agentMemberId',
      'agentSeatId',
      'agentPublicKeyB64',
      'keyGeneration',
      'delegationId',
      'dispatchGrantId',
      'triggerMessageId',
      'runId',
      'runAuthorityHash',
      'clientMessageId',
      'kind',
      'content',
      'contentHash',
      'createdAt'
    ]) ||
    value.schemaVersion !== CHANNEL_AGENT_PROTOCOL_VERSION ||
    !isSafeIdentifier(value.channelId) ||
    !isSafeIdentifier(value.agentMemberId) ||
    !isSafeIdentifier(value.agentSeatId) ||
    !isCanonicalBase64(value.agentPublicKeyB64, 32) ||
    !isPositiveInteger(value.keyGeneration) ||
    !isSafeIdentifier(value.delegationId) ||
    !isSafeIdentifier(value.dispatchGrantId) ||
    !isSafeIdentifier(value.triggerMessageId) ||
    !isSafeIdentifier(value.runId) ||
    !isHexHash(value.runAuthorityHash) ||
    !isSafeIdentifier(value.clientMessageId) ||
    value.kind !== 'agent.text' ||
    typeof value.content !== 'string' ||
    value.content.trim().length === 0 ||
    Buffer.byteLength(value.content, 'utf8') > CHANNEL_AGENT_MAX_POST_BYTES ||
    !isHexHash(value.contentHash) ||
    hashChannelAgentContent(value.content) !== value.contentHash ||
    !isTimestamp(value.createdAt)
  ) {
    return null
  }
  return {
    schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
    channelId: value.channelId,
    agentMemberId: value.agentMemberId,
    agentSeatId: value.agentSeatId,
    agentPublicKeyB64: value.agentPublicKeyB64,
    keyGeneration: value.keyGeneration,
    delegationId: value.delegationId,
    dispatchGrantId: value.dispatchGrantId,
    triggerMessageId: value.triggerMessageId,
    runId: value.runId,
    runAuthorityHash: value.runAuthorityHash,
    clientMessageId: value.clientMessageId,
    kind: 'agent.text',
    content: value.content,
    contentHash: value.contentHash,
    createdAt: value.createdAt
  }
}

export function parseSignedChannelAgentPost(value: unknown): SignedChannelAgentPost | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['post', 'agentSignatureB64']) ||
    !isCanonicalBase64(value.agentSignatureB64, 64)
  ) {
    return null
  }
  const post = parseChannelAgentPost(value.post)
  return post ? { post, agentSignatureB64: value.agentSignatureB64 } : null
}

export function parseChannelAgentRevocation(value: unknown): ChannelAgentRevocation | null {
  if (!isPlainObject(value)) return null
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'revocationId',
      'channelId',
      'ownerMemberId',
      'agentSeatId',
      'keyGeneration',
      'targetKind',
      'targetId',
      'revokedAt',
      'reason'
    ]) ||
    value.schemaVersion !== CHANNEL_AGENT_PROTOCOL_VERSION ||
    !isSafeIdentifier(value.revocationId) ||
    !isSafeIdentifier(value.channelId) ||
    !isSafeIdentifier(value.ownerMemberId) ||
    !isSafeIdentifier(value.agentSeatId) ||
    !isPositiveInteger(value.keyGeneration) ||
    (value.targetKind !== 'agent_key' &&
      value.targetKind !== 'delegation' &&
      value.targetKind !== 'dispatch_grant') ||
    !isSafeIdentifier(value.targetId) ||
    !isTimestamp(value.revokedAt) ||
    (value.reason !== 'agent_removed' &&
      value.reason !== 'channel_closed' &&
      value.reason !== 'key_rotated' &&
      value.reason !== 'owner_revoked')
  ) {
    return null
  }
  return {
    schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
    revocationId: value.revocationId,
    channelId: value.channelId,
    ownerMemberId: value.ownerMemberId,
    agentSeatId: value.agentSeatId,
    keyGeneration: value.keyGeneration,
    targetKind: value.targetKind,
    targetId: value.targetId,
    revokedAt: value.revokedAt,
    reason: value.reason
  }
}

export function parseSignedChannelAgentRevocation(
  value: unknown
): SignedChannelAgentRevocation | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['revocation', 'ownerSignatureB64']) ||
    !isCanonicalBase64(value.ownerSignatureB64, 64)
  ) {
    return null
  }
  const revocation = parseChannelAgentRevocation(value.revocation)
  return revocation ? { revocation, ownerSignatureB64: value.ownerSignatureB64 } : null
}

function signStatement(
  privateKey: KeyObject,
  domain: ChannelAgentSignatureDomain,
  value: unknown
): string {
  return b64.encode(signEd25519(privateKey, canonicalChannelAgentStatement(domain, value)))
}

function signatureVerifies(
  publicKey: KeyObject,
  domain: ChannelAgentSignatureDomain,
  value: unknown,
  signatureB64: string
): boolean {
  if (!isCanonicalBase64(signatureB64, 64)) return false
  return verifyEd25519(
    publicKey,
    canonicalChannelAgentStatement(domain, value),
    Buffer.from(signatureB64, 'base64')
  )
}

export function signChannelAgentDelegation(
  ownerPrivateKey: KeyObject,
  value: ChannelAgentDelegation
): SignedChannelAgentDelegation {
  const delegation = parseChannelAgentDelegation(value)
  if (!delegation) throw new TypeError('Channel agent delegation is invalid')
  return {
    delegation,
    ownerSignatureB64: signStatement(
      ownerPrivateKey,
      CHANNEL_AGENT_SIGNATURE_DOMAINS.delegation,
      delegation
    )
  }
}

export function signChannelAgentDispatchGrant(
  ownerPrivateKey: KeyObject,
  value: ChannelAgentDispatchGrant
): SignedChannelAgentDispatchGrant {
  const grant = parseChannelAgentDispatchGrant(value)
  if (!grant) throw new TypeError('Channel agent dispatch grant is invalid')
  return {
    grant,
    ownerSignatureB64: signStatement(
      ownerPrivateKey,
      CHANNEL_AGENT_SIGNATURE_DOMAINS.dispatchGrant,
      grant
    )
  }
}

export function signChannelAgentPost(
  agentPrivateKey: KeyObject,
  value: ChannelAgentPost
): SignedChannelAgentPost {
  const post = parseChannelAgentPost(value)
  if (!post) throw new TypeError('Channel agent post is invalid')
  return {
    post,
    agentSignatureB64: signStatement(agentPrivateKey, CHANNEL_AGENT_SIGNATURE_DOMAINS.post, post)
  }
}

export function signChannelAgentRevocation(
  ownerPrivateKey: KeyObject,
  value: ChannelAgentRevocation
): SignedChannelAgentRevocation {
  const revocation = parseChannelAgentRevocation(value)
  if (!revocation) throw new TypeError('Channel agent revocation is invalid')
  return {
    revocation,
    ownerSignatureB64: signStatement(
      ownerPrivateKey,
      CHANNEL_AGENT_SIGNATURE_DOMAINS.revocation,
      revocation
    )
  }
}

function authorityTimeResult(
  notBefore: number,
  expiresAt: number,
  at: number
): ChannelAgentVerificationResult<true> {
  if (!isTimestamp(at) || at < notBefore) return fail('authority_not_yet_valid')
  if (at >= expiresAt) return fail('authority_expired')
  return ok(true)
}

export function verifyChannelAgentDelegation(
  ownerPublicKey: KeyObject,
  value: unknown,
  at = Date.now()
): ChannelAgentVerificationResult<SignedChannelAgentDelegation> {
  const signed = parseSignedChannelAgentDelegation(value)
  if (!signed) return fail('delegation_invalid')
  if (
    !signatureVerifies(
      ownerPublicKey,
      CHANNEL_AGENT_SIGNATURE_DOMAINS.delegation,
      signed.delegation,
      signed.ownerSignatureB64
    )
  ) {
    return fail('owner_signature_invalid')
  }
  const time = authorityTimeResult(signed.delegation.notBefore, signed.delegation.expiresAt, at)
  return time.ok ? ok(signed) : time
}

function bindingsMatch(
  delegation: ChannelAgentDelegation,
  value: Pick<
    ChannelAgentDispatchGrant | ChannelAgentPost,
    | 'agentMemberId'
    | 'agentPublicKeyB64'
    | 'agentSeatId'
    | 'channelId'
    | 'delegationId'
    | 'keyGeneration'
  >
): boolean {
  return (
    value.channelId === delegation.channelId &&
    value.delegationId === delegation.delegationId &&
    value.agentMemberId === delegation.agentMemberId &&
    value.agentSeatId === delegation.agentSeatId &&
    value.agentPublicKeyB64 === delegation.agentPublicKeyB64 &&
    value.keyGeneration === delegation.keyGeneration
  )
}

export function verifyChannelAgentDispatchGrant(args: {
  readonly ownerPublicKey: KeyObject
  readonly delegation: unknown
  readonly dispatchGrant: unknown
  readonly mentionerMemberId: string
  readonly workspaceIdentityHash: string
  readonly permissionPostureHash: string
  readonly at?: number
}): ChannelAgentVerificationResult<{
  readonly delegation: SignedChannelAgentDelegation
  readonly dispatchGrant: SignedChannelAgentDispatchGrant
}> {
  const at = args.at ?? Date.now()
  const delegation = verifyChannelAgentDelegation(args.ownerPublicKey, args.delegation, at)
  if (!delegation.ok) return delegation
  if (!delegation.value.delegation.scopes.includes('channel.dispatch')) {
    return fail('delegation_scope_missing')
  }
  const dispatchGrant = parseSignedChannelAgentDispatchGrant(args.dispatchGrant)
  if (!dispatchGrant) return fail('dispatch_grant_invalid')
  if (
    !signatureVerifies(
      args.ownerPublicKey,
      CHANNEL_AGENT_SIGNATURE_DOMAINS.dispatchGrant,
      dispatchGrant.grant,
      dispatchGrant.ownerSignatureB64
    )
  ) {
    return fail('owner_signature_invalid')
  }
  const time = authorityTimeResult(dispatchGrant.grant.notBefore, dispatchGrant.grant.expiresAt, at)
  if (!time.ok) return time
  if (
    dispatchGrant.grant.ownerMemberId !== delegation.value.delegation.ownerMemberId ||
    !bindingsMatch(delegation.value.delegation, dispatchGrant.grant) ||
    dispatchGrant.grant.workspaceIdentityHash !== args.workspaceIdentityHash ||
    dispatchGrant.grant.permissionPostureHash !== args.permissionPostureHash
  ) {
    return fail('authority_binding_mismatch')
  }
  if (!dispatchGrant.grant.allowedMentionerMemberIds.includes(args.mentionerMemberId)) {
    return fail('dispatch_mentioner_not_allowed')
  }
  return ok({ delegation: delegation.value, dispatchGrant })
}

export function verifyChannelAgentPost(args: {
  readonly ownerPublicKey: KeyObject
  readonly delegation: unknown
  readonly post: unknown
  readonly at?: number
}): ChannelAgentVerificationResult<{
  readonly delegation: SignedChannelAgentDelegation
  readonly post: SignedChannelAgentPost
}> {
  const at = args.at ?? Date.now()
  const delegation = verifyChannelAgentDelegation(args.ownerPublicKey, args.delegation, at)
  if (!delegation.ok) return delegation
  if (!delegation.value.delegation.scopes.includes('channel.post')) {
    return fail('delegation_scope_missing')
  }
  const post = parseSignedChannelAgentPost(args.post)
  if (!post) return fail('post_invalid')
  if (
    post.post.createdAt < delegation.value.delegation.notBefore ||
    post.post.createdAt >= delegation.value.delegation.expiresAt ||
    post.post.createdAt > at + CHANNEL_AGENT_MAX_CLOCK_SKEW_MS
  ) {
    return fail('post_timestamp_invalid')
  }
  if (
    !bindingsMatch(delegation.value.delegation, post.post) ||
    Buffer.byteLength(post.post.content, 'utf8') > delegation.value.delegation.maxPostBytes
  ) {
    return fail('authority_binding_mismatch')
  }
  let agentPublicKey: KeyObject
  try {
    agentPublicKey = importRawEd25519PublicKey(
      Buffer.from(delegation.value.delegation.agentPublicKeyB64, 'base64')
    )
  } catch {
    return fail('delegation_invalid')
  }
  if (
    !signatureVerifies(
      agentPublicKey,
      CHANNEL_AGENT_SIGNATURE_DOMAINS.post,
      post.post,
      post.agentSignatureB64
    )
  ) {
    return fail('agent_signature_invalid')
  }
  return ok({ delegation: delegation.value, post })
}

export function verifyChannelAgentRevocation(
  ownerPublicKey: KeyObject,
  value: unknown,
  at = Date.now()
): ChannelAgentVerificationResult<SignedChannelAgentRevocation> {
  const signed = parseSignedChannelAgentRevocation(value)
  if (!signed) return fail('revocation_invalid')
  if (signed.revocation.revokedAt > at + CHANNEL_AGENT_MAX_CLOCK_SKEW_MS) {
    return fail('revocation_invalid')
  }
  if (
    !signatureVerifies(
      ownerPublicKey,
      CHANNEL_AGENT_SIGNATURE_DOMAINS.revocation,
      signed.revocation,
      signed.ownerSignatureB64
    )
  ) {
    return fail('owner_signature_invalid')
  }
  return ok(signed)
}
