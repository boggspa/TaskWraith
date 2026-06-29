import { describe, expect, it } from 'vitest'
import {
  applyWorkspaceBoardAgentPlan,
  previewWorkspaceBoardAgentPlan,
  type WorkspaceBoardAgentStore
} from './WorkspaceBoardAgentService'
import type { WorkspaceBoardCard, WorkspaceBoardDefinition } from '../store/types'

function createMemoryStore(): WorkspaceBoardAgentStore {
  let boardSeq = 1
  let cardSeq = 1
  const boards: WorkspaceBoardDefinition[] = []
  const cards: WorkspaceBoardCard[] = []
  const now = '2026-06-29T18:00:00.000Z'

  return {
    getWorkspaceBoards(workspaceId?: string) {
      return boards.filter((board) => !workspaceId || board.workspaceId === workspaceId)
    },
    saveWorkspaceBoard(board) {
      const existingIndex = board.id ? boards.findIndex((item) => item.id === board.id) : -1
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
      if (existingIndex >= 0) boards[existingIndex] = saved
      else boards.push(saved)
      return saved
    },
    updateWorkspaceBoard(id, partial) {
      const existing = boards.find((board) => board.id === id)
      if (!existing) return null
      Object.assign(existing, partial, { updatedAt: now })
      return existing
    },
    getWorkspaceBoardCards(boardId?: string) {
      return cards.filter((card) => !boardId || card.boardId === boardId)
    },
    saveWorkspaceBoardCard(card) {
      const existingIndex = card.id ? cards.findIndex((item) => item.id === card.id) : -1
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
      if (existingIndex >= 0) cards[existingIndex] = saved
      else cards.push(saved)
      return saved
    },
    updateWorkspaceBoardCard(id, partial) {
      const existing = cards.find((card) => card.id === id)
      if (!existing) return null
      Object.assign(existing, partial, { updatedAt: now })
      return existing
    }
  }
}

const fixedNow = () => new Date('2026-06-29T18:30:00.000Z')

describe('WorkspaceBoardAgentService', () => {
  it('previews a bounded agent board plan with server-stamped provenance', () => {
    const store = createMemoryStore()

    const preview = previewWorkspaceBoardAgentPlan(
      store,
      {
        workspaceId: 'ws-1',
        workspacePath: '/repo',
        name: 'Goal Board',
        sourceKind: 'goal',
        sourceId: 'goal-1',
        sourceTitle: 'Ship workspace boards',
        provider: 'codex',
        runId: 'run-1',
        cards: [{ title: 'Review plan', columnId: 'ready', sourceKind: 'manual' }]
      },
      { now: fixedNow }
    )

    expect(preview).toMatchObject({
      boardName: 'Goal Board',
      workspaceId: 'ws-1',
      operations: [
        { kind: 'create-board', title: 'Goal Board' },
        { kind: 'create-card', title: 'Review plan' }
      ]
    })
    expect(preview.operations[0].provenance).toMatchObject({
      actor: 'agent',
      sourceKind: 'goal',
      trust: 'agent-proposed',
      sourceId: 'goal-1',
      provider: 'codex',
      runId: 'run-1'
    })
    expect(preview.operations[1].provenance).toMatchObject({
      actor: 'agent',
      sourceKind: 'agent',
      trust: 'agent-proposed'
    })
  })

  it('applies a create plan without trusting caller-supplied authority fields', () => {
    const store = createMemoryStore()

    const result = applyWorkspaceBoardAgentPlan(
      store,
      {
        workspaceId: 'ws-1',
        workspacePath: '/repo',
        name: 'Plan Board',
        sourceKind: 'plan',
        provider: 'claude',
        runId: 'run-7',
        note: 'Generated from a plan',
        cards: [
          {
            title: 'Implement slice',
            body: 'Add the safe path first.',
            columnId: 'review-ready',
            labels: [' boards ', ' ', 'agent'],
            sourceKind: 'manual',
            sourceId: 'step-1',
            sourceTitle: 'Slice 1'
          }
        ]
      },
      { now: fixedNow }
    )

    expect(result.board).toMatchObject({
      id: 'board-1',
      workspaceId: 'ws-1',
      name: 'Plan Board',
      provenance: {
        actor: 'agent',
        sourceKind: 'plan',
        trust: 'agent-proposed',
        provider: 'claude',
        runId: 'run-7'
      }
    })
    expect(result.cards).toHaveLength(1)
    expect(result.cards[0]).toMatchObject({
      id: 'card-1',
      boardId: 'board-1',
      workspaceId: 'ws-1',
      columnId: 'review-ready',
      labels: ['boards', 'agent'],
      provenance: {
        actor: 'agent',
        sourceKind: 'agent',
        trust: 'agent-proposed',
        sourceId: 'step-1',
        sourceTitle: 'Slice 1',
        provider: 'claude',
        runId: 'run-7'
      }
    })
  })

  it('updates an existing linked card instead of creating a duplicate', () => {
    const store = createMemoryStore()
    const created = applyWorkspaceBoardAgentPlan(
      store,
      {
        workspaceId: 'ws-1',
        workspacePath: '/repo',
        name: 'Ops Board',
        cards: [
          {
            title: 'Thread follow-up',
            link: { kind: 'chat', id: 'chat-1' },
            columnId: 'ready'
          }
        ]
      },
      { now: fixedNow }
    )

    const updated = applyWorkspaceBoardAgentPlan(
      store,
      {
        boardId: created.board.id,
        provider: 'codex',
        runId: 'run-2',
        cards: [
          {
            title: 'Thread follow-up updated',
            link: { kind: 'chat', id: 'chat-1' },
            columnId: 'running',
            nextStep: 'Wait for completion'
          }
        ]
      },
      { now: fixedNow }
    )

    expect(updated.operations.map((operation) => operation.kind)).toEqual(['update-card'])
    expect(updated.cards).toHaveLength(1)
    expect(updated.cards[0]).toMatchObject({
      id: created.cards[0].id,
      title: 'Thread follow-up updated',
      columnId: 'running',
      nextStep: 'Wait for completion',
      provenance: {
        actor: 'agent',
        trust: 'agent-proposed',
        provider: 'codex',
        runId: 'run-2'
      }
    })
    expect(store.getWorkspaceBoardCards(created.board.id)).toHaveLength(1)
  })

  it('rejects an explicit board target from another workspace', () => {
    const store = createMemoryStore()
    const created = applyWorkspaceBoardAgentPlan(
      store,
      {
        workspaceId: 'ws-a',
        workspacePath: '/repo-a',
        name: 'Workspace A Board'
      },
      { now: fixedNow }
    )

    expect(() =>
      applyWorkspaceBoardAgentPlan(
        store,
        {
          workspaceId: 'ws-b',
          workspacePath: '/repo-b',
          boardId: created.board.id,
          cards: [{ title: 'Should fail' }]
        },
        { now: fixedNow }
      )
    ).toThrow('Workspace board target belongs to a different workspace.')
  })
})
