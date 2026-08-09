import { createHash, hkdfSync, type KeyObject } from 'crypto'
import { deriveSharedSecret } from '../e2ee/keys'
import { confirmCodeFromTranscript } from '../e2ee/keyschedule'
import { CHANNEL_WIRE_PROTOCOL, type ChannelHandshakeContext } from './ChannelWireProtocol'

const HKDF_INFO_HOST_TO_MEMBER = `${CHANNEL_WIRE_PROTOCOL} host->member`
const HKDF_INFO_MEMBER_TO_HOST = `${CHANNEL_WIRE_PROTOCOL} member->host`

export interface ChannelSessionKeys {
  hostToMember: Buffer
  memberToHost: Buffer
}

export function computeChannelTranscriptHash(context: ChannelHandshakeContext): Buffer {
  const transcript = [
    CHANNEL_WIRE_PROTOCOL,
    context.mode,
    context.channelId,
    context.chatId,
    context.inviteId,
    context.inviteTokenHash,
    String(context.inviteExpiresAt),
    context.memberId,
    context.roomId,
    context.hostIdentityPubKeyB64,
    context.memberIdentityPubKeyB64,
    context.hostEphemeralPubKeyB64,
    context.memberEphemeralPubKeyB64,
    context.hostNonceB64,
    context.memberNonceB64
  ].join('|')
  return createHash('sha256').update(transcript, 'utf8').digest()
}

export function channelConfirmCode(context: ChannelHandshakeContext): string {
  return confirmCodeFromTranscript(computeChannelTranscriptHash(context))
}

export function deriveChannelSessionKeys(args: {
  localEphemeralPrivate: KeyObject
  peerEphemeralPublic: KeyObject
  hostNonce: Buffer
  memberNonce: Buffer
}): ChannelSessionKeys {
  const ikm = deriveSharedSecret(args.localEphemeralPrivate, args.peerEphemeralPublic)
  const salt = createHash('sha256')
    .update(Buffer.concat([args.hostNonce, args.memberNonce]))
    .digest()
  return {
    hostToMember: Buffer.from(hkdfSync('sha256', ikm, salt, HKDF_INFO_HOST_TO_MEMBER, 32)),
    memberToHost: Buffer.from(hkdfSync('sha256', ikm, salt, HKDF_INFO_MEMBER_TO_HOST, 32))
  }
}
