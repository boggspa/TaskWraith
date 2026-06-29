import { describe, expect, it } from 'vitest'
import {
  executeWorkspaceBoardMcpTool,
  isWorkspaceBoardMcpToolName,
  type WorkspaceBoardToolStore
} from './WorkspaceBoardToolExecutors'
import type { ChatRecord, WorkspaceBoardCard, WorkspaceBoardDefinition } from '../store/types'
import type { WorkspaceToolContext } from './WorkspaceToolExecutors'

function createStore(): WorkspaceBoardToolStore {
  let boardSeq = 1
  let cardSeq = 1
  const boards: WorkspaceBoardDefinition[] = []
  const cards: WorkspaceBoardCard[] = []
  const chats = new Map<string, ChatRecord>()
  const now = '2026-06-29T18:00:00.000Z'

  return {
    getChat(chatId) {
      return chats.get(chatId)
    },
    getWorkspaceBoards(workspaceId?: string) {
      return boards.filter((board) => !workspaceId || board.workspaceId === workspaceId)
    },
    saveWorkspaceBoard(board) {
      const saved: WorkspaceBoardDefinition = {
        id: board.id || `board-${boardSeq++}`,
        workspaceId: board.workspaceId,
        workspacePath: board.workspacePath,
        name: board.name,
        description: board.description,
        columns: board.columns,
        provenance: board.provenance,
        pinned: board.pinned,
        archived: board.archived,
        createdAt: board.createdAt || now,
        updatedAt: now,
        activity: board.activity || []
      }
      boards.push(saved)
      return saved
    },
    updateWorkspaceBoard(id, partial) {
      const board = boards.find((item) => item.id === id)
      if (!board) return null
      Object.assign(board, partial, { updatedAt: now })
      return board
    },
    getWorkspaceBoardCards(boardId?: string) {
      return cards.filter((card) => !boardId || card.boardId === boardId)
    },
    saveWorkspaceBoardCard(card) {
      const saved: WorkspaceBoardCard = {
        id: card.id || `card-${cardSeq++}`,
        boardId: card.boardId,
        workspaceId: card.workspaceId,
        columnId: card.columnId,
        title: card.title,
        body: card.body,
        sortOrder: card.sortOrder,
        humanOwner: card.humanOwner,
        labels: card.labels,
        link: card.link,
        blockedReason: card.blockedReason,
        nextStep: card.nextStep,
        reminderAt: card.reminderAt,
        provenance: card.provenance,
        archived: card.archived,
        createdAt: card.createdAt || now,
        updatedAt: now,
        activity: card.activity || []
      }
      cards.push(saved)
      return saved
    },
    updateWorkspaceBoardCard(id, partial) {
      const card = cards.find((item) => item.id === id)
      if (!card) return null
      Object.assign(card, partial, { updatedAt: now })
      return card
    },
    __addChat(chat: ChatRecord) {
      chats.set(chat.appChatId, chat)
    }
  } as WorkspaceBoardToolStore & { __addChat(chat: ChatRecord): void }
}

function workspaceChat(id: string, workspaceId: string, workspacePath: string): ChatRecord {
  return {
    appChatId: id,
    title: id,
    provider: 'codex',
    scope: 'workspace',
    workspaceId,
    workspacePath,
    messages: [],
    runs: [],
    createdAt: 1,
    updatedAt: 1,
    archived: false
  } as ChatRecord
}

function context(chatId: string): WorkspaceToolContext {
  return {
    scope: 'workspace',
    cwd: '/repo-a',
    workspacePath: '/repo-a',
    appChatId: chatId
  }
}

describe('WorkspaceBoardToolExecutors', () => {
  it('recognizes the workspace board MCP tools', () => {
    expect(isWorkspaceBoardMcpToolName('workspace_board_snapshot')).toBe(true)
    expect(isWorkspaceBoardMcpToolName('workspace_board_preview_plan')).toBe(true)
    expect(isWorkspaceBoardMcpToolName('workspace_board_apply_plan')).toBe(true)
    expect(isWorkspaceBoardMcpToolName('workspace_search')).toBe(false)
  })

  it('returns a current-workspace snapshot only', async () => {
    const store = createStore() as WorkspaceBoardToolStore & { __addChat(chat: ChatRecord): void }
    store.__addChat(workspaceChat('chat-a', 'ws-a', '/repo-a'))
    store.saveWorkspaceBoard({ workspaceId: 'ws-a', workspacePath: '/repo-a', name: 'A', columns: [] })
    store.saveWorkspaceBoard({ workspaceId: 'ws-b', workspacePath: '/repo-b', name: 'B', columns: [] })

    const result = await executeWorkspaceBoardMcpTool(
      store,
      'workspace_board_snapshot',
      {},
      context('chat-a'),
      { provider: 'codex', runId: 'run-1' }
    )

    expect(result.isError).toBe(false)
    expect(result.result).toMatchObject({ ok: true, workspaceId: 'ws-a', boardCount: 1 })
    expect((result.result as any).boards.map((board: any) => board.name)).toEqual(['A'])
  })

  it('applies an agent-stamped board plan', async () => {
    const store = createStore() as WorkspaceBoardToolStore & { __addChat(chat: ChatRecord): void }
    store.__addChat(workspaceChat('chat-a', 'ws-a', '/repo-a'))

    const result = await executeWorkspaceBoardMcpTool(
      store,
      'workspace_board_apply_plan',
      {
        name: 'Agent Board',
        sourceKind: 'goal',
        cards: [{ title: 'Review result', columnId: 'review-ready', labels: ['agent'] }]
      },
      context('chat-a'),
      { provider: 'claude', runId: 'run-2' }
    )

    expect(result.isError).toBe(false)
    expect(result.result).toMatchObject({
      ok: true,
      changed: true,
      board: {
        workspaceId: 'ws-a',
        workspacePath: '/repo-a',
        provenance: { actor: 'agent', sourceKind: 'goal', trust: 'agent-proposed', provider: 'claude' }
      },
      cards: [
        {
          title: 'Review result',
          columnId: 'review-ready',
          provenance: { actor: 'agent', trust: 'agent-proposed', provider: 'claude', runId: 'run-2' }
        }
      ]
    })
  })

  it('rejects global contexts and cross-workspace board targets', async () => {
    const store = createStore() as WorkspaceBoardToolStore & { __addChat(chat: ChatRecord): void }
    store.__addChat(workspaceChat('chat-a', 'ws-a', '/repo-a'))
    const other = store.saveWorkspaceBoard({
      workspaceId: 'ws-b',
      workspacePath: '/repo-b',
      name: 'Other',
      columns: []
    })

    const global = await executeWorkspaceBoardMcpTool(
      store,
      'workspace_board_snapshot',
      {},
      { scope: 'global', cwd: '/tmp' },
      { provider: 'codex' }
    )
    expect(global).toMatchObject({ isError: true, result: { ok: false } })

    const crossWorkspace = await executeWorkspaceBoardMcpTool(
      store,
      'workspace_board_apply_plan',
      { boardId: other.id, cards: [{ title: 'Nope' }] },
      context('chat-a'),
      { provider: 'codex' }
    )
    expect(crossWorkspace).toMatchObject({
      isError: true,
      result: { ok: false, error: 'Workspace board target was not found in the active workspace.' }
    })
  })
})
