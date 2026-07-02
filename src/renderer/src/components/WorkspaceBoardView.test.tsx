import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type {
  ChatRecord,
  WorkspaceBoardCard,
  WorkspaceBoardDefinition,
  WorkspaceRecord
} from '../../../main/store/types'
import { buildWorkspaceBoardProjectedCards } from '../lib/workspaceBoardProjection'
import {
  isWorkspaceBoardAttentionMatch,
  sortWorkspaceBoardProjectedCards,
  WorkspaceBoardView,
  workspaceBoardInsertionSortOrder,
  workspaceBoardProjectedCardMatchesSearch
} from './WorkspaceBoardView'

const board: WorkspaceBoardDefinition = {
  id: 'board-1',
  workspaceId: 'ws-1',
  workspacePath: '/repo',
  name: 'Repo Board',
  columns: [
    { id: 'inbox', name: 'Inbox', sortOrder: 0 },
    { id: 'ready', name: 'Ready', sortOrder: 1 }
  ],
  provenance: {
    actor: 'user',
    sourceKind: 'manual',
    at: '2026-06-29T00:00:00.000Z',
    trust: 'user-confirmed',
    note: 'Created from test'
  },
  createdAt: '2026-06-29T00:00:00.000Z',
  updatedAt: '2026-06-29T00:00:00.000Z',
  activity: []
}

const workspace: WorkspaceRecord = {
  id: 'ws-1',
  path: '/repo',
  displayName: 'Repo',
  lastOpenedAt: 1,
  createdAt: 1,
  pinned: false
}

const chat: ChatRecord = {
  appChatId: 'chat-1',
  scope: 'workspace',
  title: 'Implementation thread',
  workspaceId: 'ws-1',
  workspacePath: '/repo',
  provider: 'codex',
  createdAt: 1,
  updatedAt: 1,
  archived: false,
  messages: [],
  runs: []
}

const card: WorkspaceBoardCard = {
  id: 'card-1',
  boardId: 'board-1',
  workspaceId: 'ws-1',
  columnId: 'ready',
  title: 'Review implementation',
  sortOrder: 1,
  link: { kind: 'chat', id: 'chat-1' },
  createdAt: '2026-06-29T00:00:00.000Z',
  updatedAt: '2026-06-29T00:00:00.000Z',
  activity: []
}

describe('WorkspaceBoardView', () => {
  it('renders inert planning actions only', () => {
    const html = renderToStaticMarkup(
      <WorkspaceBoardView
        board={board}
        workspace={workspace}
        cards={[card]}
        chats={[chat]}
        workflows={[]}
        scheduledTasks={[]}
        runQueueJobs={[]}
        onAddCard={() => {}}
        onUpdateCard={() => {}}
        onDeleteCard={() => {}}
        onOpenChat={() => {}}
        onOpenWorkflow={() => {}}
      />
    )

    expect(html).toContain('Repo Board')
    expect(html).toContain('User · Manual')
    expect(html).toContain('Add card')
    expect(html).toContain('Search cards')
    expect(html).toContain('Needs attention')
    expect(html).toContain('1 shown')
    expect(html).toContain('Move Review implementation up')
    expect(html).toContain('Move Review implementation down')
    expect(html).toContain('Open')
    expect(html).toContain('Archive')
    expect(html).toContain('Details')
    for (const forbidden of ['Dispatch', 'Approve', 'Deny', 'Delegate', 'Handoff', 'Retry', 'Cancel']) {
      expect(html).not.toContain(forbidden)
    }
    expect(html).not.toContain('Remove')
    expect(html).not.toContain('&gt;Run&lt;')
  })

  it('renders archived card recovery controls when archived cards exist', () => {
    const html = renderToStaticMarkup(
      <WorkspaceBoardView
        board={board}
        workspace={workspace}
        cards={[card, { ...card, id: 'card-archived', title: 'Archived finding', archived: true, columnId: 'archived' }]}
        chats={[chat]}
        workflows={[]}
        scheduledTasks={[]}
        runQueueJobs={[]}
        onAddCard={() => {}}
        onUpdateCard={() => {}}
        onDeleteCard={() => {}}
        onOpenChat={() => {}}
        onOpenWorkflow={() => {}}
      />
    )

    expect(html).toContain('Archived 1')
    expect(html).not.toContain('Archived finding')
  })

  it('renders the evidence-backed capability ledger strip', () => {
    const html = renderToStaticMarkup(
      <WorkspaceBoardView
        board={board}
        workspace={workspace}
        cards={[card]}
        chats={[chat]}
        workflows={[]}
        scheduledTasks={[]}
        runQueueJobs={[]}
        capabilityLedger={{
          workspaceId: 'ws-1',
          generatedAt: '2026-07-02T12:00:00.000Z',
          cells: [
            {
              capabilityKey: 'import-buttons',
              title: 'Import buttons',
              status: 'verified',
              evidenceRefs: [{ path: 'tests/import-buttons.test.ts', line: 8 }],
              latestEvidencePackId: 'pack-1',
              updatedAt: '2026-07-02T12:00:00.000Z'
            }
          ],
          mapEntries: [
            {
              key: 'import-buttons',
              title: 'Import buttons',
              provenance: {
                state: 'inferred',
                source: 'scope_radar',
                at: '2026-07-02T12:00:00.000Z'
              }
            }
          ],
          totalCompletionClaims: 2,
          unsupportedCompletionClaims: 1,
          unsupportedCompletionClaimRate: 0.5,
          stallSignals: [
            {
              kind: 'diff_without_capability_delta',
              severity: 'warning',
              evidencePackIds: ['pack-1', 'pack-2', 'pack-3'],
              note: 'Three packs touched files without capability movement.'
            }
          ]
        }}
        onAddCard={() => {}}
        onUpdateCard={() => {}}
        onDeleteCard={() => {}}
        onOpenChat={() => {}}
        onOpenWorkflow={() => {}}
      />
    )

    expect(html).toContain('Capability ledger')
    expect(html).toContain('1 capabilities')
    expect(html).toContain('50% unsupported')
    expect(html).toContain('1 stall signal')
    expect(html).toContain('Verified · Import buttons')
  })

  it('matches card filters against linked metadata and attention state', () => {
    const projected = buildWorkspaceBoardProjectedCards({
      cards: [
        {
          ...card,
          title: 'Fix launch checklist',
          body: 'Needs visual QA',
          humanOwner: 'Avery',
          labels: ['release'],
          nextStep: 'Review screenshots'
        }
      ],
      chats: [
        {
          ...chat,
          title: 'Screenshot QA thread',
          runs: [
            {
              runId: 'run-1',
              startedAt: '2026-06-29T00:00:00.000Z',
              status: 'success'
            }
          ]
        }
      ],
      workflows: [],
      scheduledTasks: [],
      runQueueJobs: []
    })[0]

    expect(workspaceBoardProjectedCardMatchesSearch(projected, 'screenshot codex')).toBe(true)
    expect(workspaceBoardProjectedCardMatchesSearch(projected, 'avery release')).toBe(true)
    expect(workspaceBoardProjectedCardMatchesSearch(projected, 'billing')).toBe(false)
    expect(isWorkspaceBoardAttentionMatch(projected)).toBe(true)
  })

  it('orders cards by sort order and computes insertion points', () => {
    const projected = buildWorkspaceBoardProjectedCards({
      cards: [
        {
          ...card,
          id: 'card-2',
          title: 'Second',
          sortOrder: 30
        },
        {
          ...card,
          id: 'card-1',
          title: 'First',
          sortOrder: 10
        }
      ],
      chats: [chat],
      workflows: [],
      scheduledTasks: [],
      runQueueJobs: []
    })
    const sorted = sortWorkspaceBoardProjectedCards(projected)

    expect(sorted.map((item) => item.card.title)).toEqual(['First', 'Second'])
    expect(workspaceBoardInsertionSortOrder(sorted, 'card-2', 'before')).toBe(20)
    expect(workspaceBoardInsertionSortOrder(sorted, 'card-1', 'before')).toBe(-1014)
    expect(workspaceBoardInsertionSortOrder(sorted)).toBe(1054)
  })
})
