import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { AppStore } from './store'
import type { ChatMessage } from './store/types'
import { MissionFactLedgerRepository } from './missionLedger/MissionFactLedger'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-workspace-boards-test-${process.pid}`)

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

function saveBoard(id: string, workspaceId: string, workspacePath: string) {
  return AppStore.saveWorkspaceBoard({
    id,
    workspaceId,
    workspacePath,
    name: `${workspaceId} board`,
    columns: []
  })
}

describe('AppStore workspace boards', () => {
  beforeEach(() => {
    vi.useRealTimers()
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(userDataPath, { recursive: true })
  })

  it('rejects upserts that move an existing board to another workspace', () => {
    const board = saveBoard('board-a', 'ws-a', '/repo-a')

    expect(() =>
      AppStore.saveWorkspaceBoard({
        id: board.id,
        workspaceId: 'ws-b',
        workspacePath: '/repo-b',
        name: 'Moved board',
        columns: []
      })
    ).toThrow('Workspace board cannot move workspaces.')

    expect(AppStore.getWorkspaceBoard(board.id)).toMatchObject({
      id: board.id,
      workspaceId: 'ws-a',
      workspacePath: '/repo-a',
      name: 'ws-a board'
    })
  })

  it('rejects upserts that move an existing card to another board', () => {
    const boardA = saveBoard('board-a', 'ws-a', '/repo-a')
    const boardB = saveBoard('board-b', 'ws-b', '/repo-b')
    const chatA = AppStore.createChat('ws-a', '/repo-a')
    const chatB = AppStore.createChat('ws-b', '/repo-b')
    const card = AppStore.saveWorkspaceBoardCard({
      boardId: boardA.id,
      workspaceId: boardA.workspaceId,
      columnId: 'ready',
      title: 'Workspace A card',
      sortOrder: 1,
      link: { kind: 'chat', id: chatA.appChatId }
    })

    expect(() =>
      AppStore.saveWorkspaceBoardCard({
        id: card.id,
        boardId: boardB.id,
        workspaceId: boardB.workspaceId,
        columnId: 'running',
        title: 'Forged move',
        sortOrder: 2,
        link: { kind: 'chat', id: chatB.appChatId }
      })
    ).toThrow('Workspace board card cannot move boards.')

    expect(AppStore.getWorkspaceBoardCard(card.id)).toMatchObject({
      id: card.id,
      boardId: boardA.id,
      workspaceId: boardA.workspaceId,
      title: 'Workspace A card',
      link: { kind: 'chat', id: chatA.appChatId }
    })
  })

  it('validates updated card links against the existing board workspace', () => {
    const boardA = saveBoard('board-a', 'ws-a', '/repo-a')
    const chatA = AppStore.createChat('ws-a', '/repo-a')
    const chatB = AppStore.createChat('ws-b', '/repo-b')
    const card = AppStore.saveWorkspaceBoardCard({
      boardId: boardA.id,
      workspaceId: boardA.workspaceId,
      columnId: 'ready',
      title: 'Workspace A card',
      sortOrder: 1,
      link: { kind: 'chat', id: chatA.appChatId }
    })

    expect(() =>
      AppStore.saveWorkspaceBoardCard({
        id: card.id,
        boardId: boardA.id,
        workspaceId: boardA.workspaceId,
        columnId: 'ready',
        title: 'Cross workspace link',
        sortOrder: 2,
        link: { kind: 'chat', id: chatB.appChatId }
      })
    ).toThrow('Board card chat link must belong to the board workspace.')

    expect(AppStore.getWorkspaceBoardCard(card.id)).toMatchObject({
      id: card.id,
      title: 'Workspace A card',
      link: { kind: 'chat', id: chatA.appChatId }
    })
  })

  it('preserves precise workspace board card sort order values', () => {
    const board = saveBoard('board-a', 'ws-a', '/repo-a')
    const card = AppStore.saveWorkspaceBoardCard({
      boardId: board.id,
      workspaceId: board.workspaceId,
      columnId: 'ready',
      title: 'Precise order',
      sortOrder: 1024.5
    })

    expect(card.sortOrder).toBe(1024.5)
    const moved = AppStore.updateWorkspaceBoardCard(card.id, { sortOrder: -1014 })
    expect(moved?.sortOrder).toBe(-1014)
  })

  it('rejects unknown workspace board card link kinds instead of unlinking silently', () => {
    const board = saveBoard('board-a', 'ws-a', '/repo-a')

    expect(() =>
      AppStore.saveWorkspaceBoardCard({
        boardId: board.id,
        workspaceId: board.workspaceId,
        columnId: 'ready',
        title: 'Bad link',
        sortOrder: 1,
        link: { kind: 'surprise' as any, id: 'target-1' }
      })
    ).toThrow('Board card link kind is invalid.')
  })

  it('bounds local-server card links to runtime process ids', () => {
    const board = saveBoard('board-a', 'ws-a', '/repo-a')
    const card = AppStore.saveWorkspaceBoardCard({
      boardId: board.id,
      workspaceId: board.workspaceId,
      columnId: 'ready',
      title: 'Local server',
      sortOrder: 1,
      link: { kind: 'local-server', id: ' 5173 ' }
    })

    expect(card.link).toEqual({ kind: 'local-server', id: '5173' })
    expect(() =>
      AppStore.saveWorkspaceBoardCard({
        boardId: board.id,
        workspaceId: board.workspaceId,
        columnId: 'ready',
        title: 'Forged local server',
        sortOrder: 2,
        link: { kind: 'local-server', id: 'not-a-pid' }
      })
    ).toThrow('Board card local server link must use a runtime process id.')
  })

  it('surfaces workspace board persistence failures to callers', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1234)
    const tempPath = path.join(userDataPath, `workspace-boards.json.${process.pid}.1234.tmp`)
    fs.mkdirSync(tempPath, { recursive: true })

    expect(() => saveBoard('board-fail', 'ws-a', '/repo-a')).toThrow()
    expect(AppStore.getWorkspaceBoard('board-fail')).toBeNull()
    nowSpy.mockRestore()
  })

  it('validates pinned-message card links against the owning workspace message', () => {
    const board = saveBoard('board-a', 'ws-a', '/repo-a')
    const chat = AppStore.createChat('ws-a', '/repo-a')
    const message: ChatMessage = {
      id: 'message-1',
      role: 'assistant',
      content: 'Pinned follow-up',
      timestamp: '2026-06-29T00:00:00.000Z',
      metadata: { pinnedAt: 1 }
    }
    AppStore.saveChat({ ...chat, messages: [message] })

    const card = AppStore.saveWorkspaceBoardCard({
      boardId: board.id,
      workspaceId: board.workspaceId,
      columnId: 'inbox',
      title: 'Pinned message',
      sortOrder: 1,
      link: { kind: 'pinned-message', id: `${chat.appChatId}:message-1` }
    })
    expect(card.link).toEqual({ kind: 'pinned-message', id: `${chat.appChatId}:message-1` })

    expect(() =>
      AppStore.saveWorkspaceBoardCard({
        boardId: board.id,
        workspaceId: board.workspaceId,
        columnId: 'inbox',
        title: 'Missing pinned message',
        sortOrder: 2,
        link: { kind: 'pinned-message', id: `${chat.appChatId}:missing` }
      })
    ).toThrow('Board card pinned message link must belong to the board workspace.')
  })

  it('records agent activity only when the current write carries agent provenance', () => {
    const provenance = {
      actor: 'agent' as const,
      sourceKind: 'goal' as const,
      at: '2026-06-29T18:00:00.000Z',
      trust: 'agent-proposed' as const,
      provider: 'codex',
      runId: 'run-1'
    }
    const board = AppStore.saveWorkspaceBoard({
      id: 'board-agent',
      workspaceId: 'ws-a',
      workspacePath: '/repo-a',
      name: 'Agent board',
      columns: [],
      provenance
    })
    expect(board.activity.at(-1)?.actor).toBe('agent')

    const userUpdatedBoard = AppStore.updateWorkspaceBoard(board.id, { name: 'User rename' })
    expect(userUpdatedBoard?.activity.at(-1)?.actor).toBe('user')

    const agentUpdatedBoard = AppStore.updateWorkspaceBoard(board.id, {
      description: 'Agent-authored description',
      provenance
    })
    expect(agentUpdatedBoard?.activity.at(-1)?.actor).toBe('agent')

    const card = AppStore.saveWorkspaceBoardCard({
      boardId: board.id,
      workspaceId: board.workspaceId,
      columnId: 'ready',
      title: 'Agent card',
      sortOrder: 1,
      provenance
    })
    expect(card.activity.at(-1)?.actor).toBe('agent')

    const userUpdatedCard = AppStore.updateWorkspaceBoardCard(card.id, { title: 'User card edit' })
    expect(userUpdatedCard?.activity.at(-1)?.actor).toBe('user')

    const agentUpdatedCard = AppStore.updateWorkspaceBoardCard(card.id, {
      nextStep: 'Agent next step',
      provenance
    })
    expect(agentUpdatedCard?.activity.at(-1)?.actor).toBe('agent')
  })

  it('shadows linked Goal and Board state into the mission fact ledger', () => {
    const sourceChat = AppStore.createChat('ws-a', '/repo-a')
    const observedAt = '2026-08-16T00:00:00.000Z'
    AppStore.saveChat({
      ...sourceChat,
      activeGoal: {
        id: 'goal-board-shadow',
        objective: 'Ship the board shadow',
        objectiveSource: 'user',
        status: 'active',
        mode: 'taskwraith_steered',
        provider: 'codex',
        createdAt: observedAt,
        updatedAt: observedAt
      }
    })
    const missionFacts = new MissionFactLedgerRepository({
      rootPath: path.join(userDataPath, 'mission-facts')
    })
    expect(missionFacts.read('goal-board-shadow').projection).toMatchObject({
      objective: 'Ship the board shadow',
      status: 'active'
    })

    const board = saveBoard('board-shadow', 'ws-a', '/repo-a')
    const card = AppStore.saveWorkspaceBoardCard({
      boardId: board.id,
      workspaceId: board.workspaceId,
      columnId: 'running',
      title: 'Wire the board observer',
      sortOrder: 1,
      link: { kind: 'chat', id: sourceChat.appChatId }
    })
    expect(missionFacts.read('goal-board-shadow').projection?.workItems).toMatchObject([
      { workItemId: card.id, status: 'running' }
    ])

    AppStore.updateWorkspaceBoardCard(card.id, { columnId: 'done' })
    expect(missionFacts.read('goal-board-shadow').projection?.workItems).toMatchObject([
      { workItemId: card.id, status: 'done' }
    ])

    AppStore.deleteWorkspaceBoardCard(card.id)
    expect(missionFacts.read('goal-board-shadow').projection?.workItems).toEqual([])
  })
})
