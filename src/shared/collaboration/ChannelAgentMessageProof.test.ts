import { describe, expect, it } from 'vitest'
import { b64, exportRawEd25519PublicKey, generateIdentityKeyPair } from '../e2ee/keys'
import {
  CHANNEL_AGENT_PROTOCOL_VERSION,
  hashChannelAgentContent,
  signChannelAgentDelegation,
  signChannelAgentDispatchGrant,
  signChannelAgentPost,
  type ChannelAgentDelegation,
  type ChannelAgentDispatchGrant,
  type ChannelAgentPost
} from './ChannelAgentProtocol'
import {
  CHANNEL_AGENT_MESSAGE_PROOF_VERSION,
  parseChannelAgentMessageProof,
  verifyChannelAgentMessageProof,
  type ChannelAgentMessageProof
} from './ChannelAgentMessageProof'

const workspaceIdentityHash = 'a'.repeat(64)
const permissionPostureHash = 'b'.repeat(64)
const runAuthorityHash = 'c'.repeat(64)

function fixture(): { ownerPublicKeyB64: string; proof: ChannelAgentMessageProof } {
  const owner = generateIdentityKeyPair()
  const agent = generateIdentityKeyPair()
  const agentPublicKeyB64 = b64.encode(exportRawEd25519PublicKey(agent.publicKey))
  const delegation: ChannelAgentDelegation = {
    schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
    delegationId: 'delegation-a',
    channelId: 'channel-a',
    ownerMemberId: 'owner-a',
    agentMemberId: 'agent-a',
    agentSeatId: 'seat-a',
    agentPublicKeyB64,
    keyGeneration: 1,
    scopes: ['channel.dispatch', 'channel.post'],
    issuedAt: 1_000,
    notBefore: 1_000,
    expiresAt: 10_000,
    maxPostBytes: 8_000
  }
  const grant: ChannelAgentDispatchGrant = {
    schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
    grantId: 'grant-a',
    channelId: 'channel-a',
    ownerMemberId: 'owner-a',
    agentMemberId: 'agent-a',
    agentSeatId: 'seat-a',
    agentPublicKeyB64,
    keyGeneration: 1,
    delegationId: 'delegation-a',
    trigger: 'mention',
    allowedMentionerMemberIds: ['member-a'],
    workspaceIdentityHash,
    permissionPostureHash,
    issuedAt: 1_000,
    notBefore: 1_000,
    expiresAt: 10_000,
    maxDispatches: 2
  }
  const content = 'Verified agent result'
  const post: ChannelAgentPost = {
    schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
    channelId: 'channel-a',
    agentMemberId: 'agent-a',
    agentSeatId: 'seat-a',
    agentPublicKeyB64,
    keyGeneration: 1,
    delegationId: 'delegation-a',
    dispatchGrantId: 'grant-a',
    triggerMessageId: 'message-a',
    runId: 'run-a',
    runAuthorityHash,
    clientMessageId: 'agent-client-a',
    kind: 'agent.text',
    content,
    contentHash: hashChannelAgentContent(content),
    createdAt: 2_500
  }
  return {
    ownerPublicKeyB64: b64.encode(exportRawEd25519PublicKey(owner.publicKey)),
    proof: {
      schemaVersion: CHANNEL_AGENT_MESSAGE_PROOF_VERSION,
      authorityRevision: 3,
      signedDelegation: signChannelAgentDelegation(owner.privateKey, delegation),
      signedDispatchGrant: signChannelAgentDispatchGrant(owner.privateKey, grant),
      consumption: {
        schemaVersion: CHANNEL_AGENT_MESSAGE_PROOF_VERSION,
        recordedRevision: 3,
        channelId: 'channel-a',
        grantId: 'grant-a',
        triggerMessageId: 'message-a',
        mentionerMemberId: 'member-a',
        workspaceIdentityHash,
        permissionPostureHash,
        dispatchOrdinal: 1,
        consumedAt: 2_000
      },
      signedPost: signChannelAgentPost(agent.privateKey, post)
    }
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

type Mutable<T> = {
  -readonly [Key in keyof T]: T[Key] extends object ? Mutable<T[Key]> : T[Key]
}

describe('ChannelAgentMessageProof', () => {
  it('verifies the pinned-owner grant, consumed trigger, and agent post chain', () => {
    const { ownerPublicKeyB64, proof } = fixture()

    expect(parseChannelAgentMessageProof(proof)).toEqual(proof)
    expect(verifyChannelAgentMessageProof({ ownerPublicKeyB64, proof, acceptedAt: 2_600 })).toEqual(
      { ok: true, value: proof }
    )
  })

  it('fails closed on forged signatures and every unsigned consumption binding', () => {
    const { ownerPublicKeyB64, proof } = fixture()
    const mutations: Array<(value: Mutable<ChannelAgentMessageProof>) => void> = [
      (value) => {
        value.signedDelegation.ownerSignatureB64 = Buffer.alloc(64, 9).toString('base64')
      },
      (value) => {
        value.signedPost.agentSignatureB64 = Buffer.alloc(64, 8).toString('base64')
      },
      (value) => {
        value.consumption.mentionerMemberId = 'member-b'
      },
      (value) => {
        value.consumption.workspaceIdentityHash = 'd'.repeat(64)
      },
      (value) => {
        value.consumption.triggerMessageId = 'message-b'
      },
      (value) => {
        value.consumption.dispatchOrdinal = 3
      },
      (value) => {
        value.authorityRevision = 2
      }
    ]

    for (const mutate of mutations) {
      const changed = clone(proof) as Mutable<ChannelAgentMessageProof>
      mutate(changed)
      expect(
        verifyChannelAgentMessageProof({ ownerPublicKeyB64, proof: changed, acceptedAt: 2_600 }).ok
      ).toBe(false)
    }
    expect(
      verifyChannelAgentMessageProof({
        ownerPublicKeyB64: Buffer.alloc(32, 4).toString('base64'),
        proof,
        acceptedAt: 2_600
      }).ok
    ).toBe(false)
  })

  it('rejects non-canonical shapes, keys, times, and late consumption evidence', () => {
    const { ownerPublicKeyB64, proof } = fixture()
    expect(parseChannelAgentMessageProof({ ...proof, extra: true })).toBeNull()
    expect(
      verifyChannelAgentMessageProof({
        ownerPublicKeyB64: `${ownerPublicKeyB64}=`,
        proof,
        acceptedAt: 2_600
      })
    ).toEqual({ ok: false, error: 'owner_key_invalid' })

    const late = clone(proof) as Mutable<ChannelAgentMessageProof>
    late.consumption.consumedAt = 2_501
    expect(
      verifyChannelAgentMessageProof({ ownerPublicKeyB64, proof: late, acceptedAt: 2_600 })
    ).toEqual({ ok: false, error: 'proof_binding_mismatch' })
    expect(verifyChannelAgentMessageProof({ ownerPublicKeyB64, proof, acceptedAt: 1.5 })).toEqual({
      ok: false,
      error: 'proof_invalid'
    })
  })
})
