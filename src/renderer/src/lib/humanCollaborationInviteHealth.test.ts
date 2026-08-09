import { describe, expect, it } from 'vitest'
import {
  classifyHumanCollaborationRelayUrls,
  sameStringSetMembers
} from './humanCollaborationInviteHealth'

describe('classifyHumanCollaborationRelayUrls', () => {
  it('separates LAN, remote, and loopback relay doors', () => {
    const availability = classifyHumanCollaborationRelayUrls([
      'ws://127.0.0.1:8787',
      'ws://192.168.0.147:8787',
      'wss://studio.example.ts.net',
      'ws://192.168.0.147:8787',
      ''
    ])

    expect(availability.relayUrls).toEqual([
      'ws://127.0.0.1:8787',
      'ws://192.168.0.147:8787',
      'wss://studio.example.ts.net'
    ])
    expect(availability.lanAvailable).toBe(true)
    expect(availability.remoteAvailable).toBe(true)
    expect(availability.loopbackOnly).toBe(false)
  })

  it('marks loopback-only invites as unavailable to collaborators', () => {
    const availability = classifyHumanCollaborationRelayUrls(['ws://localhost:8787'])

    expect(availability.lanAvailable).toBe(false)
    expect(availability.remoteAvailable).toBe(false)
    expect(availability.loopbackOnly).toBe(true)
  })

  it('treats local names and private 172 addresses as LAN relay doors', () => {
    expect(
      classifyHumanCollaborationRelayUrls(['ws://Chriss-Mac-Studio.local:8787'])
        .lanAvailable
    ).toBe(true)
    expect(classifyHumanCollaborationRelayUrls(['ws://172.20.0.4:8787']).lanAvailable).toBe(
      true
    )
  })
})

describe('sameStringSetMembers', () => {
  it('treats order as irrelevant and detects membership changes', () => {
    expect(sameStringSetMembers(new Set(['chat-a', 'chat-b']), new Set(['chat-b', 'chat-a']))).toBe(
      true
    )
    expect(sameStringSetMembers(new Set(['chat-a']), new Set(['chat-b']))).toBe(false)
    expect(sameStringSetMembers(new Set(['chat-a']), new Set(['chat-a', 'chat-b']))).toBe(false)
  })
})
