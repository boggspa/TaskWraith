import { createHash, hkdfSync, type KeyObject } from 'crypto'
import {
  HUMAN_COLLABORATION_PROTOCOL,
  type HumanCollaborationHandshakeContext
} from './HumanCollaborationProtocol'
import { deriveSharedSecret } from '../e2ee/keys'
import { confirmCodeFromTranscript } from '../e2ee/keyschedule'

const HKDF_INFO_HOST_TO_COLLABORATOR = `${HUMAN_COLLABORATION_PROTOCOL} host->collaborator`
const HKDF_INFO_COLLABORATOR_TO_HOST = `${HUMAN_COLLABORATION_PROTOCOL} collaborator->host`

export interface HumanCollaborationSessionKeys {
  hostToCollaborator: Buffer
  collaboratorToHost: Buffer
}
export function computeHumanCollaborationTranscriptHash(
  context: HumanCollaborationHandshakeContext
): Buffer {
  const transcript = [
    HUMAN_COLLABORATION_PROTOCOL,
    context.mode,
    context.shareId,
    context.chatId,
    context.inviteId,
    context.inviteTokenHash,
    String(context.inviteExpiresAt),
    context.shareMode,
    context.collaboratorId || '',
    context.hostIdentityPubKeyB64,
    context.collaboratorIdentityPubKeyB64,
    context.hostEphemeralPubKeyB64,
    context.collaboratorEphemeralPubKeyB64,
    context.hostNonceB64,
    context.collaboratorNonceB64
  ].join('|')
  return createHash('sha256').update(transcript, 'utf8').digest()
}

export function humanCollaborationConfirmCode(
  context: HumanCollaborationHandshakeContext
): string {
  return confirmCodeFromTranscript(computeHumanCollaborationTranscriptHash(context))
}

export function deriveHumanCollaborationSessionKeys(args: {
  hostEphemeralPrivate: KeyObject
  collaboratorEphemeralPublic: KeyObject
  hostNonce: Buffer
  collaboratorNonce: Buffer
}): HumanCollaborationSessionKeys {
  const ikm = deriveSharedSecret(args.hostEphemeralPrivate, args.collaboratorEphemeralPublic)
  const salt = createHash('sha256')
    .update(Buffer.concat([args.hostNonce, args.collaboratorNonce]))
    .digest()
  return {
    hostToCollaborator: Buffer.from(
      hkdfSync('sha256', ikm, salt, HKDF_INFO_HOST_TO_COLLABORATOR, 32)
    ),
    collaboratorToHost: Buffer.from(
      hkdfSync('sha256', ikm, salt, HKDF_INFO_COLLABORATOR_TO_HOST, 32)
    )
  }
}
