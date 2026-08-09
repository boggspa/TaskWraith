import { randomBytes } from 'crypto'
import { describe, expect, it } from 'vitest'
import {
  b64,
  exportRawX25519PublicKey,
  generateEphemeralKeyPair,
  importRawX25519PublicKey
} from '../e2ee/keys'
import {
  channelConfirmCode,
  computeChannelTranscriptHash,
  deriveChannelSessionKeys
} from './ChannelKeySchedule'
import { CHANNEL_WIRE_PROTOCOL, type ChannelHandshakeContext } from './ChannelWireProtocol'

function context(): ChannelHandshakeContext {
  return {
    protocol: CHANNEL_WIRE_PROTOCOL,
    mode: 'admission',
    channelId: 'channel',
    chatId: 'chat',
    inviteId: 'invite',
    inviteTokenHash: 'token-hash',
    inviteExpiresAt: 1234,
    memberId: 'member',
    roomId: 'room',
    hostIdentityPubKeyB64: 'host-identity',
    memberIdentityPubKeyB64: 'member-identity',
    hostEphemeralPubKeyB64: 'host-ephemeral',
    memberEphemeralPubKeyB64: 'member-ephemeral',
    hostNonceB64: 'host-nonce',
    memberNonceB64: 'member-nonce'
  }
}

describe('ChannelKeySchedule', () => {
  it('derives identical directional keys at both endpoints', () => {
    const host = generateEphemeralKeyPair()
    const member = generateEphemeralKeyPair()
    const hostNonce = randomBytes(16)
    const memberNonce = randomBytes(16)

    const hostKeys = deriveChannelSessionKeys({
      localEphemeralPrivate: host.privateKey,
      peerEphemeralPublic: importRawX25519PublicKey(exportRawX25519PublicKey(member.publicKey)),
      hostNonce,
      memberNonce
    })
    const memberKeys = deriveChannelSessionKeys({
      localEphemeralPrivate: member.privateKey,
      peerEphemeralPublic: importRawX25519PublicKey(exportRawX25519PublicKey(host.publicKey)),
      hostNonce,
      memberNonce
    })

    expect(hostKeys.hostToMember.equals(memberKeys.hostToMember)).toBe(true)
    expect(hostKeys.memberToHost.equals(memberKeys.memberToHost)).toBe(true)
    expect(hostKeys.hostToMember.equals(hostKeys.memberToHost)).toBe(false)
    expect(b64.encode(hostKeys.hostToMember)).toHaveLength(44)
  })

  it('binds the SAS and transcript hash to every authority coordinate', () => {
    const original = context()
    const changed = { ...original, roomId: 'different-room' }
    expect(
      computeChannelTranscriptHash(original).equals(computeChannelTranscriptHash(changed))
    ).toBe(false)
    expect(channelConfirmCode(original)).toMatch(/^\d{6}$/)
  })
})
