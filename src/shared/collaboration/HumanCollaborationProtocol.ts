export const HUMAN_COLLABORATION_PROTOCOL = 'taskwraith-human-collaboration-v1'

export const HUMAN_COLLABORATION_METHODS = {
  beginHandshake: 'humanCollaboration.handshake.begin',
  confirmSas: 'humanCollaboration.handshake.confirmSas',
  subscribeProjection: 'humanCollaboration.projection.subscribe',
  projectionUpdate: 'humanCollaboration.projection.update',
  appendComment: 'humanCollaboration.comment.append',
  disconnect: 'humanCollaboration.disconnect'
} as const

export type HumanCollaborationMethod =
  (typeof HUMAN_COLLABORATION_METHODS)[keyof typeof HUMAN_COLLABORATION_METHODS]

export type HumanCollaborationHandshakeMode = 'admission' | 'reconnect'

export interface HumanCollaborationHandshakeContext {
  protocol: typeof HUMAN_COLLABORATION_PROTOCOL
  mode: HumanCollaborationHandshakeMode
  shareId: string
  chatId: string
  inviteId: string
  inviteTokenHash: string
  inviteExpiresAt: number
  shareMode: 'readOnly' | 'comments'
  collaboratorId?: string
  hostIdentityPubKeyB64: string
  collaboratorIdentityPubKeyB64: string
  hostEphemeralPubKeyB64: string
  collaboratorEphemeralPubKeyB64: string
  hostNonceB64: string
  collaboratorNonceB64: string
}
export interface HumanCollaborationBeginHandshakeInput {
  shareId: string
  chatId: string
  displayName: string
  inviteToken?: string
  collaboratorId?: string
  collaboratorIdentityPubKeyB64: string
  collaboratorEphemeralPubKeyB64: string
  collaboratorNonceB64: string
}

export interface HumanCollaborationBeginHandshakeResult {
  handshakeId: string
  protocol: typeof HUMAN_COLLABORATION_PROTOCOL
  mode: HumanCollaborationHandshakeMode
  shareId: string
  chatId: string
  inviteId: string
  hostIdentityPubKeyB64: string
  hostEphemeralPubKeyB64: string
  hostNonceB64: string
  confirmCode: string
  hostTranscriptSigB64: string
  transcriptHashB64: string
  expiresAt: number
}

export interface HumanCollaborationConfirmSasInput {
  handshakeId: string
  confirmCode: string
  collaboratorTranscriptSigB64: string
}

export interface HumanCollaborationConfirmSasResult {
  sessionId: string
  shareId: string
  chatId: string
  collaboratorId: string
  displayName: string
  hostIdentityPubKeyB64: string
  establishedAt: number
}

export interface HumanCollaborationSubscribeProjectionInput {
  sessionId: string
}

export interface HumanCollaborationAppendCommentInput {
  sessionId: string
  clientMessageId: string
  content: string
}

export interface HumanCollaborationDisconnectInput {
  sessionId: string
}
