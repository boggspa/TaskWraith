import { describe, expect, it } from 'vitest'
import { parseHumanCollaborationInvite } from './JoinSharedChatModal'

const invite = {
  type: 'taskwraith-human-collaboration-invite',
  v: 1,
  shareId: 'share-1',
  chatId: 'chat-1',
  inviteToken: 'token-1',
  mode: 'comments',
  relayUrl: 'wss://host.example',
  relayUrls: ['wss://host.example', 'ws://192.168.1.5:8787'],
  roomId: 'room-1',
  hostIdentityPubKeyB64: 'host-key'
}

describe('parseHumanCollaborationInvite', () => {
  it('accepts current JSON invites with relay candidates', () => {
    const parsed = parseHumanCollaborationInvite(JSON.stringify(invite))
    expect(parsed.shareId).toBe('share-1')
    expect(parsed.relayUrl).toBe('wss://host.example')
    expect(parsed.relayUrls).toEqual(['wss://host.example', 'ws://192.168.1.5:8787'])
  })

  it('accepts link invites with an encoded JSON payload', () => {
    const encoded = encodeURIComponent(JSON.stringify(invite))
    const parsed = parseHumanCollaborationInvite(`taskwraith://join-shared-chat?invite=${encoded}`)
    expect(parsed.roomId).toBe('room-1')
    expect(parsed.hostIdentityPubKeyB64).toBe('host-key')
  })

  it('rejects missing required room coordinates instead of dialing undefined', () => {
    expect(() =>
      parseHumanCollaborationInvite(JSON.stringify({ ...invite, roomId: undefined }))
    ).toThrow(/missing required share information/)
  })

  it('rejects invites with no relay candidates', () => {
    expect(() =>
      parseHumanCollaborationInvite(
        JSON.stringify({ ...invite, relayUrl: undefined, relayUrls: [] })
      )
    ).toThrow(/no connection info/)
  })
})
