import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { b64, verifyEd25519 } from '../e2ee/keys'
import {
  canonicalChannelAgentStatement,
  channelAgentPublicKeyFingerprint,
  CHANNEL_AGENT_SIGNATURE_DOMAINS,
  hashChannelAgentContent,
  parseChannelAgentDelegation,
  parseChannelAgentDispatchGrant,
  parseChannelAgentPost,
  parseSignedChannelAgentDelegation,
  signChannelAgentDelegation,
  signChannelAgentDispatchGrant,
  signChannelAgentPost,
  signChannelAgentRevocation,
  verifyChannelAgentDelegation,
  verifyChannelAgentDispatchGrant,
  verifyChannelAgentPost,
  verifyChannelAgentRevocation,
  type ChannelAgentDelegation,
  type ChannelAgentDispatchGrant,
  type ChannelAgentPost,
  type ChannelAgentRevocation
} from './ChannelAgentProtocol'

const OWNER_SEED_HEX = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
const OWNER_PUBLIC_HEX = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'
const AGENT_SEED_HEX = '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb'
const AGENT_PUBLIC_HEX = '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c'

const NOW = 1_800_000_000_000
const NOT_BEFORE = NOW - 60_000
const EXPIRES_AT = NOW + 3_600_000
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

function fixedEd25519KeyPair(
  seedHex: string,
  publicHex: string
): {
  privateKey: KeyObject
  publicKey: KeyObject
} {
  const privateKey = createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      d: Buffer.from(seedHex, 'hex').toString('base64url'),
      x: Buffer.from(publicHex, 'hex').toString('base64url')
    },
    format: 'jwk'
  })
  return { privateKey, publicKey: createPublicKey(privateKey) }
}

const ownerKeys = fixedEd25519KeyPair(OWNER_SEED_HEX, OWNER_PUBLIC_HEX)
const agentKeys = fixedEd25519KeyPair(AGENT_SEED_HEX, AGENT_PUBLIC_HEX)
const agentPublicKeyB64 = b64.encode(Buffer.from(AGENT_PUBLIC_HEX, 'hex'))

function delegation(overrides: Partial<ChannelAgentDelegation> = {}): ChannelAgentDelegation {
  return {
    schemaVersion: 1,
    delegationId: 'delegation-1',
    channelId: 'channel-1',
    ownerMemberId: 'owner-member',
    agentMemberId: 'agent-member',
    agentSeatId: 'pooled-agent-1',
    agentPublicKeyB64,
    keyGeneration: 1,
    scopes: ['channel.dispatch', 'channel.post'],
    issuedAt: NOT_BEFORE,
    notBefore: NOT_BEFORE,
    expiresAt: EXPIRES_AT,
    maxPostBytes: 8_000,
    ...overrides
  }
}

function dispatchGrant(
  overrides: Partial<ChannelAgentDispatchGrant> = {}
): ChannelAgentDispatchGrant {
  return {
    schemaVersion: 1,
    grantId: 'grant-1',
    channelId: 'channel-1',
    ownerMemberId: 'owner-member',
    agentMemberId: 'agent-member',
    agentSeatId: 'pooled-agent-1',
    agentPublicKeyB64,
    keyGeneration: 1,
    delegationId: 'delegation-1',
    trigger: 'mention',
    allowedMentionerMemberIds: ['human-member-2', 'owner-member'],
    workspaceIdentityHash: HASH_A,
    permissionPostureHash: HASH_B,
    issuedAt: NOT_BEFORE,
    notBefore: NOT_BEFORE,
    expiresAt: EXPIRES_AT,
    maxDispatches: 20,
    ...overrides
  }
}

function post(overrides: Partial<ChannelAgentPost> = {}): ChannelAgentPost {
  const content = overrides.content ?? 'Bounded signed result'
  return {
    schemaVersion: 1,
    channelId: 'channel-1',
    agentMemberId: 'agent-member',
    agentSeatId: 'pooled-agent-1',
    agentPublicKeyB64,
    keyGeneration: 1,
    delegationId: 'delegation-1',
    dispatchGrantId: 'grant-1',
    triggerMessageId: 'message-1',
    runId: 'run-1',
    runAuthorityHash: HASH_B,
    clientMessageId: 'agent-client-message-1',
    kind: 'agent.text',
    content,
    contentHash: overrides.contentHash ?? hashChannelAgentContent(content),
    createdAt: NOW,
    ...overrides
  }
}

function revocation(overrides: Partial<ChannelAgentRevocation> = {}): ChannelAgentRevocation {
  return {
    schemaVersion: 1,
    revocationId: 'revocation-1',
    channelId: 'channel-1',
    ownerMemberId: 'owner-member',
    agentSeatId: 'pooled-agent-1',
    keyGeneration: 1,
    targetKind: 'dispatch_grant',
    targetId: 'grant-1',
    revokedAt: NOW,
    reason: 'owner_revoked',
    ...overrides
  }
}

describe('ChannelAgentProtocol', () => {
  it('canonicalizes field order and produces deterministic domain-separated signatures', () => {
    const value = delegation()
    const reversed = Object.fromEntries(Object.entries(value).reverse())
    const canonical = canonicalChannelAgentStatement(
      CHANNEL_AGENT_SIGNATURE_DOMAINS.delegation,
      value
    )
    expect(
      canonicalChannelAgentStatement(CHANNEL_AGENT_SIGNATURE_DOMAINS.delegation, reversed)
    ).toEqual(canonical)

    const first = signChannelAgentDelegation(ownerKeys.privateKey, value)
    const second = signChannelAgentDelegation(ownerKeys.privateKey, value)
    expect(second).toEqual(first)
    expect(first.ownerSignatureB64).toHaveLength(88)
    expect(
      verifyEd25519(
        ownerKeys.publicKey,
        canonicalChannelAgentStatement(CHANNEL_AGENT_SIGNATURE_DOMAINS.post, value),
        Buffer.from(first.ownerSignatureB64, 'base64')
      )
    ).toBe(false)
  })

  it('verifies the complete owner delegation, mention grant, agent post, and revocation chain', () => {
    const signedDelegation = signChannelAgentDelegation(ownerKeys.privateKey, delegation())
    const signedGrant = signChannelAgentDispatchGrant(ownerKeys.privateKey, dispatchGrant())
    const signedPost = signChannelAgentPost(agentKeys.privateKey, post())
    const signedRevocation = signChannelAgentRevocation(ownerKeys.privateKey, revocation())

    expect(verifyChannelAgentDelegation(ownerKeys.publicKey, signedDelegation, NOW)).toEqual({
      ok: true,
      value: signedDelegation
    })
    expect(
      verifyChannelAgentDispatchGrant({
        ownerPublicKey: ownerKeys.publicKey,
        delegation: signedDelegation,
        dispatchGrant: signedGrant,
        mentionerMemberId: 'human-member-2',
        workspaceIdentityHash: HASH_A,
        permissionPostureHash: HASH_B,
        at: NOW
      })
    ).toMatchObject({ ok: true })
    expect(
      verifyChannelAgentPost({
        ownerPublicKey: ownerKeys.publicKey,
        delegation: signedDelegation,
        post: signedPost,
        at: NOW
      })
    ).toMatchObject({ ok: true })
    expect(verifyChannelAgentRevocation(ownerKeys.publicKey, signedRevocation, NOW)).toEqual({
      ok: true,
      value: signedRevocation
    })
  })

  it('rejects unknown fields, non-canonical authority sets, hashes, and base64', () => {
    expect(parseChannelAgentDelegation({ ...delegation(), surprise: true })).toBeNull()
    expect(
      parseChannelAgentDelegation({
        ...delegation(),
        scopes: ['channel.post', 'channel.dispatch']
      })
    ).toBeNull()
    expect(
      parseChannelAgentDispatchGrant({
        ...dispatchGrant(),
        allowedMentionerMemberIds: ['owner-member', 'human-member-2']
      })
    ).toBeNull()
    expect(
      parseChannelAgentDispatchGrant({ ...dispatchGrant(), workspaceIdentityHash: 'A' })
    ).toBeNull()
    expect(
      parseChannelAgentPost({ ...post(), agentPublicKeyB64: `${agentPublicKeyB64}=` })
    ).toBeNull()
    expect(
      parseSignedChannelAgentDelegation({
        delegation: delegation(),
        ownerSignatureB64: Buffer.alloc(63).toString('base64')
      })
    ).toBeNull()
  })

  it('rejects tampering, cross-channel rebinding, and a different agent key generation', () => {
    const signedDelegation = signChannelAgentDelegation(ownerKeys.privateKey, delegation())
    expect(
      verifyChannelAgentDelegation(
        ownerKeys.publicKey,
        {
          ...signedDelegation,
          delegation: { ...signedDelegation.delegation, channelId: 'channel-2' }
        },
        NOW
      )
    ).toEqual({ ok: false, error: 'owner_signature_invalid' })

    const reboundPost = signChannelAgentPost(
      agentKeys.privateKey,
      post({ channelId: 'channel-2', keyGeneration: 2 })
    )
    expect(
      verifyChannelAgentPost({
        ownerPublicKey: ownerKeys.publicKey,
        delegation: signedDelegation,
        post: reboundPost,
        at: NOW
      })
    ).toEqual({ ok: false, error: 'authority_binding_mismatch' })

    const content = 'Different signed bytes'
    const unsignedMutation = {
      ...signChannelAgentPost(agentKeys.privateKey, post()),
      post: { ...post(), content, contentHash: hashChannelAgentContent(content) }
    }
    expect(
      verifyChannelAgentPost({
        ownerPublicKey: ownerKeys.publicKey,
        delegation: signedDelegation,
        post: unsignedMutation,
        at: NOW
      })
    ).toEqual({ ok: false, error: 'agent_signature_invalid' })
  })

  it('binds auto-dispatch to the exact mentioner, workspace, posture, scope, and lifetime', () => {
    const signedDelegation = signChannelAgentDelegation(ownerKeys.privateKey, delegation())
    const signedGrant = signChannelAgentDispatchGrant(ownerKeys.privateKey, dispatchGrant())
    const verify = (overrides: {
      mentionerMemberId?: string
      workspaceIdentityHash?: string
      permissionPostureHash?: string
      at?: number
      delegation?: unknown
    }) =>
      verifyChannelAgentDispatchGrant({
        ownerPublicKey: ownerKeys.publicKey,
        delegation: overrides.delegation ?? signedDelegation,
        dispatchGrant: signedGrant,
        mentionerMemberId: overrides.mentionerMemberId ?? 'owner-member',
        workspaceIdentityHash: overrides.workspaceIdentityHash ?? HASH_A,
        permissionPostureHash: overrides.permissionPostureHash ?? HASH_B,
        at: overrides.at ?? NOW
      })

    expect(verify({ mentionerMemberId: 'other-member' })).toEqual({
      ok: false,
      error: 'dispatch_mentioner_not_allowed'
    })
    expect(verify({ workspaceIdentityHash: 'c'.repeat(64) })).toEqual({
      ok: false,
      error: 'authority_binding_mismatch'
    })
    expect(verify({ permissionPostureHash: 'd'.repeat(64) })).toEqual({
      ok: false,
      error: 'authority_binding_mismatch'
    })
    expect(
      verify({
        delegation: signChannelAgentDelegation(
          ownerKeys.privateKey,
          delegation({ scopes: ['channel.post'] })
        )
      })
    ).toEqual({ ok: false, error: 'delegation_scope_missing' })
    expect(verify({ at: EXPIRES_AT })).toEqual({ ok: false, error: 'authority_expired' })
  })

  it('rejects post timestamps outside delegated authority and future clock skew', () => {
    const signedDelegation = signChannelAgentDelegation(ownerKeys.privateKey, delegation())
    const verify = (value: ChannelAgentPost) =>
      verifyChannelAgentPost({
        ownerPublicKey: ownerKeys.publicKey,
        delegation: signedDelegation,
        post: signChannelAgentPost(agentKeys.privateKey, value),
        at: NOW
      })

    expect(verify(post({ createdAt: NOT_BEFORE - 1 }))).toEqual({
      ok: false,
      error: 'post_timestamp_invalid'
    })
    expect(verify(post({ createdAt: EXPIRES_AT }))).toEqual({
      ok: false,
      error: 'post_timestamp_invalid'
    })
    expect(verify(post({ createdAt: NOW + 5 * 60 * 1_000 + 1 }))).toEqual({
      ok: false,
      error: 'post_timestamp_invalid'
    })
  })

  it('pins the public-key fingerprint and canonical statement digest as cross-implementation vectors', () => {
    const canonical = canonicalChannelAgentStatement(
      CHANNEL_AGENT_SIGNATURE_DOMAINS.delegation,
      delegation()
    )
    expect(channelAgentPublicKeyFingerprint(agentPublicKeyB64)).toBe(
      '39f713d0a644253f04529421b9f51b9b08979d08295959c4f3990ee617f5139f'
    )
    expect(createHash('sha256').update(canonical).digest('hex')).toBe(
      'c2665be7fae2e47f389ff761fb8a5243c7b86c45cfbc7979b49c14a2c120fc90'
    )
    expect(signChannelAgentDelegation(ownerKeys.privateKey, delegation()).ownerSignatureB64).toBe(
      'XVUDyNKvvjJPXDfAd69gyLsTqHNvJfccb9SZepCK8zyXeIvFWOFpv5kIKJG4fOV8DyE+V1f/IeOw37ooAWhdDQ=='
    )
    expect(
      signChannelAgentDispatchGrant(ownerKeys.privateKey, dispatchGrant()).ownerSignatureB64
    ).toBe(
      'uifB5F1MD4qYEQKAFEgZsOzDiXIx+1//Fp79tVTStL/yZbrX4AOF7xo/xnuDPBHwSsYaUcBOh0ZMdgRZIvfWAA=='
    )
    expect(signChannelAgentPost(agentKeys.privateKey, post()).agentSignatureB64).toBe(
      'EZtrTtei4jPelc5U0JrPEnXd1vIbcioFameSFVRLtukEkspgKSPAsfQaP0u2zM1V182s8EFyTU8qISn+xM9aDg=='
    )
    expect(signChannelAgentRevocation(ownerKeys.privateKey, revocation()).ownerSignatureB64).toBe(
      'huQl26jdqGz7OIjKbYzMkCT9nceG3kXdKYd69szfKBjcLrgPY39DFH9z+lm69eHWzcIDMp4z8NYXQVPy+IwfCQ=='
    )
  })
})
