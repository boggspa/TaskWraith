import { useMemo, useState } from 'react'
import type {
  ChatRecord,
  RunQueueJob,
  ScheduledTask,
  WorkflowDefinition,
  WorkspaceBoardCard,
  WorkspaceBoardColumnId,
  WorkspaceBoardDefinition,
  WorkspaceRecord
} from '../../../main/store/types'
import {
  buildWorkspaceBoardProjectedCards,
  type WorkspaceBoardProjectedCard
} from '../lib/workspaceBoardProjection'

const COLUMN_COPY: Record<WorkspaceBoardColumnId, string> = {
  inbox: 'Inbox',
  ready: 'Ready',
  running: 'Running',
  'needs-input': 'Needs Input',
  blocked: 'Blocked',
  'review-ready': 'Review Ready',
  done: 'Done',
  archived: 'Archived'
}

function statusLabel(card: WorkspaceBoardProjectedCard): string {
  if (card.isStale) return 'Stale link'
  if (card.derivedStatus === 'manual') return COLUMN_COPY[card.columnId]
  return card.derivedStatus
    .split('-')
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ')
}

interface WorkspaceBoardViewProps {
  board: WorkspaceBoardDefinition | null
  workspace: WorkspaceRecord | null
  cards: WorkspaceBoardCard[]
  chats: ChatRecord[]
  workflows: WorkflowDefinition[]
  scheduledTasks: ScheduledTask[]
  runQueueJobs: RunQueueJob[]
  runningChatIds?: Set<string>
  onAddCard: (
    card: Omit<WorkspaceBoardCard, 'id' | 'createdAt' | 'updatedAt' | 'activity'>
  ) => void | Promise<void>
  onUpdateCard: (id: string, partial: Partial<WorkspaceBoardCard>) => void | Promise<void>
  onDeleteCard: (id: string) => void | Promise<void>
  onOpenChat: (chat: ChatRecord) => void
  onOpenWorkflow: (workflow: WorkflowDefinition) => void
}

export function WorkspaceBoardView({
  board,
  workspace,
  cards,
  chats,
  workflows,
  scheduledTasks,
  runQueueJobs,
  runningChatIds,
  onAddCard,
  onUpdateCard,
  onDeleteCard,
  onOpenChat,
  onOpenWorkflow
}: WorkspaceBoardViewProps) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [linkValue, setLinkValue] = useState('')

  const workspaceChats = useMemo(
    () =>
      chats
        .filter((chat) => !chat.archived && chat.workspaceId === board?.workspaceId)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    [board?.workspaceId, chats]
  )
  const workspaceWorkflows = useMemo(
    () =>
      workflows
        .filter((workflow) => workflow.workspaceId === board?.workspaceId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [board?.workspaceId, workflows]
  )

  const projectedCards = useMemo(
    () =>
      buildWorkspaceBoardProjectedCards({
        cards,
        chats,
        workflows,
        scheduledTasks,
        runQueueJobs,
        runningChatIds
      }),
    [cards, chats, workflows, scheduledTasks, runQueueJobs, runningChatIds]
  )

  if (!board || !workspace) {
    return (
      <div className="workspace-board-pane" role="region" aria-label="Workspace board">
        <div className="workspace-board-empty">
          <h2>Workspace Board</h2>
          <p>Select or create a board from the sidebar.</p>
        </div>
      </div>
    )
  }

  const cardsByColumn = new Map<WorkspaceBoardColumnId, WorkspaceBoardProjectedCard[]>()
  for (const column of board.columns) cardsByColumn.set(column.id, [])
  for (const card of projectedCards) {
    const bucket = cardsByColumn.get(card.columnId) || []
    bucket.push(card)
    cardsByColumn.set(card.columnId, bucket)
  }

  const submitCard = () => {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) return
    const link =
      linkValue.startsWith('chat:')
        ? ({ kind: 'chat', id: linkValue.slice('chat:'.length) } as const)
        : linkValue.startsWith('workflow:')
          ? ({ kind: 'workflow', id: linkValue.slice('workflow:'.length) } as const)
          : undefined
    void onAddCard({
      boardId: board.id,
      workspaceId: board.workspaceId,
      columnId: 'inbox',
      title: trimmedTitle,
      body: body.trim() || undefined,
      sortOrder: Date.now(),
      link
    })
    setTitle('')
    setBody('')
    setLinkValue('')
  }

  const openLinked = (card: WorkspaceBoardProjectedCard) => {
    const link = card.card.link
    if (!link) return
    if (link.kind === 'chat') {
      const chat = chats.find((item) => item.appChatId === link.id)
      if (chat) onOpenChat(chat)
    }
    if (link.kind === 'workflow') {
      const workflow = workflows.find((item) => item.id === link.id)
      if (workflow) onOpenWorkflow(workflow)
    }
  }

  return (
    <div className="workspace-board-pane" role="region" aria-label={`${board.name} board`}>
      <header className="workspace-board-header">
        <div>
          <p className="workspace-board-kicker">{workspace.displayName}</p>
          <h2>{board.name}</h2>
        </div>
        <div className="workspace-board-summary" aria-label="Board summary">
          <span>{cards.filter((card) => !card.archived).length} cards</span>
          <span>{workspaceChats.length} workspace threads</span>
          <span>{workspaceWorkflows.length} workflows</span>
        </div>
      </header>

      <section className="workspace-board-add-card" aria-label="Add board card">
        <input
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
          placeholder="Card title"
        />
        <input
          value={body}
          onChange={(event) => setBody(event.currentTarget.value)}
          placeholder="Note or next step"
        />
        <select value={linkValue} onChange={(event) => setLinkValue(event.currentTarget.value)}>
          <option value="">No link</option>
          {workspaceChats.map((chat) => (
            <option key={`chat-${chat.appChatId}`} value={`chat:${chat.appChatId}`}>
              Thread: {chat.title}
            </option>
          ))}
          {workspaceWorkflows.map((workflow) => (
            <option key={`workflow-${workflow.id}`} value={`workflow:${workflow.id}`}>
              Workflow: {workflow.name}
            </option>
          ))}
        </select>
        <button type="button" onClick={submitCard} disabled={!title.trim()}>
          Add card
        </button>
      </section>

      <div className="workspace-board-columns">
        {board.columns
          .filter((column) => column.id !== 'archived')
          .map((column) => {
            const columnCards = cardsByColumn.get(column.id) || []
            return (
              <section key={column.id} className="workspace-board-column">
                <div className="workspace-board-column-header">
                  <h3>{column.name}</h3>
                  <span>{columnCards.length}</span>
                </div>
                <div className="workspace-board-card-stack">
                  {columnCards.length === 0 ? (
                    <div className="workspace-board-column-empty">No cards</div>
                  ) : (
                    columnCards.map((projected) => (
                      <article key={projected.card.id} className="workspace-board-card">
                        <div className="workspace-board-card-topline">
                          <span className={`workspace-board-status status-${projected.derivedStatus}`}>
                            {statusLabel(projected)}
                          </span>
                          {projected.card.humanOwner && <span>{projected.card.humanOwner}</span>}
                        </div>
                        <h4>{projected.card.title}</h4>
                        {projected.card.body && <p>{projected.card.body}</p>}
                        {projected.linkedTitle && (
                          <button
                            type="button"
                            className="workspace-board-link"
                            onClick={() => openLinked(projected)}
                            disabled={projected.isStale}
                          >
                            {projected.linkedTitle}
                            {projected.linkedSubtitle && <span>{projected.linkedSubtitle}</span>}
                          </button>
                        )}
                        <div className="workspace-board-card-actions">
                          <select
                            value={projected.card.columnId}
                            onChange={(event) =>
                              void onUpdateCard(projected.card.id, {
                                columnId: event.currentTarget.value as WorkspaceBoardColumnId,
                                sortOrder: Date.now()
                              })
                            }
                            aria-label={`Move ${projected.card.title}`}
                          >
                            {board.columns
                              .filter((item) => item.id !== 'archived')
                              .map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.name}
                                </option>
                              ))}
                          </select>
                          {projected.card.link?.kind === 'chat' ||
                          projected.card.link?.kind === 'workflow' ? (
                            <button
                              type="button"
                              onClick={() => openLinked(projected)}
                              disabled={projected.isStale}
                            >
                              Open
                            </button>
                          ) : null}
                          <button type="button" onClick={() => void onDeleteCard(projected.card.id)}>
                            Remove
                          </button>
                        </div>
                      </article>
                    ))
                  )}
                </div>
              </section>
            )
          })}
      </div>
    </div>
  )
}
