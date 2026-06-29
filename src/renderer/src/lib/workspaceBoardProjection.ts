import type {
  ChatRecord,
  RunQueueJob,
  ScheduledTask,
  WorkflowDefinition,
  WorkspaceBoardCard,
  WorkspaceBoardColumnId
} from '../../../main/store/types'

export type WorkspaceBoardDerivedStatus =
  | 'manual'
  | 'running'
  | 'needs-input'
  | 'blocked'
  | 'review-ready'
  | 'done'
  | 'stale'

export interface WorkspaceBoardProjectedCard {
  card: WorkspaceBoardCard
  columnId: WorkspaceBoardColumnId
  derivedStatus: WorkspaceBoardDerivedStatus
  linkedTitle?: string
  linkedSubtitle?: string
  isStale: boolean
}

export interface WorkspaceBoardProjectionInput {
  cards: WorkspaceBoardCard[]
  chats: ChatRecord[]
  workflows: WorkflowDefinition[]
  scheduledTasks: ScheduledTask[]
  runQueueJobs: RunQueueJob[]
  runningChatIds?: Set<string>
}

function latestRun(chat: ChatRecord) {
  return chat.runs && chat.runs.length > 0 ? chat.runs[chat.runs.length - 1] : null
}

export function deriveWorkspaceBoardStatus(
  card: WorkspaceBoardCard,
  input: Omit<WorkspaceBoardProjectionInput, 'cards'>
): WorkspaceBoardDerivedStatus {
  const link = card.link
  if (!link) {
    if (card.columnId === 'blocked') return 'blocked'
    if (card.columnId === 'review-ready') return 'review-ready'
    if (card.columnId === 'done' || card.columnId === 'archived') return 'done'
    return 'manual'
  }
  if (link.kind === 'chat') {
    const chat = input.chats.find((item) => item.appChatId === link.id)
    if (!chat || chat.archived) return 'stale'
    if (input.runningChatIds?.has(chat.appChatId)) return 'running'
    if (chat.activeGoal?.status === 'blocked') return 'blocked'
    const run = latestRun(chat)
    if (run?.status === 'running') return 'running'
    if (run?.status === 'failed' || run?.status === 'cancelled') return 'needs-input'
    if (run?.status === 'completed') return 'review-ready'
    return 'manual'
  }
  if (link.kind === 'workflow') {
    const workflow = input.workflows.find((item) => item.id === link.id)
    if (!workflow) return 'stale'
    if (workflow.activeExecutionId) return 'running'
    if (workflow.lastStatus === 'failed' || workflow.failureStreak > 0) return 'needs-input'
    if (workflow.lastStatus === 'completed') return 'review-ready'
    return 'manual'
  }
  if (link.kind === 'scheduled-task') {
    const task = input.scheduledTasks.find((item) => item.id === link.id)
    if (!task) return 'stale'
    if (task.status === 'running' || task.status === 'due') return 'running'
    if (task.status === 'failed' || task.status === 'cancelled') return 'needs-input'
    if (task.status === 'completed') return 'done'
    return 'manual'
  }
  if (link.kind === 'run-queue-job') {
    const job = input.runQueueJobs.find((item) => item.id === link.id || item.runId === link.id)
    if (!job) return 'stale'
    if (job.status === 'active' || job.status === 'starting' || job.status === 'steer_promoting') {
      return 'running'
    }
    if (job.status === 'failed' || job.status === 'cancelled') return 'needs-input'
    if (job.status === 'completed') return 'done'
  }
  return 'manual'
}

export function buildWorkspaceBoardProjectedCards(
  input: WorkspaceBoardProjectionInput
): WorkspaceBoardProjectedCard[] {
  return input.cards.map((card) => {
    const derivedStatus = deriveWorkspaceBoardStatus(card, input)
    const link = card.link
    const chat = link?.kind === 'chat' ? input.chats.find((item) => item.appChatId === link.id) : null
    const workflow =
      link?.kind === 'workflow' ? input.workflows.find((item) => item.id === link.id) : null
    const task =
      link?.kind === 'scheduled-task'
        ? input.scheduledTasks.find((item) => item.id === link.id)
        : null
    const job =
      link?.kind === 'run-queue-job'
        ? input.runQueueJobs.find((item) => item.id === link.id || item.runId === link.id)
        : null
    return {
      card,
      columnId: card.columnId,
      derivedStatus,
      linkedTitle: chat?.title || workflow?.name || task?.displayPrompt || job?.promptPreview,
      linkedSubtitle:
        chat?.provider ||
        workflow?.template.provider ||
        task?.provider ||
        job?.provider ||
        (link ? link.kind : undefined),
      isStale: derivedStatus === 'stale'
    }
  })
}
