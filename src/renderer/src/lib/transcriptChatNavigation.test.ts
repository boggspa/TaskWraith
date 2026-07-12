import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('transcript chat navigation integration', () => {
  it('routes chat identity transitions through scroll-state capture', () => {
    const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    const directAssignments = [...source.matchAll(/currentChatIdRef\.current\s*=(?!=)/g)]

    // One assignment belongs to setCurrentChatIdForNavigation itself; the
    // other is the post-render ref synchronizer for same-chat record updates.
    // Any navigation path adding a third direct write would bypass the outgoing
    // transcript capture and should make this guard fail until it uses the
    // shared transition helper.
    expect(directAssignments).toHaveLength(2)
    expect(source).toContain('setCurrentChatIdForNavigation(selectedChat.appChatId)')
    expect(source).toContain('setCurrentChatIdForNavigation(null)')
  })
})
