import { join, sep } from 'path'
import { describe, expect, it } from 'vitest'
import {
  kimiAcpSeatStatePath,
  kimiAcpSeatStateRoot,
  legacyKimiAcpSeatStatePaths,
  legacyKimiAcpSeatStateRoots
} from './KimiAcpSeatState'

describe('KimiAcpSeatState', () => {
  it('isolates chats and participants behind stable opaque paths', () => {
    const solo = kimiAcpSeatStatePath('/user-data', 'chat-a')
    expect(solo).toBe(kimiAcpSeatStatePath('/user-data', 'chat-a', 'solo'))
    expect(solo).not.toBe(kimiAcpSeatStatePath('/user-data', 'chat-b'))
    expect(solo).not.toBe(kimiAcpSeatStatePath('/user-data', 'chat-a', 'worker'))
    expect(solo.startsWith(`${kimiAcpSeatStateRoot('/user-data')}${sep}`)).toBe(true)
    expect(solo).not.toContain('chat-a')
  })

  it('uses a new namespace and identifies legacy homes for cleanup only', () => {
    expect(kimiAcpSeatStateRoot('/user-data')).toBe(join('/user-data', 'kimi-acp-seats-v2'))
    expect(legacyKimiAcpSeatStateRoots('/user-data')).toEqual([
      join('/user-data', 'kimi-acp-seats-v1')
    ])
    expect(legacyKimiAcpSeatStatePaths('/user-data', 'chat-a')[0]).not.toBe(
      kimiAcpSeatStatePath('/user-data', 'chat-a')
    )
  })
})
