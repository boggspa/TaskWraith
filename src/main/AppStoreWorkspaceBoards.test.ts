import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { AppStore } from './store'

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
})
