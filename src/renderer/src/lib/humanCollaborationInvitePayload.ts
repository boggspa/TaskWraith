import type {
  CreateShareResult,
  HumanCollaborationMode
} from '../../../main/collaboration/HumanCollaborationStore'

export type HumanCollaborationInviteCreateResult = CreateShareResult & {
  relayUrl?: string
  relayUrls?: string[]
  relayWarning?: string
  hostIdentityPubKeyB64: string
}

export function buildHumanCollaborationInvitePayload(
  result: HumanCollaborationInviteCreateResult
): {
  payload: string
  relayUrls: string[]
  relayWarning: string
} {
  const relayUrls = Array.from(
    new Set(
      [
        ...(Array.isArray(result.relayUrls) ? result.relayUrls : []),
        result.relayUrl
      ].filter((url): url is string => typeof url === 'string' && url.trim().length > 0)
    )
  )
  const relayWarning =
    typeof result.relayWarning === 'string' && result.relayWarning.trim().length > 0
      ? result.relayWarning.trim()
      : ''
  const payload = JSON.stringify(
    {
      type: 'taskwraith-human-collaboration-invite',
      v: 1,
      protocol: 'taskwraith-human-collaboration-v1',
      shareId: result.share.shareId,
      chatId: result.share.chatId,
      inviteId: result.invite.inviteId,
      inviteToken: result.inviteToken,
      mode: result.share.mode as HumanCollaborationMode,
      createdAt: result.invite.createdAt,
      requiresOutOfBandSas: true,
      expiresAt: result.invite.expiresAt,
      relayUrl: result.relayUrl || '',
      relayUrls,
      roomId: result.roomId,
      hostIdentityPubKeyB64: result.hostIdentityPubKeyB64
    },
    null,
    2
  )
  return { payload, relayUrls, relayWarning }
}
