import { describe, expect, it } from 'vitest'

import {
  hasChatStarted,
  planPendingHomeClaims,
  type PendingHomeClaimChatLike
} from './projectHomeClaims'

const pristine = (appChatId: string): PendingHomeClaimChatLike => ({
  appChatId,
  messages: [],
  runs: []
})

describe('hasChatStarted', () => {
  it('stays false for pristine full and summary records', () => {
    expect(hasChatStarted(pristine('chat-a'))).toBe(false)
    expect(
      hasChatStarted({ appChatId: 'chat-a', summaryOnly: true, messageCount: 0, runCount: 0 })
    ).toBe(false)
  })

  it('fires on conversation content, run history, and summary counts', () => {
    expect(hasChatStarted({ appChatId: 'a', messages: [{ role: 'user' }] })).toBe(true)
    expect(hasChatStarted({ appChatId: 'a', messages: [], runs: [{}] })).toBe(true)
    expect(
      hasChatStarted({ appChatId: 'a', summaryOnly: true, messageCount: 0, runCount: 1 })
    ).toBe(true)
    expect(
      hasChatStarted({ appChatId: 'a', summaryOnly: true, messageCount: 2, runCount: 0 })
    ).toBe(true)
  })

  it('ignores system bookkeeping messages, matching the welcome-surface gate', () => {
    expect(hasChatStarted({ appChatId: 'a', messages: [{ role: 'system' }] })).toBe(false)
  })
})

describe('planPendingHomeClaims', () => {
  it('returns empty plans for an empty pending map', () => {
    expect(planPendingHomeClaims([pristine('chat-a')], new Map())).toEqual({
      claims: [],
      prune: []
    })
  })

  it('keeps pristine drafts pending, claims started ones, prunes vanished ones', () => {
    const pending = new Map([
      ['chat-pristine', 'project-a'],
      ['chat-started', 'project-b'],
      ['chat-gone', 'project-c']
    ])
    const plan = planPendingHomeClaims(
      [pristine('chat-pristine'), { appChatId: 'chat-started', messages: [{ role: 'user' }] }],
      pending
    )
    expect(plan.claims).toEqual([{ projectId: 'project-b', chatId: 'chat-started' }])
    expect(plan.prune).toEqual(['chat-gone'])
  })

  it('claims a draft whose only history is an aborted, message-less run', () => {
    const plan = planPendingHomeClaims(
      [{ appChatId: 'chat-a', summaryOnly: true, messageCount: 0, runCount: 1 }],
      new Map([['chat-a', 'project-a']])
    )
    expect(plan.claims).toEqual([{ projectId: 'project-a', chatId: 'chat-a' }])
  })
})
