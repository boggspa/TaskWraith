import { useMemo, useState, type DragEvent, type FormEvent } from 'react'
import type {
  ChatRecord,
  RunQueueJob,
  ScheduledTask,
  WorkflowDefinition,
  WorkspaceBoardCard,
  WorkspaceBoardCardLink,
  WorkspaceBoardColumnId,
  WorkspaceBoardDefinition,
  WorkspaceRecord
} from '../../../main/store/types'
import {
  buildWorkspaceBoardProjectedCards,
  workspaceBoardColumnLabel,
  type WorkspaceBoardAttentionState,
  type WorkspaceBoardProjectedCard
} from '../lib/workspaceBoardProjection'

const ACTIVE_RUN_QUEUE_STATUSES = new Set(['queued', 'starting', 'active', 'steer_promoting', 'cancelling'])
const STALE_THREAD_AGE_MS = 7 * 24 * 60 * 60 * 1000
const WORKSPACE_BOARD_SORT_GAP = 1024
const ATTENTION_FILTER_STATES = new Set<WorkspaceBoardAttentionState>([
  'running',
  'needs-input',
  'blocked',
  'review-ready',
  'stale'
])

interface LinkOption {
  value: string
  label: string
  meta: string
  link: WorkspaceBoardCardLink
}

interface SeedCandidate {
  key: string
  title: string
  body?: string
  columnId: WorkspaceBoardColumnId
  labels?: string[]
  link: WorkspaceBoardCardLink
  blockedReason?: string
  nextStep?: string
}

interface DetailDraft {
  title: string
  body: string
  humanOwner: string
  labels: string
  blockedReason: string
  nextStep: string
  reminderAt: string
}

interface LastArchivedCard {
  id: string
  title: string
  columnId: WorkspaceBoardColumnId
}

type WorkspaceBoardDropEdge = 'before' | 'after'

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

function latestRun(chat: ChatRecord) {
  return chat.runs && chat.runs.length > 0 ? chat.runs[chat.runs.length - 1] : null
}

function isRunningChat(chat: ChatRecord, runningChatIds?: Set<string>): boolean {
  const run = latestRun(chat)
  return (
    Boolean(runningChatIds?.has(chat.appChatId)) ||
    run?.status === 'running' ||
    run?.status === 'sleeping'
  )
}

function isSuccessfulRunStatus(status?: string): boolean {
  return status === 'success' || status === 'success_with_warnings' || status === 'completed'
}

function linkKey(link?: WorkspaceBoardCardLink): string {
  return link ? `${link.kind}:${link.id}` : ''
}

function encodeLink(link: WorkspaceBoardCardLink): string {
  return linkKey(link)
}

function parseLink(value: string): WorkspaceBoardCardLink | undefined {
  const separator = value.indexOf(':')
  if (separator <= 0) return undefined
  const kind = value.slice(0, separator)
  const id = value.slice(separator + 1)
  if (
    kind !== 'chat' &&
    kind !== 'workflow' &&
    kind !== 'scheduled-task' &&
    kind !== 'run-queue-job'
  ) {
    return undefined
  }
  if (!id) return undefined
  return { kind, id }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Workspace board update failed.')
}

function labelsFromText(value: string): string[] | undefined {
  const labels = value
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean)
    .slice(0, 12)
  return labels.length > 0 ? labels : undefined
}

function draftFromCard(card: WorkspaceBoardCard): DetailDraft {
  return {
    title: card.title,
    body: card.body || '',
    humanOwner: card.humanOwner || '',
    labels: (card.labels || []).join(', '),
    blockedReason: card.blockedReason || '',
    nextStep: card.nextStep || '',
    reminderAt: card.reminderAt || ''
  }
}

function candidateColumnForChat(
  chat: ChatRecord,
  runningChatIds?: Set<string>
): WorkspaceBoardColumnId {
  const run = latestRun(chat)
  if (chat.activeGoal?.status === 'blocked') return 'blocked'
  if (isRunningChat(chat, runningChatIds)) return 'running'
  if (run?.status === 'failed' || run?.status === 'cancelled') return 'needs-input'
  if (isSuccessfulRunStatus(run?.status)) return 'review-ready'
  if (Date.now() - (chat.updatedAt || 0) > STALE_THREAD_AGE_MS) return 'needs-input'
  return 'inbox'
}

function candidateColumnForWorkflow(workflow: WorkflowDefinition): WorkspaceBoardColumnId {
  if (workflow.activeExecutionId || workflow.lastStatus === 'running' || workflow.lastStatus === 'queued') {
    return 'running'
  }
  if (workflow.lastStatus === 'failed' || workflow.failureStreak > 0 || workflow.lastStatus === 'cancelled') {
    return 'needs-input'
  }
  if (workflow.lastStatus === 'completed') return 'review-ready'
  return 'ready'
}

function candidateColumnForTask(task: ScheduledTask): WorkspaceBoardColumnId {
  if (task.status === 'running' || task.status === 'due') return 'running'
  if (task.status === 'failed' || task.status === 'cancelled') return 'needs-input'
  if (task.status === 'completed') return 'done'
  return 'ready'
}

function candidateColumnForJob(job: RunQueueJob): WorkspaceBoardColumnId {
  if (ACTIVE_RUN_QUEUE_STATUSES.has(job.status)) return 'running'
  if (job.status === 'failed' || job.status === 'cancelled') return 'needs-input'
  if (job.status === 'completed') return 'done'
  return 'ready'
}

function titleForTask(task: ScheduledTask): string {
  return task.displayPrompt || task.prompt || 'Scheduled task'
}

function titleForJob(job: RunQueueJob): string {
  return job.promptPreview || job.request?.displayPrompt || job.request?.prompt || job.runId || 'Run queue job'
}

function normalizeCardSearch(value: string): string[] {
  return value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

export function isWorkspaceBoardAttentionMatch(projected: WorkspaceBoardProjectedCard): boolean {
  return ATTENTION_FILTER_STATES.has(projected.attentionState)
}

export function workspaceBoardProjectedCardMatchesSearch(
  projected: WorkspaceBoardProjectedCard,
  query: string
): boolean {
  const tokens = normalizeCardSearch(query)
  if (tokens.length === 0) return true
  const link = projected.card.link
  const searchable = [
    projected.card.title,
    projected.card.body,
    projected.card.humanOwner,
    projected.card.blockedReason,
    projected.card.nextStep,
    projected.card.reminderAt,
    projected.card.labels?.join(' '),
    projected.laneLabel,
    projected.statusLabel,
    projected.derivedStatus,
    projected.linkedTitle,
    projected.linkedSubtitle,
    projected.linkedKindLabel,
    projected.liveStatusDetail,
    projected.staleReason,
    projected.badges.map((badge) => `${badge.label} ${badge.title || ''}`).join(' '),
    link ? `${link.kind} ${link.id}` : undefined
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return tokens.every((token) => searchable.includes(token))
}

export function sortWorkspaceBoardProjectedCards(
  cards: WorkspaceBoardProjectedCard[]
): WorkspaceBoardProjectedCard[] {
  return [...cards].sort((a, b) => {
    const sortOrderDelta = (a.card.sortOrder || 0) - (b.card.sortOrder || 0)
    if (sortOrderDelta !== 0) return sortOrderDelta
    const updatedDelta = a.card.updatedAt.localeCompare(b.card.updatedAt)
    if (updatedDelta !== 0) return updatedDelta
    return a.card.id.localeCompare(b.card.id)
  })
}

export function workspaceBoardInsertionSortOrder(
  columnCards: WorkspaceBoardProjectedCard[],
  targetCardId?: string,
  edge: WorkspaceBoardDropEdge = 'after',
  movingCardId?: string
): number {
  const sortedCards = sortWorkspaceBoardProjectedCards(
    movingCardId ? columnCards.filter((projected) => projected.card.id !== movingCardId) : columnCards
  )
  if (sortedCards.length === 0) return WORKSPACE_BOARD_SORT_GAP
  const targetIndex = targetCardId
    ? sortedCards.findIndex((projected) => projected.card.id === targetCardId)
    : -1
  if (targetIndex < 0) return (sortedCards[sortedCards.length - 1]?.card.sortOrder || 0) + WORKSPACE_BOARD_SORT_GAP
  const beforeIndex = edge === 'before' ? targetIndex - 1 : targetIndex
  const afterIndex = edge === 'before' ? targetIndex : targetIndex + 1
  const beforeSortOrder = beforeIndex >= 0 ? sortedCards[beforeIndex]?.card.sortOrder : undefined
  const afterSortOrder =
    afterIndex >= 0 && afterIndex < sortedCards.length ? sortedCards[afterIndex]?.card.sortOrder : undefined
  if (typeof beforeSortOrder !== 'number' && typeof afterSortOrder !== 'number') {
    return WORKSPACE_BOARD_SORT_GAP
  }
  if (typeof beforeSortOrder !== 'number') return (afterSortOrder || 0) - WORKSPACE_BOARD_SORT_GAP
  if (typeof afterSortOrder !== 'number') return beforeSortOrder + WORKSPACE_BOARD_SORT_GAP
  if (beforeSortOrder === afterSortOrder) return beforeSortOrder + 1
  return beforeSortOrder + (afterSortOrder - beforeSortOrder) / 2
}

function buildCardsByColumn(
  columns: WorkspaceBoardDefinition['columns'],
  projectedCards: WorkspaceBoardProjectedCard[]
): Map<WorkspaceBoardColumnId, WorkspaceBoardProjectedCard[]> {
  const cardsByColumn = new Map<WorkspaceBoardColumnId, WorkspaceBoardProjectedCard[]>()
  for (const column of columns) cardsByColumn.set(column.id, [])
  for (const card of sortWorkspaceBoardProjectedCards(projectedCards)) {
    const bucket = cardsByColumn.get(card.columnId) || []
    bucket.push(card)
    cardsByColumn.set(card.columnId, bucket)
  }
  return cardsByColumn
}

function dropEdgeFromEvent(event: DragEvent<HTMLElement>): WorkspaceBoardDropEdge {
  const rect = event.currentTarget.getBoundingClientRect()
  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
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
  const [cardSearch, setCardSearch] = useState('')
  const [showAttentionOnly, setShowAttentionOnly] = useState(false)
  const [isAdding, setIsAdding] = useState(false)
  const [isSeeding, setIsSeeding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null)
  const [detailDraft, setDetailDraft] = useState<DetailDraft | null>(null)
  const [isSavingDetail, setIsSavingDetail] = useState(false)
  const [lastArchivedCard, setLastArchivedCard] = useState<LastArchivedCard | null>(null)
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null)
  const [dragOverColumnId, setDragOverColumnId] = useState<WorkspaceBoardColumnId | null>(null)
  const [dragOverCard, setDragOverCard] = useState<{
    cardId: string
    edge: WorkspaceBoardDropEdge
  } | null>(null)

  const workspaceChats = useMemo(
    () =>
      chats
        .filter((chat) => !chat.archived && chat.workspaceId === board?.workspaceId && chat.scope !== 'global')
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
  const workspaceScheduledTasks = useMemo(
    () =>
      scheduledTasks
        .filter((task) => task.workspaceId === board?.workspaceId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [board?.workspaceId, scheduledTasks]
  )
  const workspaceRunQueueJobs = useMemo(
    () =>
      runQueueJobs
        .filter((job) => job.workspaceId === board?.workspaceId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [board?.workspaceId, runQueueJobs]
  )

  const linkOptions = useMemo<LinkOption[]>(() => {
    const options: LinkOption[] = []
    for (const chat of workspaceChats) {
      const link: WorkspaceBoardCardLink = { kind: 'chat', id: chat.appChatId }
      options.push({
        value: encodeLink(link),
        label: `Thread: ${chat.title}`,
        meta: chat.provider || 'thread',
        link
      })
    }
    for (const workflow of workspaceWorkflows) {
      const link: WorkspaceBoardCardLink = { kind: 'workflow', id: workflow.id }
      options.push({
        value: encodeLink(link),
        label: `Workflow: ${workflow.name}`,
        meta: workflow.template.provider,
        link
      })
    }
    for (const task of workspaceScheduledTasks) {
      const link: WorkspaceBoardCardLink = { kind: 'scheduled-task', id: task.id }
      options.push({
        value: encodeLink(link),
        label: `Scheduled: ${titleForTask(task)}`,
        meta: task.status,
        link
      })
    }
    for (const job of workspaceRunQueueJobs) {
      const link: WorkspaceBoardCardLink = { kind: 'run-queue-job', id: job.id }
      options.push({
        value: encodeLink(link),
        label: `Run: ${titleForJob(job)}`,
        meta: job.status,
        link
      })
    }
    return options
  }, [workspaceChats, workspaceWorkflows, workspaceScheduledTasks, workspaceRunQueueJobs])

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
  const activeProjectedCards = useMemo(
    () => projectedCards.filter((projected) => !projected.card.archived && projected.columnId !== 'archived'),
    [projectedCards]
  )
  const filteredProjectedCards = useMemo(
    () =>
      activeProjectedCards.filter((projected) => {
        if (showAttentionOnly && !isWorkspaceBoardAttentionMatch(projected)) return false
        return workspaceBoardProjectedCardMatchesSearch(projected, cardSearch)
      }),
    [activeProjectedCards, cardSearch, showAttentionOnly]
  )
  const isFiltered = cardSearch.trim().length > 0 || showAttentionOnly

  const seedCandidates = useMemo<SeedCandidate[]>(() => {
    if (!board) return []
    const existingLinks = new Set(cards.map((card) => linkKey(card.link)).filter(Boolean))
    const seen = new Set<string>()
    const candidates: SeedCandidate[] = []
    const add = (candidate: SeedCandidate) => {
      if (existingLinks.has(candidate.key) || seen.has(candidate.key)) return
      seen.add(candidate.key)
      candidates.push(candidate)
    }

    for (const chat of workspaceChats) {
      const columnId = candidateColumnForChat(chat, runningChatIds)
      const labels = ['thread']
      if (columnId !== 'inbox') labels.push(workspaceBoardColumnLabel(columnId).toLowerCase())
      add({
        key: `chat:${chat.appChatId}`,
        title: chat.title || 'Workspace thread',
        body: chat.activeGoal?.objective ? `Goal: ${chat.activeGoal.objective}` : undefined,
        columnId,
        labels,
        link: { kind: 'chat', id: chat.appChatId },
        blockedReason: chat.activeGoal?.status === 'blocked' ? chat.activeGoal.blockedReason : undefined
      })
    }
    for (const workflow of workspaceWorkflows) {
      const columnId = candidateColumnForWorkflow(workflow)
      add({
        key: `workflow:${workflow.id}`,
        title: workflow.name,
        body: workflow.lastError || workflow.template.prompt,
        columnId,
        labels: ['workflow', workflow.template.provider],
        link: { kind: 'workflow', id: workflow.id }
      })
    }
    for (const task of workspaceScheduledTasks.filter((task) => task.status !== 'completed')) {
      const columnId = candidateColumnForTask(task)
      add({
        key: `scheduled-task:${task.id}`,
        title: titleForTask(task),
        body: task.lastError || `Scheduled task for ${task.runAt}`,
        columnId,
        labels: ['scheduled', task.provider, task.status],
        link: { kind: 'scheduled-task', id: task.id }
      })
    }
    for (const job of workspaceRunQueueJobs.filter((job) => job.status !== 'completed')) {
      const columnId = candidateColumnForJob(job)
      add({
        key: `run-queue-job:${job.id}`,
        title: titleForJob(job),
        body: job.lastError || job.statusReason || job.request?.prompt,
        columnId,
        labels: ['run', job.provider, job.status],
        link: { kind: 'run-queue-job', id: job.id }
      })
    }
    return candidates
  }, [board, cards, workspaceChats, workspaceWorkflows, workspaceScheduledTasks, workspaceRunQueueJobs, runningChatIds])

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

  const activeCardsByColumn = buildCardsByColumn(board.columns, activeProjectedCards)
  const visibleCardsByColumn = buildCardsByColumn(board.columns, filteredProjectedCards)

  const selectedProjected = selectedCardId
    ? projectedCards.find((projected) => projected.card.id === selectedCardId) || null
    : null

  const submitCard = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedTitle = title.trim()
    if (!trimmedTitle || isAdding) return
    setIsAdding(true)
    setError(null)
    try {
      await onAddCard({
        boardId: board.id,
        workspaceId: board.workspaceId,
        columnId: 'inbox',
        title: trimmedTitle,
        body: body.trim() || undefined,
        sortOrder: Date.now(),
        link: parseLink(linkValue)
      })
      setTitle('')
      setBody('')
      setLinkValue('')
    } catch (err) {
      setError(formatError(err))
    } finally {
      setIsAdding(false)
    }
  }

  const seedBoard = async () => {
    if (seedCandidates.length === 0 || isSeeding) return
    setIsSeeding(true)
    setError(null)
    try {
      let sortOrder = Date.now()
      for (const candidate of seedCandidates) {
        await onAddCard({
          boardId: board.id,
          workspaceId: board.workspaceId,
          columnId: candidate.columnId,
          title: candidate.title,
          body: candidate.body,
          sortOrder: sortOrder++,
          labels: candidate.labels,
          link: candidate.link,
          blockedReason: candidate.blockedReason,
          nextStep: candidate.nextStep
        })
      }
    } catch (err) {
      setError(formatError(err))
    } finally {
      setIsSeeding(false)
    }
  }

  const openLinked = (card: WorkspaceBoardProjectedCard) => {
    const link = card.card.link
    if (!link || card.isStale) return
    if (link.kind === 'chat') {
      const chat = chats.find((item) => item.appChatId === link.id)
      if (chat) onOpenChat(chat)
      return
    }
    if (link.kind === 'workflow') {
      const workflow = workflows.find((item) => item.id === link.id)
      if (workflow) onOpenWorkflow(workflow)
      return
    }
    if (link.kind === 'scheduled-task') {
      const task = scheduledTasks.find((item) => item.id === link.id)
      const chat = task ? chats.find((item) => item.appChatId === task.chatId) : null
      if (chat) onOpenChat(chat)
      return
    }
    if (link.kind === 'run-queue-job') {
      const job = runQueueJobs.find((item) => item.id === link.id || item.runId === link.id)
      const chat = job?.chatId ? chats.find((item) => item.appChatId === job.chatId) : null
      if (chat) onOpenChat(chat)
    }
  }

  const openDetails = (projected: WorkspaceBoardProjectedCard) => {
    setSelectedCardId(projected.card.id)
    setDetailDraft(draftFromCard(projected.card))
    setError(null)
  }

  const saveDetails = async () => {
    if (!selectedProjected || !detailDraft || isSavingDetail) return
    const trimmedTitle = detailDraft.title.trim()
    if (!trimmedTitle) {
      setError('Card title is required.')
      return
    }
    setIsSavingDetail(true)
    setError(null)
    try {
      await onUpdateCard(selectedProjected.card.id, {
        title: trimmedTitle,
        body: detailDraft.body.trim() || undefined,
        humanOwner: detailDraft.humanOwner.trim() || undefined,
        labels: labelsFromText(detailDraft.labels),
        blockedReason: detailDraft.blockedReason.trim() || undefined,
        nextStep: detailDraft.nextStep.trim() || undefined,
        reminderAt: detailDraft.reminderAt.trim() || undefined
      })
    } catch (err) {
      setError(formatError(err))
    } finally {
      setIsSavingDetail(false)
    }
  }

  const moveCard = async (
    projected: WorkspaceBoardProjectedCard,
    columnId: WorkspaceBoardColumnId,
    sortOrder?: number
  ) => {
    if (projected.card.columnId === columnId && typeof sortOrder !== 'number') return
    setError(null)
    try {
      await onUpdateCard(projected.card.id, {
        columnId,
        sortOrder:
          typeof sortOrder === 'number'
            ? sortOrder
            : workspaceBoardInsertionSortOrder(
                activeCardsByColumn.get(columnId) || [],
                undefined,
                'after',
                projected.card.id
              )
      })
    } catch (err) {
      setError(formatError(err))
    }
  }

  const moveCardRelativeToTarget = async (
    projected: WorkspaceBoardProjectedCard,
    target: WorkspaceBoardProjectedCard,
    edge: WorkspaceBoardDropEdge
  ) => {
    if (projected.card.id === target.card.id) return
    const columnCards = activeCardsByColumn.get(target.card.columnId) || []
    const sortOrder = workspaceBoardInsertionSortOrder(columnCards, target.card.id, edge, projected.card.id)
    await moveCard(projected, target.card.columnId, sortOrder)
  }

  const moveCardWithinColumn = async (projected: WorkspaceBoardProjectedCard, direction: -1 | 1) => {
    const columnCards = activeCardsByColumn.get(projected.card.columnId) || []
    const currentIndex = columnCards.findIndex((item) => item.card.id === projected.card.id)
    const target = currentIndex >= 0 ? columnCards[currentIndex + direction] : undefined
    if (!target) return
    await moveCardRelativeToTarget(projected, target, direction < 0 ? 'before' : 'after')
  }

  const archiveCard = async (projected: WorkspaceBoardProjectedCard) => {
    setError(null)
    try {
      await onUpdateCard(projected.card.id, {
        archived: true,
        columnId: 'archived'
      })
      setLastArchivedCard({
        id: projected.card.id,
        title: projected.card.title,
        columnId: projected.card.columnId
      })
      if (selectedCardId === projected.card.id) {
        setSelectedCardId(null)
        setDetailDraft(null)
      }
    } catch (err) {
      setError(formatError(err))
    }
  }

  const restoreLastArchivedCard = async () => {
    if (!lastArchivedCard) return
    setError(null)
    try {
      await onUpdateCard(lastArchivedCard.id, {
        archived: false,
        columnId: lastArchivedCard.columnId,
        sortOrder: Date.now()
      })
      setLastArchivedCard(null)
    } catch (err) {
      setError(formatError(err))
    }
  }

  const permanentlyDeleteSelectedCard = async () => {
    if (!selectedProjected) return
    const confirmed = window.confirm(`Permanently delete "${selectedProjected.card.title}"?`)
    if (!confirmed) return
    setError(null)
    try {
      await onDeleteCard(selectedProjected.card.id)
      setSelectedCardId(null)
      setDetailDraft(null)
    } catch (err) {
      setError(formatError(err))
    }
  }

  const unlinkSelectedCard = async () => {
    if (!selectedProjected) return
    setError(null)
    try {
      await onUpdateCard(selectedProjected.card.id, { link: undefined })
    } catch (err) {
      setError(formatError(err))
    }
  }

  const onCardDragStart = (event: DragEvent<HTMLElement>, projected: WorkspaceBoardProjectedCard) => {
    event.dataTransfer.setData('application/x-taskwraith-workspace-board-card-id', projected.card.id)
    event.dataTransfer.effectAllowed = 'move'
    setDraggingCardId(projected.card.id)
  }

  const clearDragState = () => {
    setDraggingCardId(null)
    setDragOverColumnId(null)
    setDragOverCard(null)
  }

  const onColumnDrop = (event: DragEvent<HTMLElement>, columnId: WorkspaceBoardColumnId) => {
    event.preventDefault()
    const cardId =
      event.dataTransfer.getData('application/x-taskwraith-workspace-board-card-id') || draggingCardId
    clearDragState()
    const projected = activeProjectedCards.find((item) => item.card.id === cardId)
    if (projected) void moveCard(projected, columnId)
  }

  const onCardDragOver = (event: DragEvent<HTMLElement>, projected: WorkspaceBoardProjectedCard) => {
    if (!draggingCardId || draggingCardId === projected.card.id) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    const edge = dropEdgeFromEvent(event)
    setDragOverColumnId(projected.card.columnId)
    setDragOverCard({ cardId: projected.card.id, edge })
  }

  const onCardDrop = (event: DragEvent<HTMLElement>, target: WorkspaceBoardProjectedCard) => {
    event.preventDefault()
    event.stopPropagation()
    const cardId =
      event.dataTransfer.getData('application/x-taskwraith-workspace-board-card-id') || draggingCardId
    const edge = dragOverCard?.cardId === target.card.id ? dragOverCard.edge : dropEdgeFromEvent(event)
    clearDragState()
    const projected = activeProjectedCards.find((item) => item.card.id === cardId)
    if (projected) void moveCardRelativeToTarget(projected, target, edge)
  }

  return (
    <div className="workspace-board-pane" role="region" aria-label={`${board.name} board`}>
      <header className="workspace-board-header">
        <div>
          <p className="workspace-board-kicker">{workspace.displayName}</p>
          <h2>{board.name}</h2>
        </div>
        <div className="workspace-board-summary" aria-label="Board summary">
          <span>{activeProjectedCards.length} cards</span>
          <span>{workspaceChats.length} workspace threads</span>
          <span>{workspaceWorkflows.length} workflows</span>
        </div>
      </header>

      {(seedCandidates.length > 0 || lastArchivedCard || error) && (
        <section className="workspace-board-intake" aria-label="Workspace board intake">
          {seedCandidates.length > 0 && (
            <div className="workspace-board-intake-copy">
              <strong>{seedCandidates.length} untracked workspace item{seedCandidates.length === 1 ? '' : 's'}</strong>
              <span>
                Includes threads, workflows, scheduled tasks, and run queue jobs that already belong to this workspace.
              </span>
            </div>
          )}
          <div className="workspace-board-intake-actions">
            {seedCandidates.length > 0 && (
              <button type="button" onClick={seedBoard} disabled={isSeeding}>
                {isSeeding ? 'Creating...' : `Create ${seedCandidates.length} cards`}
              </button>
            )}
            {lastArchivedCard && (
              <button type="button" className="secondary" onClick={restoreLastArchivedCard}>
                Undo archive
              </button>
            )}
          </div>
          {error && <div className="workspace-board-error" role="alert">{error}</div>}
        </section>
      )}

      <form className="workspace-board-add-card" aria-label="Add board card" onSubmit={submitCard}>
        <label className="workspace-board-field">
          <span>Card title</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
            placeholder="Card title"
          />
        </label>
        <label className="workspace-board-field">
          <span>Note or next step</span>
          <input
            value={body}
            onChange={(event) => setBody(event.currentTarget.value)}
            placeholder="Note or next step"
          />
        </label>
        <label className="workspace-board-field">
          <span>Link</span>
          <select value={linkValue} onChange={(event) => setLinkValue(event.currentTarget.value)}>
            <option value="">No link</option>
            {linkOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label} · {option.meta}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={!title.trim() || isAdding}>
          {isAdding ? 'Adding...' : 'Add card'}
        </button>
      </form>

      <div className="workspace-board-toolbar" aria-label="Board card filters">
        <label className="workspace-board-search">
          <span>Search cards</span>
          <input
            type="search"
            value={cardSearch}
            onChange={(event) => setCardSearch(event.currentTarget.value)}
            placeholder="Search cards, links, owners"
          />
        </label>
        <button
          type="button"
          className={`workspace-board-filter-toggle ${showAttentionOnly ? 'active' : ''}`}
          aria-pressed={showAttentionOnly}
          onClick={() => setShowAttentionOnly((value) => !value)}
        >
          Needs attention
        </button>
        {isFiltered && (
          <button
            type="button"
            className="workspace-board-filter-clear"
            onClick={() => {
              setCardSearch('')
              setShowAttentionOnly(false)
            }}
          >
            Clear
          </button>
        )}
        <span className="workspace-board-visible-count">
          {filteredProjectedCards.length} shown
          {isFiltered ? ` of ${activeProjectedCards.length}` : ''}
        </span>
      </div>

      <div className="workspace-board-columns">
        {board.columns
          .filter((column) => column.id !== 'archived')
          .map((column) => {
            const columnCards = visibleCardsByColumn.get(column.id) || []
            return (
              <section
                key={column.id}
                className={`workspace-board-column ${dragOverColumnId === column.id ? 'drag-over' : ''}`}
                onDragOver={(event) => {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  setDragOverColumnId(column.id)
                }}
                onDragLeave={() => setDragOverColumnId(null)}
                onDrop={(event) => onColumnDrop(event, column.id)}
              >
                <div className="workspace-board-column-header">
                  <h3>{column.name}</h3>
                  <span>
                    {columnCards.length}
                    {column.wipLimit ? ` / ${column.wipLimit}` : ''}
                  </span>
                </div>
                <div className="workspace-board-card-stack">
                  {columnCards.length === 0 ? (
                    <div className="workspace-board-column-empty">
                      {isFiltered ? 'No matching cards' : 'No cards'}
                    </div>
                  ) : (
                    columnCards.map((projected) => {
                      const allColumnCards = activeCardsByColumn.get(projected.card.columnId) || []
                      const cardIndex = allColumnCards.findIndex((item) => item.card.id === projected.card.id)
                      const dropClass =
                        dragOverCard?.cardId === projected.card.id ? `drop-${dragOverCard.edge}` : ''
                      return (
                        <article
                          key={projected.card.id}
                          className={`workspace-board-card attention-${projected.attentionState} ${dropClass} ${
                            draggingCardId === projected.card.id ? 'dragging' : ''
                          }`}
                          draggable
                          onDragStart={(event) => onCardDragStart(event, projected)}
                          onDragOver={(event) => onCardDragOver(event, projected)}
                          onDrop={(event) => onCardDrop(event, projected)}
                          onDragLeave={(event) => {
                            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
                            if (dragOverCard?.cardId === projected.card.id) setDragOverCard(null)
                          }}
                          onDragEnd={clearDragState}
                          onDoubleClick={() => openDetails(projected)}
                        >
                          <div className="workspace-board-card-topline">
                            <span className={`workspace-board-status status-${projected.attentionState}`}>
                              {projected.derivedStatus === 'manual' ? projected.laneLabel : projected.statusLabel}
                            </span>
                            {projected.laneStatusMismatch && (
                              <span className="workspace-board-lane-pill">Lane: {projected.laneLabel}</span>
                            )}
                            {projected.card.humanOwner && (
                              <span className="workspace-board-owner">{projected.card.humanOwner}</span>
                            )}
                          </div>
                          <h4>{projected.card.title}</h4>
                          {projected.card.body && <p>{projected.card.body}</p>}
                          {projected.card.nextStep && (
                            <p className="workspace-board-card-note">Next: {projected.card.nextStep}</p>
                          )}
                          {projected.card.blockedReason && (
                            <p className="workspace-board-card-blocker">Blocked: {projected.card.blockedReason}</p>
                          )}
                          {projected.linkedTitle && (
                            <button
                              type="button"
                              className="workspace-board-link"
                              onClick={() => openDetails(projected)}
                              aria-label={`Show linked ${projected.linkedKindLabel || 'item'} details for ${projected.card.title}`}
                            >
                              <span className="workspace-board-link-title">{projected.linkedTitle}</span>
                              {projected.linkedSubtitle && <span>{projected.linkedSubtitle}</span>}
                            </button>
                          )}
                          {projected.liveStatusDetail && (
                            <div className="workspace-board-live-detail">{projected.liveStatusDetail}</div>
                          )}
                          {projected.badges.length > 0 && (
                            <div className="workspace-board-badges" aria-label="Card badges">
                              {projected.badges.map((badge) => (
                                <span
                                  key={`${projected.card.id}-${badge.label}`}
                                  className={`workspace-board-badge tone-${badge.tone}`}
                                  title={badge.title}
                                >
                                  {badge.label}
                                </span>
                              ))}
                            </div>
                          )}
                          <div className="workspace-board-card-actions">
                            <select
                              value={projected.card.columnId}
                              onChange={(event) =>
                                void moveCard(projected, event.currentTarget.value as WorkspaceBoardColumnId)
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
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => void moveCardWithinColumn(projected, -1)}
                              disabled={cardIndex <= 0}
                              aria-label={`Move ${projected.card.title} up`}
                            >
                              Up
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => void moveCardWithinColumn(projected, 1)}
                              disabled={cardIndex < 0 || cardIndex >= allColumnCards.length - 1}
                              aria-label={`Move ${projected.card.title} down`}
                            >
                              Down
                            </button>
                            <button type="button" onClick={() => openDetails(projected)}>
                              Details
                            </button>
                            {projected.card.link && (
                              <button
                                type="button"
                                onClick={() => openLinked(projected)}
                                disabled={projected.isStale}
                                aria-label={`Open linked item for ${projected.card.title}`}
                              >
                                Open
                              </button>
                            )}
                            <button type="button" className="secondary" onClick={() => void archiveCard(projected)}>
                              Archive
                            </button>
                          </div>
                        </article>
                      )
                    })
                  )}
                </div>
              </section>
            )
          })}
      </div>

      {selectedProjected && detailDraft && (
        <aside className="workspace-board-drawer" aria-label={`${selectedProjected.card.title} details`}>
          <div className="workspace-board-drawer-header">
            <div>
              <p className="workspace-board-kicker">Card Details</p>
              <h3>{selectedProjected.card.title}</h3>
            </div>
            <button
              type="button"
              className="workspace-board-drawer-close"
              onClick={() => {
                setSelectedCardId(null)
                setDetailDraft(null)
              }}
              aria-label="Close card details"
            >
              Close
            </button>
          </div>
          <div className="workspace-board-drawer-fields">
            <label className="workspace-board-field">
              <span>Title</span>
              <input
                value={detailDraft.title}
                onChange={(event) => setDetailDraft({ ...detailDraft, title: event.currentTarget.value })}
              />
            </label>
            <label className="workspace-board-field">
              <span>Body</span>
              <textarea
                value={detailDraft.body}
                onChange={(event) => setDetailDraft({ ...detailDraft, body: event.currentTarget.value })}
                rows={4}
              />
            </label>
            <label className="workspace-board-field">
              <span>Owner</span>
              <input
                value={detailDraft.humanOwner}
                onChange={(event) => setDetailDraft({ ...detailDraft, humanOwner: event.currentTarget.value })}
                placeholder="Human owner"
              />
            </label>
            <label className="workspace-board-field">
              <span>Labels</span>
              <input
                value={detailDraft.labels}
                onChange={(event) => setDetailDraft({ ...detailDraft, labels: event.currentTarget.value })}
                placeholder="review, frontend"
              />
            </label>
            <label className="workspace-board-field">
              <span>Next step</span>
              <input
                value={detailDraft.nextStep}
                onChange={(event) => setDetailDraft({ ...detailDraft, nextStep: event.currentTarget.value })}
                placeholder="Next action"
              />
            </label>
            <label className="workspace-board-field">
              <span>Blocked reason</span>
              <input
                value={detailDraft.blockedReason}
                onChange={(event) => setDetailDraft({ ...detailDraft, blockedReason: event.currentTarget.value })}
                placeholder="What is blocking this?"
              />
            </label>
            <label className="workspace-board-field">
              <span>Reminder</span>
              <input
                value={detailDraft.reminderAt}
                onChange={(event) => setDetailDraft({ ...detailDraft, reminderAt: event.currentTarget.value })}
                placeholder="ISO date or note"
              />
            </label>
          </div>
          {selectedProjected.card.link && (
            <div className="workspace-board-linked-detail">
              <strong>{selectedProjected.linkedKindLabel || selectedProjected.card.link.kind}</strong>
              <span>{selectedProjected.linkedTitle || selectedProjected.card.link.id}</span>
              {selectedProjected.staleReason && <small>{selectedProjected.staleReason}</small>}
              <div className="workspace-board-linked-actions">
                <button type="button" onClick={() => openLinked(selectedProjected)} disabled={selectedProjected.isStale}>
                  Open full item
                </button>
                <button type="button" className="secondary" onClick={unlinkSelectedCard}>
                  Unlink
                </button>
              </div>
            </div>
          )}
          <div className="workspace-board-activity">
            <strong>Activity</strong>
            {selectedProjected.card.activity.length === 0 ? (
              <span>No activity yet.</span>
            ) : (
              selectedProjected.card.activity.slice(-5).map((entry) => (
                <span key={entry.id}>
                  {entry.action} · {new Date(entry.at).toLocaleString()}
                </span>
              ))
            )}
          </div>
          <div className="workspace-board-drawer-actions">
            <button type="button" onClick={saveDetails} disabled={isSavingDetail || !detailDraft.title.trim()}>
              {isSavingDetail ? 'Saving...' : 'Save'}
            </button>
            <button type="button" className="secondary" onClick={() => void archiveCard(selectedProjected)}>
              Archive
            </button>
            <button type="button" className="danger" onClick={() => void permanentlyDeleteSelectedCard()}>
              Delete permanently
            </button>
          </div>
        </aside>
      )}
    </div>
  )
}
