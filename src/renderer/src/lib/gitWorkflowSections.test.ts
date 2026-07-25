import { describe, expect, it } from 'vitest'
import { chatGitWorkflowMarker, groupChatsByGitWorkflow } from './gitWorkflowSections'
import type { ChatGitWorkflowSnapshot } from '../../../shared/chatGitWorkflow'

function chat(id: string, gitWorkflow?: ChatGitWorkflowSnapshot) {
  return { id, gitWorkflow }
}

describe('chatGitWorkflowMarker', () => {
  it('returns valid markers and drops malformed ones', () => {
    expect(chatGitWorkflowMarker(chat('a', { state: 'open', updatedAt: 1 }))).toEqual({
      state: 'open',
      updatedAt: 1
    })
    expect(chatGitWorkflowMarker(chat('a'))).toBeNull()
    expect(
      chatGitWorkflowMarker(
        chat('a', { state: 'bogus', updatedAt: 1 } as unknown as ChatGitWorkflowSnapshot)
      )
    ).toBeNull()
  })
})

describe('groupChatsByGitWorkflow', () => {
  it('buckets under PRs/Pushed/Merged/Closed, newest marker first, omitting empty groups', () => {
    const groups = groupChatsByGitWorkflow([
      chat('old-open', { state: 'open', prNumber: 1, updatedAt: 10 }),
      chat('merged', { state: 'merged', prNumber: 2, updatedAt: 30 }),
      chat('new-draft', { state: 'draft', prNumber: 3, updatedAt: 20 }),
      chat('failing', { state: 'failed', prNumber: 4, updatedAt: 40 }),
      chat('no-marker'),
      chat('pushed', { state: 'pushed', updatedAt: 5 })
    ])
    expect(groups.map((group) => group.group)).toEqual(['pr', 'pushed', 'merged'])
    expect(groups[0].label).toBe('PRs')
    expect(groups[0].chats.map((entry) => entry.id)).toEqual(['failing', 'new-draft', 'old-open'])
    expect(groups[1].chats.map((entry) => entry.id)).toEqual(['pushed'])
    expect(groups[2].chats.map((entry) => entry.id)).toEqual(['merged'])
  })

  it('returns no groups for markerless input', () => {
    expect(groupChatsByGitWorkflow([chat('a'), chat('b')])).toEqual([])
  })
})
