import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type {
  ChatRecord,
  WorkspaceBoardCard,
  WorkspaceBoardDefinition,
  WorkspaceRecord
} from '../../../main/store/types'
import { WorkspaceBoardView } from './WorkspaceBoardView'

const board: WorkspaceBoardDefinition = {
  id: 'board-1',
  workspaceId: 'ws-1',
  workspacePath: '/repo',
  name: 'Repo Board',
  columns: [
    { id: 'inbox', name: 'Inbox', sortOrder: 0 },
    { id: 'ready', name: 'Ready', sortOrder: 1 }
  ],
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
    expect(html).toContain('Add card')
    expect(html).toContain('Open')
    expect(html).toContain('Remove')
    for (const forbidden of ['Dispatch', 'Approve', 'Deny', 'Delegate', 'Handoff', 'Retry', 'Cancel']) {
      expect(html).not.toContain(forbidden)
    }
    expect(html).not.toContain('&gt;Run&lt;')
  })
})
