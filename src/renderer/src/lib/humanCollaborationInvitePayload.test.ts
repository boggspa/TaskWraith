import { describe, expect, it } from 'vitest'
import { buildHumanCollaborationInvitePayload } from './humanCollaborationInvitePayload'

function makeCreateShareResult(overrides: Record<string, unknown> = {}) {
  return {
    share: {
      shareId: 'share-1',
      chatId: 'chat-1',
      mode: 'comments' as const,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      nextSequence: 1,
      participants: [],
      invites: [],
      idempotency: {}
    },
    invite: {
      inviteId: 'invite-1',
      tokenHash: 'hash',
      createdAt: 2,
      expiresAt: 3
    },
    inviteToken: 'plain-token',
    relayUrl: 'wss://relay.example',
    relayUrls: ['wss://relay.example', 'wss://relay-alt.example'],
    roomId: 'room-1',
    hostIdentityPubKeyB64: 'host-key',
    ...overrides
  }
}

describe('buildHumanCollaborationInvitePayload', () => {
  it('builds the same portable invite JSON shape used by share creation', () => {
    const { payload, relayUrls, relayWarning } = buildHumanCollaborationInvitePayload(
      makeCreateShareResult({ relayWarning: 'Bridge relay is not reachable.' })
    )
    const parsed = JSON.parse(payload)

    expect(parsed).toMatchObject({
      type: 'taskwraith-human-collaboration-invite',
      v: 1,
      protocol: 'taskwraith-human-collaboration-v1',
      shareId: 'share-1',
      chatId: 'chat-1',
      inviteId: 'invite-1',
      inviteToken: 'plain-token',
      mode: 'comments',
      createdAt: 2,
      requiresOutOfBandSas: true,
      expiresAt: 3,
      relayUrl: 'wss://relay.example',
      relayUrls: ['wss://relay.example', 'wss://relay-alt.example'],
      roomId: 'room-1',
      hostIdentityPubKeyB64: 'host-key'
    })
    expect(relayUrls).toEqual(['wss://relay.example', 'wss://relay-alt.example'])
    expect(relayWarning).toBe('Bridge relay is not reachable.')
  })

  it('deduplicates relay URLs and trims empty relay warnings', () => {
    const { payload, relayUrls, relayWarning } = buildHumanCollaborationInvitePayload(
      makeCreateShareResult({
        relayUrl: 'wss://relay.example',
        relayUrls: ['wss://relay.example', '', 'wss://relay-two.example'],
        relayWarning: '   '
      })
    )
    const parsed = JSON.parse(payload)

    expect(relayUrls).toEqual(['wss://relay.example', 'wss://relay-two.example'])
    expect(parsed.relayUrls).toEqual(['wss://relay.example', 'wss://relay-two.example'])
    expect(relayWarning).toBe('')
  })
})
