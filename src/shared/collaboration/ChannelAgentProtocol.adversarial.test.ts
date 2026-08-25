import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { b64, importRawEd25519PublicKey, signEd25519, verifyEd25519 } from '../e2ee/keys'
import {
  CHANNEL_AGENT_MAX_DISPATCHES,
  CHANNEL_AGENT_MAX_IDENTIFIER,
  CHANNEL_AGENT_MAX_MEMBERS,
  CHANNEL_AGENT_MAX_POST_BYTES,
  CHANNEL_AGENT_SIGNATURE_DOMAINS,
  canonicalChannelAgentStatement,
  hashChannelAgentContent,
  parseChannelAgentDelegation,
  parseChannelAgentDispatchGrant,
  parseChannelAgentPost,
  parseChannelAgentRevocation,
  parseSignedChannelAgentDelegation,
  parseSignedChannelAgentDispatchGrant,
  parseSignedChannelAgentPost,
  parseSignedChannelAgentRevocation,
  signChannelAgentDispatchGrant,
  signChannelAgentPost,
  verifyChannelAgentDelegation,
  verifyChannelAgentDispatchGrant,
  verifyChannelAgentPost,
  verifyChannelAgentRevocation,
  type ChannelAgentDelegation,
  type ChannelAgentDispatchGrant,
  type ChannelAgentPost,
  type ChannelAgentRevocation,
  type ChannelAgentSignatureDomain
} from './ChannelAgentProtocol'
import {
  CHANNEL_AGENT_MESSAGE_PROOF_VERSION,
  verifyChannelAgentMessageProof,
  type ChannelAgentMessageProof
} from './ChannelAgentMessageProof'

type VectorKind = 'delegation' | 'dispatchGrant' | 'post' | 'revocation'

interface CanonicalVector {
  label: string
  kind: VectorKind
  domain: ChannelAgentSignatureDomain
  signer: 'owner' | 'agent'
  value: Record<string, unknown>
  expectedCanonicalJson: string
  expectedSha256: string
  signatureB64: string
}

interface CanonicalFixture {
  schemaVersion: number
  ownerPublicKeyB64: string
  agentPublicKeyB64: string
  vectors: CanonicalVector[]
  objectOrderWirePair: {
    domain: ChannelAgentSignatureDomain
    first: string
    second: string
    expectedSha256: string
  }
  arrayOrderMutation: {
    domain: ChannelAgentSignatureDomain
    value: Record<string, unknown>
    expectedSha256: string
  }
  invalidBase64: string[]
}

const OWNER_SEED_HEX = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
const OWNER_PUBLIC_HEX = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'
const AGENT_SEED_HEX = '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb'
const AGENT_PUBLIC_HEX = '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c'

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../scripts/fixtures/channels-p3-canonical-vectors.json', import.meta.url),
    'utf8'
  )
) as CanonicalFixture

function fixedEd25519KeyPair(
  seedHex: string,
  publicHex: string
): { privateKey: KeyObject; publicKey: KeyObject } {
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

function vector(kind: VectorKind): CanonicalVector {
  const matches = fixture.vectors.filter((entry) => entry.kind === kind)
  expect(matches, `fixture vector ${kind}`).toHaveLength(1)
  return matches[0]
}

function parseRaw(kind: VectorKind, value: unknown): unknown {
  if (kind === 'delegation') return parseChannelAgentDelegation(value)
  if (kind === 'dispatchGrant') return parseChannelAgentDispatchGrant(value)
  if (kind === 'post') return parseChannelAgentPost(value)
  return parseChannelAgentRevocation(value)
}

function signedWrapper(kind: VectorKind, value: unknown, signatureB64: string): unknown {
  if (kind === 'delegation') return { delegation: value, ownerSignatureB64: signatureB64 }
  if (kind === 'dispatchGrant') return { grant: value, ownerSignatureB64: signatureB64 }
  if (kind === 'post') return { post: value, agentSignatureB64: signatureB64 }
  return { revocation: value, ownerSignatureB64: signatureB64 }
}

function parseSigned(kind: VectorKind, value: unknown): unknown {
  if (kind === 'delegation') return parseSignedChannelAgentDelegation(value)
  if (kind === 'dispatchGrant') return parseSignedChannelAgentDispatchGrant(value)
  if (kind === 'post') return parseSignedChannelAgentPost(value)
  return parseSignedChannelAgentRevocation(value)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function vectorStatement(value: CanonicalVector): Buffer {
  return canonicalChannelAgentStatement(value.domain, value.value)
}

function signedDelegation() {
  const value = vector('delegation')
  return signedWrapper(value.kind, value.value, value.signatureB64)
}

function verifySignedVector(value: CanonicalVector, signatureB64: string): boolean {
  const wrapped = signedWrapper(value.kind, value.value, signatureB64)
  if (value.kind === 'delegation') {
    return verifyChannelAgentDelegation(ownerKeys.publicKey, wrapped, Number(value.value.notBefore))
      .ok
  }
  if (value.kind === 'dispatchGrant') {
    return verifyChannelAgentDispatchGrant({
      ownerPublicKey: ownerKeys.publicKey,
      delegation: signedDelegation(),
      dispatchGrant: wrapped,
      mentionerMemberId: 'human-a',
      workspaceIdentityHash: 'a'.repeat(64),
      permissionPostureHash: 'b'.repeat(64),
      at: Number(value.value.notBefore)
    }).ok
  }
  if (value.kind === 'post') {
    return verifyChannelAgentPost({
      ownerPublicKey: ownerKeys.publicKey,
      delegation: signedDelegation(),
      post: wrapped,
      at: Number(value.value.createdAt)
    }).ok
  }
  return verifyChannelAgentRevocation(ownerKeys.publicKey, wrapped, Number(value.value.revokedAt))
    .ok
}

function mutateOne(value: Record<string, unknown>, key: string, replacement: unknown) {
  return { ...value, [key]: replacement }
}

describe('ChannelAgentProtocol adversarial review', () => {
  it('rejects deterministic structural fuzz and unknown fields for every raw and signed object', () => {
    const nonObjects = [null, undefined, true, false, 0, '', [], ['object'], new Date(0)]

    for (const value of fixture.vectors) {
      expect(parseRaw(value.kind, value.value), `${value.label} baseline`).not.toBeNull()
      for (const candidate of nonObjects) {
        expect(parseRaw(value.kind, candidate), `${value.label} non-object`).toBeNull()
      }
      expect(parseRaw(value.kind, { ...value.value, adversarialUnknown: true })).toBeNull()
      expect(
        parseRaw(
          value.kind,
          Object.assign(Object.create({ inheritedAdversarialField: true }), value.value)
        )
      ).toBeNull()

      for (const key of Object.keys(value.value)) {
        const missing = { ...value.value }
        delete missing[key]
        expect(parseRaw(value.kind, missing), `${value.label} missing ${key}`).toBeNull()
        expect(
          parseRaw(value.kind, mutateOne(value.value, key, null)),
          `${value.label} null ${key}`
        ).toBeNull()
      }

      const signed = signedWrapper(value.kind, value.value, value.signatureB64) as Record<
        string,
        unknown
      >
      expect(parseSigned(value.kind, signed), `${value.label} signed baseline`).not.toBeNull()
      expect(parseSigned(value.kind, { ...signed, adversarialUnknown: true })).toBeNull()
      for (const key of Object.keys(signed)) {
        const missing = { ...signed }
        delete missing[key]
        expect(parseSigned(value.kind, missing), `${value.label} signed missing ${key}`).toBeNull()
        expect(parseSigned(value.kind, { ...signed, [key]: null })).toBeNull()
      }
    }
  })

  it('matches Unicode, escape, ordering, array, maximum, and signature vectors byte-for-byte', () => {
    expect(fixture.schemaVersion).toBe(1)
    for (const value of fixture.vectors) {
      const statement = vectorStatement(value)
      expect(statement.subarray(value.domain.length + 1).toString('utf8')).toBe(
        value.expectedCanonicalJson
      )
      expect(createHash('sha256').update(statement).digest('hex')).toBe(value.expectedSha256)
      const publicKey = importRawEd25519PublicKey(
        Buffer.from(
          value.signer === 'owner' ? fixture.ownerPublicKeyB64 : fixture.agentPublicKeyB64,
          'base64'
        )
      )
      expect(verifyEd25519(publicKey, statement, Buffer.from(value.signatureB64, 'base64'))).toBe(
        true
      )
      expect(verifySignedVector(value, value.signatureB64)).toBe(true)
    }

    const order = fixture.objectOrderWirePair
    const first = canonicalChannelAgentStatement(order.domain, JSON.parse(order.first))
    const second = canonicalChannelAgentStatement(order.domain, JSON.parse(order.second))
    expect(second).toEqual(first)
    expect(createHash('sha256').update(first).digest('hex')).toBe(order.expectedSha256)

    const reordered = canonicalChannelAgentStatement(
      fixture.arrayOrderMutation.domain,
      fixture.arrayOrderMutation.value
    )
    expect(createHash('sha256').update(reordered).digest('hex')).toBe(
      fixture.arrayOrderMutation.expectedSha256
    )
    expect(createHash('sha256').update(reordered).digest('hex')).not.toBe(order.expectedSha256)
    expect(parseChannelAgentDelegation(fixture.arrayOrderMutation.value)).toBeNull()
  })

  it('rejects every cross-domain signature and cross-object signature substitution', () => {
    const domains = Object.values(CHANNEL_AGENT_SIGNATURE_DOMAINS)

    for (const value of fixture.vectors) {
      const signingKey = value.signer === 'owner' ? ownerKeys.privateKey : agentKeys.privateKey
      for (const domain of domains) {
        if (domain === value.domain) continue
        const wrongDomainSignature = b64.encode(
          signEd25519(signingKey, canonicalChannelAgentStatement(domain, value.value))
        )
        expect(
          verifySignedVector(value, wrongDomainSignature),
          `${value.label} accepted ${domain}`
        ).toBe(false)
      }

      for (const substitute of fixture.vectors) {
        if (substitute === value) continue
        expect(
          verifySignedVector(value, substitute.signatureB64),
          `${value.label} accepted ${substitute.label} signature`
        ).toBe(false)
      }
    }
  })

  it('rejects validly signed Channel, member, seat, key-generation, and delegation rebindings', () => {
    const delegation = vector('delegation').value as unknown as ChannelAgentDelegation
    const grant = vector('dispatchGrant').value as unknown as ChannelAgentDispatchGrant
    const post = vector('post').value as unknown as ChannelAgentPost
    const delegationSigned = signedDelegation()
    const grantMutations: Partial<ChannelAgentDispatchGrant>[] = [
      { channelId: 'channel-rebound' },
      { ownerMemberId: 'owner-rebound' },
      { agentMemberId: 'agent-rebound' },
      { agentSeatId: 'seat-rebound' },
      { agentPublicKeyB64: fixture.ownerPublicKeyB64 },
      { keyGeneration: Number.MAX_SAFE_INTEGER - 1 },
      { delegationId: 'delegation-rebound' }
    ]
    for (const mutation of grantMutations) {
      const rebound = signChannelAgentDispatchGrant(ownerKeys.privateKey, { ...grant, ...mutation })
      expect(
        verifyChannelAgentDispatchGrant({
          ownerPublicKey: ownerKeys.publicKey,
          delegation: delegationSigned,
          dispatchGrant: rebound,
          mentionerMemberId: 'human-a',
          workspaceIdentityHash: 'a'.repeat(64),
          permissionPostureHash: 'b'.repeat(64),
          at: grant.notBefore
        })
      ).toEqual({ ok: false, error: 'authority_binding_mismatch' })
    }

    const postMutations: Partial<ChannelAgentPost>[] = [
      { channelId: 'channel-rebound' },
      { agentMemberId: 'agent-rebound' },
      { agentSeatId: 'seat-rebound' },
      { agentPublicKeyB64: fixture.ownerPublicKeyB64 },
      { keyGeneration: Number.MAX_SAFE_INTEGER - 1 },
      { delegationId: 'delegation-rebound' }
    ]
    for (const mutation of postMutations) {
      const rebound = signChannelAgentPost(agentKeys.privateKey, { ...post, ...mutation })
      expect(
        verifyChannelAgentPost({
          ownerPublicKey: ownerKeys.publicKey,
          delegation: delegationSigned,
          post: rebound,
          at: post.createdAt
        })
      ).toEqual({ ok: false, error: 'authority_binding_mismatch' })
    }

    expect(delegation.agentSeatId).toBe(grant.agentSeatId)
  })

  it('binds grant, trigger, run, and launch-authority bytes through the public message proof', () => {
    const delegation = vector('delegation')
    const grant = vector('dispatchGrant')
    const post = vector('post')
    const proof: ChannelAgentMessageProof = {
      schemaVersion: CHANNEL_AGENT_MESSAGE_PROOF_VERSION,
      authorityRevision: 3,
      signedDelegation: signedWrapper(
        delegation.kind,
        delegation.value,
        delegation.signatureB64
      ) as ChannelAgentMessageProof['signedDelegation'],
      signedDispatchGrant: signedWrapper(
        grant.kind,
        grant.value,
        grant.signatureB64
      ) as ChannelAgentMessageProof['signedDispatchGrant'],
      consumption: {
        schemaVersion: CHANNEL_AGENT_MESSAGE_PROOF_VERSION,
        recordedRevision: 3,
        channelId: String(grant.value.channelId),
        grantId: String(grant.value.grantId),
        triggerMessageId: String(post.value.triggerMessageId),
        mentionerMemberId: 'human-a',
        workspaceIdentityHash: String(grant.value.workspaceIdentityHash),
        permissionPostureHash: String(grant.value.permissionPostureHash),
        dispatchOrdinal: 1,
        consumedAt: Number(grant.value.notBefore)
      },
      signedPost: signedWrapper(
        post.kind,
        post.value,
        post.signatureB64
      ) as ChannelAgentMessageProof['signedPost']
    }
    const verify = (candidate: ChannelAgentMessageProof) =>
      verifyChannelAgentMessageProof({
        ownerPublicKeyB64: fixture.ownerPublicKeyB64,
        proof: candidate,
        acceptedAt: Number(post.value.createdAt)
      })

    expect(verify(proof).ok).toBe(true)
    for (const mutation of [
      { dispatchGrantId: 'grant-rebound' },
      { triggerMessageId: 'trigger-rebound' }
    ]) {
      const reboundPost = signChannelAgentPost(agentKeys.privateKey, {
        ...(post.value as unknown as ChannelAgentPost),
        ...mutation
      })
      expect(verify({ ...proof, signedPost: reboundPost }).ok).toBe(false)
    }

    for (const mutation of [
      { runId: 'run-rebound' },
      { runAuthorityHash: 'c'.repeat(64) },
      { clientMessageId: 'client-rebound' }
    ]) {
      // Non-mutating rebuild: signedPost is a readonly field on the proof.
      const changed = {
        ...clone(proof),
        signedPost: {
          ...proof.signedPost,
          post: { ...proof.signedPost.post, ...mutation }
        }
      }
      expect(verify(changed).ok).toBe(false)
    }
  })

  it('enforces canonical base64, safe integers, byte ceilings, and bounded set sizes', () => {
    const delegation = vector('delegation').value as unknown as ChannelAgentDelegation
    const grant = vector('dispatchGrant').value as unknown as ChannelAgentDispatchGrant
    const post = vector('post').value as unknown as ChannelAgentPost
    const revocation = vector('revocation').value as unknown as ChannelAgentRevocation

    expect(parseChannelAgentDelegation(delegation)).not.toBeNull()
    expect(parseChannelAgentDispatchGrant(grant)).not.toBeNull()
    expect(parseChannelAgentPost(post)).not.toBeNull()
    expect(parseChannelAgentRevocation(revocation)).not.toBeNull()

    for (const invalid of fixture.invalidBase64) {
      expect(parseChannelAgentDelegation({ ...delegation, agentPublicKeyB64: invalid })).toBeNull()
      expect(parseChannelAgentDispatchGrant({ ...grant, agentPublicKeyB64: invalid })).toBeNull()
      expect(parseChannelAgentPost({ ...post, agentPublicKeyB64: invalid })).toBeNull()
    }

    const invalidSignatures = [
      vector('delegation').signatureB64 + '=',
      vector('delegation').signatureB64.slice(0, -1),
      ` ${vector('delegation').signatureB64}`,
      Buffer.alloc(63, 1).toString('base64'),
      Buffer.alloc(65, 1).toString('base64')
    ]
    for (const signature of invalidSignatures) {
      expect(
        parseSignedChannelAgentDelegation({ delegation, ownerSignatureB64: signature })
      ).toBeNull()
      expect(
        parseSignedChannelAgentDispatchGrant({ grant, ownerSignatureB64: signature })
      ).toBeNull()
      expect(parseSignedChannelAgentPost({ post, agentSignatureB64: signature })).toBeNull()
      expect(
        parseSignedChannelAgentRevocation({ revocation, ownerSignatureB64: signature })
      ).toBeNull()
    }

    expect(
      parseChannelAgentDelegation({ ...delegation, keyGeneration: Number.MAX_SAFE_INTEGER + 1 })
    ).toBeNull()
    expect(
      parseChannelAgentDelegation({
        ...delegation,
        delegationId: 'x'.repeat(CHANNEL_AGENT_MAX_IDENTIFIER + 1)
      })
    ).toBeNull()
    expect(
      parseChannelAgentDelegation({
        ...delegation,
        maxPostBytes: CHANNEL_AGENT_MAX_POST_BYTES + 1
      })
    ).toBeNull()
    expect(
      parseChannelAgentDispatchGrant({
        ...grant,
        maxDispatches: CHANNEL_AGENT_MAX_DISPATCHES + 1
      })
    ).toBeNull()
    expect(
      parseChannelAgentDispatchGrant({
        ...grant,
        allowedMentionerMemberIds: Array.from(
          { length: CHANNEL_AGENT_MAX_MEMBERS + 1 },
          (_, index) => `member-${index}`
        )
      })
    ).toBeNull()
    const oversized = '🧪'.repeat(Math.ceil(CHANNEL_AGENT_MAX_POST_BYTES / 4) + 1)
    expect(
      parseChannelAgentPost({
        ...post,
        content: oversized,
        contentHash: hashChannelAgentContent(oversized)
      })
    ).toBeNull()
    expect(parseChannelAgentRevocation({ ...revocation, revokedAt: Number.NaN })).toBeNull()
  })
})
