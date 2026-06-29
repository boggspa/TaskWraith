import { describe, expect, it } from 'vitest'
import type { ChatRecord, WorkspaceBoardCard } from '../../../main/store/types'
import type { AgentApprovalRequest } from './agentApprovalTypes'
import { buildWorkspaceBoardProjectedCards, deriveWorkspaceBoardStatus } from './workspaceBoardProjection'

function makeChat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    scope: 'workspace',
    title: 'Workspace thread',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    provider: 'codex',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ...overrides
  }
}

function makeCard(overrides: Partial<WorkspaceBoardCard> = {}): WorkspaceBoardCard {
  return {
    id: 'card-1',
    boardId: 'board-1',
    workspaceId: 'ws-1',
    columnId: 'ready',
    title: 'Review changes',
    sortOrder: 1,
    createdAt: '2026-06-29T00:00:00.000Z',
    updatedAt: '2026-06-29T00:00:00.000Z',
    activity: [],
    ...overrides
  }
}

describe('workspace board projection', () => {
  it('derives live state from linked chats without changing the card lane', () => {
    const card = makeCard({ link: { kind: 'chat', id: 'chat-1' }, columnId: 'ready' })
    const projected = buildWorkspaceBoardProjectedCards({
      cards: [card],
      chats: [makeChat()],
      workflows: [],
      scheduledTasks: [],
      runQueueJobs: [],
      runningChatIds: new Set(['chat-1'])
    })

    expect(projected[0].columnId).toBe('ready')
    expect(projected[0].derivedStatus).toBe('running')
  })

  it('marks missing or archived links stale instead of recreating work', () => {
    const card = makeCard({ link: { kind: 'chat', id: 'chat-1' } })

    expect(
      deriveWorkspaceBoardStatus(card, {
        chats: [makeChat({ archived: true })],
        workflows: [],
        scheduledTasks: [],
        runQueueJobs: []
      })
    ).toBe('stale')

    expect(
      deriveWorkspaceBoardStatus(card, {
        chats: [],
        workflows: [],
        scheduledTasks: [],
        runQueueJobs: []
      })
    ).toBe('stale')
  })

  it('marks cross-workspace links stale without projecting foreign metadata', () => {
    const card = makeCard({ link: { kind: 'chat', id: 'chat-1' } })
    const projected = buildWorkspaceBoardProjectedCards({
      cards: [card],
      chats: [makeChat({ workspaceId: 'ws-2', title: 'Other workspace thread' })],
      workflows: [],
      scheduledTasks: [],
      runQueueJobs: []
    })[0]

    expect(projected.derivedStatus).toBe('stale')
    expect(projected.isStale).toBe(true)
    expect(projected.staleReason).toContain('belongs to another workspace')
    expect(projected.linkedTitle).toBeUndefined()
    expect(projected.badges.some((badge) => badge.label === 'Codex')).toBe(false)
  })

  it('marks successful chat runs review-ready and exposes live badges', () => {
    const card = makeCard({ link: { kind: 'chat', id: 'chat-1' }, columnId: 'ready' })
    const projected = buildWorkspaceBoardProjectedCards({
      cards: [card],
      chats: [
        makeChat({
          provider: 'codex',
          runs: [
            {
              runId: 'run-1',
              startedAt: '2026-06-29T00:00:00.000Z',
              endedAt: '2026-06-29T00:01:00.000Z',
              status: 'success'
            }
          ]
        })
      ],
      workflows: [],
      scheduledTasks: [],
      runQueueJobs: []
    })

    expect(projected[0].derivedStatus).toBe('review-ready')
    expect(projected[0].statusLabel).toBe('Review Ready')
    expect(projected[0].badges.some((badge) => badge.label === 'Codex')).toBe(true)
    expect(projected[0].badges.some((badge) => badge.label === 'Run review ready')).toBe(true)
  })

  it('projects pending approvals and shared chat state onto linked chat cards', () => {
    const card = makeCard({ link: { kind: 'chat', id: 'chat-1' }, columnId: 'running' })
    const approval: AgentApprovalRequest = {
      id: 'approval-1',
      provider: 'codex',
      appChatId: 'chat-1',
      method: 'shell',
      title: 'Approve shell command',
      body: 'npm test',
      actions: ['accept', 'decline']
    }
    const projected = buildWorkspaceBoardProjectedCards({
      cards: [card],
      chats: [makeChat({ pinned: true })],
      workflows: [],
      scheduledTasks: [],
      runQueueJobs: [],
      runningChatIds: new Set(['chat-1']),
      pendingApprovalsByChatId: { 'chat-1': approval },
      pendingApprovalQueueByChatId: { 'chat-1': [approval] },
      collaboratingChatIds: new Set(['chat-1'])
    })[0]

    expect(projected.derivedStatus).toBe('needs-input')
    expect(projected.liveStatusDetail).toBe('Waiting for approval: Approve shell command')
    expect(projected.badges.some((badge) => badge.label === 'Approval')).toBe(true)
    expect(projected.badges.some((badge) => badge.label === '+1 approvals')).toBe(true)
    expect(projected.badges.some((badge) => badge.label === 'Shared')).toBe(true)
    expect(projected.badges.some((badge) => badge.label === 'Pinned')).toBe(true)
  })
})
