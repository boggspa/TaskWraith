import {
  parseSignedChannelAgentDelegation,
  parseSignedChannelAgentDispatchGrant,
  parseSignedChannelAgentPost,
  verifyChannelAgentDispatchGrant,
  verifyChannelAgentPost,
  type ChannelAgentVerificationError,
  type SignedChannelAgentDelegation,
  type SignedChannelAgentDispatchGrant,
  type SignedChannelAgentPost
} from './ChannelAgentProtocol'
import { importRawEd25519PublicKey } from '../e2ee/keys'

export const CHANNEL_AGENT_MESSAGE_PROOF_VERSION = 1 as const

/**
 * Host-recorded dispatch evidence. The signed grant authenticates every
 * authority-bearing field; the pinned, encrypted host session attests the
 * durable consumption revision and ordinal to paired members.
 */
export interface ChannelAgentDispatchConsumptionEvidence {
  readonly schemaVersion: typeof CHANNEL_AGENT_MESSAGE_PROOF_VERSION
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

/** Self-contained public evidence retained beside every signed agent post. */
export interface ChannelAgentMessageProof {
  readonly schemaVersion: typeof CHANNEL_AGENT_MESSAGE_PROOF_VERSION
  /** Host authority prefix used for non-retroactive historical verification. */
  readonly authorityRevision: number
  readonly signedDelegation: SignedChannelAgentDelegation
  readonly signedDispatchGrant: SignedChannelAgentDispatchGrant
  readonly consumption: ChannelAgentDispatchConsumptionEvidence
  readonly signedPost: SignedChannelAgentPost
}

export type ChannelAgentMessageProofError =
  | ChannelAgentVerificationError
  | 'owner_key_invalid'
  | 'proof_binding_mismatch'
  | 'proof_invalid'

export type ChannelAgentMessageProofVerification =
  | { readonly ok: true; readonly value: ChannelAgentMessageProof }
  | { readonly ok: false; readonly error: ChannelAgentMessageProofError }

const MAX_IDENTIFIER_LENGTH = 512

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
    !value ||
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

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function parseConsumption(value: unknown): ChannelAgentDispatchConsumptionEvidence | null {
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
    value.schemaVersion !== CHANNEL_AGENT_MESSAGE_PROOF_VERSION ||
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
    schemaVersion: CHANNEL_AGENT_MESSAGE_PROOF_VERSION,
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

export function parseChannelAgentMessageProof(value: unknown): ChannelAgentMessageProof | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'authorityRevision',
      'signedDelegation',
      'signedDispatchGrant',
      'consumption',
      'signedPost'
    ]) ||
    value.schemaVersion !== CHANNEL_AGENT_MESSAGE_PROOF_VERSION ||
    !isPositiveInteger(value.authorityRevision)
  ) {
    return null
  }
  const signedDelegation = parseSignedChannelAgentDelegation(value.signedDelegation)
  const signedDispatchGrant = parseSignedChannelAgentDispatchGrant(value.signedDispatchGrant)
  const consumption = parseConsumption(value.consumption)
  const signedPost = parseSignedChannelAgentPost(value.signedPost)
  if (!signedDelegation || !signedDispatchGrant || !consumption || !signedPost) return null
  return {
    schemaVersion: CHANNEL_AGENT_MESSAGE_PROOF_VERSION,
    authorityRevision: value.authorityRevision,
    signedDelegation,
    signedDispatchGrant,
    consumption,
    signedPost
  }
}

function importCanonicalOwnerKey(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null
  try {
    const raw = Buffer.from(value, 'base64')
    if (raw.length !== 32 || raw.toString('base64') !== value) return null
    return importRawEd25519PublicKey(raw)
  } catch {
    return null
  }
}

/**
 * Verifies the complete public signature/binding chain stored in a replica.
 * Absence of a revocation is host-authoritative and is attested by delivery
 * through the pinned encrypted host session plus the accepted revision.
 */
export function verifyChannelAgentMessageProof(args: {
  readonly ownerPublicKeyB64: string
  readonly proof: unknown
  readonly acceptedAt: number
}): ChannelAgentMessageProofVerification {
  const proof = parseChannelAgentMessageProof(args.proof)
  if (!proof || !isTimestamp(args.acceptedAt)) return { ok: false, error: 'proof_invalid' }
  const ownerPublicKey = importCanonicalOwnerKey(args.ownerPublicKeyB64)
  if (!ownerPublicKey) return { ok: false, error: 'owner_key_invalid' }

  const { signedDelegation, signedDispatchGrant, consumption, signedPost } = proof
  const delegation = signedDelegation.delegation
  const grant = signedDispatchGrant.grant
  const post = signedPost.post
  if (
    proof.authorityRevision < consumption.recordedRevision ||
    consumption.channelId !== post.channelId ||
    consumption.grantId !== grant.grantId ||
    consumption.grantId !== post.dispatchGrantId ||
    consumption.triggerMessageId !== post.triggerMessageId ||
    consumption.dispatchOrdinal > grant.maxDispatches ||
    consumption.consumedAt > post.createdAt ||
    consumption.consumedAt > args.acceptedAt ||
    grant.delegationId !== delegation.delegationId ||
    grant.ownerMemberId !== delegation.ownerMemberId ||
    post.delegationId !== delegation.delegationId
  ) {
    return { ok: false, error: 'proof_binding_mismatch' }
  }

  const dispatch = verifyChannelAgentDispatchGrant({
    ownerPublicKey,
    delegation: signedDelegation,
    dispatchGrant: signedDispatchGrant,
    mentionerMemberId: consumption.mentionerMemberId,
    workspaceIdentityHash: consumption.workspaceIdentityHash,
    permissionPostureHash: consumption.permissionPostureHash,
    at: consumption.consumedAt
  })
  if (!dispatch.ok) return dispatch
  const verifiedPost = verifyChannelAgentPost({
    ownerPublicKey,
    delegation: signedDelegation,
    post: signedPost,
    at: args.acceptedAt
  })
  if (!verifiedPost.ok) return verifiedPost
  return { ok: true, value: proof }
}
