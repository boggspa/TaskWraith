import { describe, expect, it } from 'vitest'
import { kimiAcpSeatStatePath, kimiAcpSeatStateRoot } from './KimiAcpSeatState'

describe('KimiAcpSeatState', () => {
  it('isolates chats and participants behind stable opaque paths', () => {
    const solo = kimiAcpSeatStatePath('/user-data', 'chat-a')
    expect(solo).toBe(kimiAcpSeatStatePath('/user-data', 'chat-a', 'solo'))
    expect(solo).not.toBe(kimiAcpSeatStatePath('/user-data', 'chat-b'))
    expect(solo).not.toBe(kimiAcpSeatStatePath('/user-data', 'chat-a', 'worker'))
    expect(solo.startsWith(`${kimiAcpSeatStateRoot('/user-data')}/`)).toBe(true)
    expect(solo).not.toContain('chat-a')
  })
})
