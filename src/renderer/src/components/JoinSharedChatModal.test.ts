import { describe, expect, it } from 'vitest'
import { bubbleClass, parseHumanCollaborationInvite, seatAccentClass } from './JoinSharedChatModal'

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

/**
 * The modal itself renders through `createPortal`, which has no server
 * renderer and no DOM environment in this repo — so the parity rules are
 * pinned at the pure functions that decide them.
 */
describe('collaborator projection presentation', () => {
  it('renders your own words as your bubbles and everyone else as named output', () => {
    // The rule the projection's `youAre` field exists to make possible. Without
    // it every collaborator row looked identical no matter who wrote it, so an
    // external could not tell their own message from the other guest's.
    expect(bubbleClass('collaborator', true)).toContain('join-projection-own')
    expect(bubbleClass('collaborator', false)).not.toContain('join-projection-own')
    expect(bubbleClass('collaborator', false)).toContain('human-collaborator-comment')
    // Self wins over role: your own row is yours whatever seat it came from.
    expect(bubbleClass('host', true)).toContain('join-projection-own')
    // Everyone else keeps their own presentation.
    expect(bubbleClass('host', false)).toBe('message-bubble user')
    expect(bubbleClass('assistant', false)).toBe('message-bubble assistant')
    expect(bubbleClass('placeholder', false)).toContain('join-projection-placeholder')
  })

  it('only ever emits a palette INDEX class, never a value off the wire', () => {
    // `colorIndex` is a number rather than a colour name precisely because it
    // crosses from an untrusted host and lands in a class attribute. Anything
    // that is not a real palette index must produce no class at all.
    expect(seatAccentClass(0)).toBe(' join-seat-color-0')
    expect(seatAccentClass(7)).toBe(' join-seat-color-7')
    expect(seatAccentClass(8)).toBe('')
    expect(seatAccentClass(-1)).toBe('')
    expect(seatAccentClass(1.5)).toBe('')
    expect(seatAccentClass(undefined)).toBe('')
    expect(seatAccentClass(NaN)).toBe('')
    // The shapes that would matter if this ever became a string concat.
    expect(seatAccentClass('0' as unknown as number)).toBe('')
    expect(seatAccentClass('0" onload="alert(1)' as unknown as number)).toBe('')
  })
})
