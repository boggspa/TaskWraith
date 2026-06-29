import type {
  ChatRecord,
  RunQueueJob,
  ScheduledTask,
  WorkflowDefinition,
  WorkspaceBoardCard,
  WorkspaceBoardColumnId
} from '../../../main/store/types'
import type { AgentApprovalRequest } from './agentApprovalTypes'
import { ACTIVE_RUN_QUEUE_STATUSES } from './chatBusyState'

export type WorkspaceBoardDerivedStatus =
  | 'manual'
  | 'running'
  | 'needs-input'
  | 'blocked'
  | 'review-ready'
  | 'done'
  | 'stale'

export type WorkspaceBoardAttentionState =
  | 'neutral'
  | 'running'
  | 'needs-input'
  | 'blocked'
  | 'review-ready'
  | 'done'
  | 'stale'

export type WorkspaceBoardBadgeTone =
  | 'muted'
  | 'running'
  | 'warning'
  | 'danger'
  | 'success'
  | 'accent'

export interface WorkspaceBoardProjectedBadge {
  label: string
  tone: WorkspaceBoardBadgeTone
  title?: string
}

export interface WorkspaceBoardProjectedCard {
  card: WorkspaceBoardCard
  columnId: WorkspaceBoardColumnId
  laneLabel: string
  derivedStatus: WorkspaceBoardDerivedStatus
  statusLabel: string
  liveStatusDetail?: string
  attentionState: WorkspaceBoardAttentionState
  badges: WorkspaceBoardProjectedBadge[]
  linkedTitle?: string
  linkedSubtitle?: string
  linkedKindLabel?: string
  staleReason?: string
  laneStatusMismatch: boolean
  isStale: boolean
}

export interface WorkspaceBoardProjectionInput {
  cards: WorkspaceBoardCard[]
  chats: ChatRecord[]
  workflows: WorkflowDefinition[]
  scheduledTasks: ScheduledTask[]
  runQueueJobs: RunQueueJob[]
  runningChatIds?: Set<string>
  pendingApprovalsByChatId?: Record<string, AgentApprovalRequest | null>
  pendingApprovalQueueByChatId?: Record<string, AgentApprovalRequest[]>
  collaboratingChatIds?: Set<string>
}

interface WorkspaceScopedRecord {
  workspaceId?: string | null
}

const COLUMN_LABELS: Record<WorkspaceBoardColumnId, string> = {
  inbox: 'Inbox',
  ready: 'Ready',
  running: 'Running',
  'needs-input': 'Needs Input',
  blocked: 'Blocked',
  'review-ready': 'Review Ready',
  done: 'Done',
  archived: 'Archived'
}

const STATUS_LABELS: Record<WorkspaceBoardDerivedStatus, string> = {
  manual: 'Manual',
  running: 'Running',
  'needs-input': 'Needs Input',
  blocked: 'Blocked',
  'review-ready': 'Review Ready',
  done: 'Done',
  stale: 'Stale Link'
}

function latestRun(chat: ChatRecord) {
  return chat.runs && chat.runs.length > 0 ? chat.runs[chat.runs.length - 1] : null
}

function isSuccessRunStatus(status?: string): boolean {
  return status === 'success' || status === 'success_with_warnings' || status === 'completed'
}

function isRunningRunStatus(status?: string): boolean {
  return status === 'running' || status === 'sleeping'
}

function hasOpenTodos(chat: ChatRecord): number {
  let count = 0
  for (const todos of Object.values(chat.chatTodos || {})) {
    count += todos.filter((todo) => todo.status !== 'completed').length
  }
  return count
}

function pinnedMessageCount(chat: ChatRecord): number {
  return (chat.messages || []).filter((message) => Number.isFinite(message.metadata?.pinnedAt)).length
}

function pendingApprovalForChat(
  chat: ChatRecord,
  input: Pick<WorkspaceBoardProjectionInput, 'pendingApprovalsByChatId'>
): AgentApprovalRequest | null {
  return input.pendingApprovalsByChatId?.[chat.appChatId] || null
}

function queuedApprovalCountForChat(
  chat: ChatRecord,
  input: Pick<WorkspaceBoardProjectionInput, 'pendingApprovalQueueByChatId'>
): number {
  return input.pendingApprovalQueueByChatId?.[chat.appChatId]?.length || 0
}

function formatProvider(value?: string): string | undefined {
  if (!value) return undefined
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ')
}

function formatDateTime(value?: string): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return undefined
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function columnStatus(columnId: WorkspaceBoardColumnId): WorkspaceBoardDerivedStatus {
  if (columnId === 'running') return 'running'
  if (columnId === 'needs-input') return 'needs-input'
  if (columnId === 'blocked') return 'blocked'
  if (columnId === 'review-ready') return 'review-ready'
  if (columnId === 'done' || columnId === 'archived') return 'done'
  return 'manual'
}

function attentionForStatus(status: WorkspaceBoardDerivedStatus): WorkspaceBoardAttentionState {
  if (status === 'manual') return 'neutral'
  return status
}

function isCrossWorkspaceLink(card: WorkspaceBoardCard, target?: WorkspaceScopedRecord | null): boolean {
  const cardWorkspaceId = String(card.workspaceId || '').trim()
  const targetWorkspaceId = String(target?.workspaceId || '').trim()
  return Boolean(cardWorkspaceId && targetWorkspaceId && cardWorkspaceId !== targetWorkspaceId)
}

export function workspaceBoardColumnLabel(columnId: WorkspaceBoardColumnId): string {
  return COLUMN_LABELS[columnId] || columnId
}

export function workspaceBoardStatusLabel(status: WorkspaceBoardDerivedStatus): string {
  return STATUS_LABELS[status] || status
}

export function deriveWorkspaceBoardStatus(
  card: WorkspaceBoardCard,
  input: Omit<WorkspaceBoardProjectionInput, 'cards'>
): WorkspaceBoardDerivedStatus {
  if (card.archived) return 'done'
  const link = card.link
  if (!link) {
    if (card.blockedReason) return 'blocked'
    return columnStatus(card.columnId)
  }
  if (link.kind === 'chat') {
    const chat = input.chats.find((item) => item.appChatId === link.id)
    if (!chat || chat.archived || isCrossWorkspaceLink(card, chat)) return 'stale'
    if (pendingApprovalForChat(chat, input)) return 'needs-input'
    if (input.runningChatIds?.has(chat.appChatId)) return 'running'
    if (chat.activeGoal?.status === 'blocked') return 'blocked'
    const run = latestRun(chat)
    if (isRunningRunStatus(run?.status)) return 'running'
    if (run?.status === 'failed' || run?.status === 'cancelled') return 'needs-input'
    if (isSuccessRunStatus(run?.status)) return 'review-ready'
    return columnStatus(card.columnId)
  }
  if (link.kind === 'workflow') {
    const workflow = input.workflows.find((item) => item.id === link.id)
    if (!workflow || isCrossWorkspaceLink(card, workflow)) return 'stale'
    if (workflow.activeExecutionId || workflow.lastStatus === 'running' || workflow.lastStatus === 'queued') {
      return 'running'
    }
    if (workflow.lastStatus === 'failed' || workflow.failureStreak > 0) return 'needs-input'
    if (workflow.lastStatus === 'completed') return 'review-ready'
    if (workflow.lastStatus === 'cancelled') return 'needs-input'
    return columnStatus(card.columnId)
  }
  if (link.kind === 'scheduled-task') {
    const task = input.scheduledTasks.find((item) => item.id === link.id)
    if (!task || isCrossWorkspaceLink(card, task)) return 'stale'
    if (task.status === 'running' || task.status === 'due') return 'running'
    if (task.status === 'failed' || task.status === 'cancelled') return 'needs-input'
    if (task.status === 'completed') return 'done'
    return columnStatus(card.columnId)
  }
  if (link.kind === 'run-queue-job') {
    const job = input.runQueueJobs.find((item) => item.id === link.id || item.runId === link.id)
    if (!job || isCrossWorkspaceLink(card, job)) return 'stale'
    if (ACTIVE_RUN_QUEUE_STATUSES.has(job.status) || job.status === 'queued') return 'running'
    if (job.status === 'failed' || job.status === 'cancelled') return 'needs-input'
    if (job.status === 'completed') return 'done'
    return columnStatus(card.columnId)
  }
  return columnStatus(card.columnId)
}

export function buildWorkspaceBoardProjectedCards(
  input: WorkspaceBoardProjectionInput
): WorkspaceBoardProjectedCard[] {
  const chatsById = new Map(input.chats.map((chat) => [chat.appChatId, chat]))
  const workflowsById = new Map(input.workflows.map((workflow) => [workflow.id, workflow]))
  const tasksById = new Map(input.scheduledTasks.map((task) => [task.id, task]))
  const jobsById = new Map<string, RunQueueJob>()
  for (const job of input.runQueueJobs) {
    jobsById.set(job.id, job)
    jobsById.set(job.runId, job)
  }

  return input.cards.map((card) => {
    const derivedStatus = deriveWorkspaceBoardStatus(card, input)
    const link = card.link
    const linkedChat = link?.kind === 'chat' ? chatsById.get(link.id) || null : null
    const linkedWorkflow = link?.kind === 'workflow' ? workflowsById.get(link.id) || null : null
    const linkedTask = link?.kind === 'scheduled-task' ? tasksById.get(link.id) || null : null
    const linkedJob = link?.kind === 'run-queue-job' ? jobsById.get(link.id) || null : null
    const crossWorkspaceLink =
      isCrossWorkspaceLink(card, linkedChat) ||
      isCrossWorkspaceLink(card, linkedWorkflow) ||
      isCrossWorkspaceLink(card, linkedTask) ||
      isCrossWorkspaceLink(card, linkedJob)
    const chat = linkedChat && !linkedChat.archived && !crossWorkspaceLink ? linkedChat : null
    const workflow = linkedWorkflow && !crossWorkspaceLink ? linkedWorkflow : null
    const task = linkedTask && !crossWorkspaceLink ? linkedTask : null
    const job = linkedJob && !crossWorkspaceLink ? linkedJob : null
    const badges: WorkspaceBoardProjectedBadge[] = []
    let linkedKindLabel: string | undefined
    let liveStatusDetail: string | undefined
    let staleReason: string | undefined

    if (chat) {
      linkedKindLabel = 'Thread'
      const provider = formatProvider(chat.provider)
      if (provider) badges.push({ label: provider, tone: 'muted', title: 'Thread provider' })
      const pendingApproval = pendingApprovalForChat(chat, input)
      const queuedApprovalCount = queuedApprovalCountForChat(chat, input)
      if (pendingApproval) {
        badges.push({ label: 'Approval', tone: 'danger', title: pendingApproval.title })
        liveStatusDetail = `Waiting for approval: ${pendingApproval.title}`
      }
      if (queuedApprovalCount > 0) {
        badges.push({ label: `+${queuedApprovalCount} approvals`, tone: 'danger' })
      }
      if (input.collaboratingChatIds?.has(chat.appChatId)) {
        badges.push({ label: 'Shared', tone: 'accent', title: 'Shared thread' })
      }
      if (chat.pinned) badges.push({ label: 'Pinned', tone: 'muted', title: 'Pinned thread' })
      if (chat.activeGoal?.status) {
        badges.push({
          label: `Goal ${chat.activeGoal.status}`,
          tone:
            chat.activeGoal.status === 'blocked'
              ? 'danger'
              : chat.activeGoal.status === 'completed'
                ? 'success'
                : 'accent',
          title: chat.activeGoal.objective
        })
      }
      const todoCount = hasOpenTodos(chat)
      if (todoCount > 0) badges.push({ label: `${todoCount} todos`, tone: 'accent' })
      const pinCount = pinnedMessageCount(chat)
      if (pinCount > 0) badges.push({ label: `${pinCount} pins`, tone: 'muted' })
      const run = latestRun(chat)
      if (run?.status) {
        badges.push({
          label: `Run ${workspaceBoardStatusLabel(derivedStatus).toLowerCase()}`,
          tone:
            derivedStatus === 'running'
              ? 'running'
              : derivedStatus === 'needs-input'
                ? 'danger'
                : derivedStatus === 'review-ready'
                  ? 'success'
                  : 'muted',
          title: run.runId
        })
      }
      if (run?.endedAt) liveStatusDetail = `Last run ended ${formatDateTime(run.endedAt)}`
      if (pendingApproval) liveStatusDetail = `Waiting for approval: ${pendingApproval.title}`
      if (run?.warnings?.length) {
        badges.push({ label: `${run.warnings.length} warnings`, tone: 'warning' })
      }
    } else if (workflow) {
      linkedKindLabel = 'Workflow'
      const provider = formatProvider(workflow.template.provider)
      if (provider) badges.push({ label: provider, tone: 'muted', title: 'Workflow provider' })
      if (workflow.enabled === false) badges.push({ label: 'Paused', tone: 'warning' })
      if (workflow.failureStreak > 0) {
        badges.push({ label: `${workflow.failureStreak} failures`, tone: 'danger' })
      }
      if (workflow.lastRunIterationCount && workflow.lastRunIterationCount > 0) {
        badges.push({ label: `${workflow.lastRunIterationCount}x loop`, tone: 'accent' })
      }
      liveStatusDetail =
        workflow.activeExecutionId
          ? 'Execution in progress'
          : workflow.lastStatus
            ? `Last ${workflow.lastStatus}${workflow.lastRunAt ? ` at ${formatDateTime(workflow.lastRunAt)}` : ''}`
            : undefined
    } else if (task) {
      linkedKindLabel = 'Scheduled Task'
      const provider = formatProvider(task.provider)
      if (provider) badges.push({ label: provider, tone: 'muted', title: 'Scheduled provider' })
      badges.push({
        label: task.status,
        tone:
          task.status === 'failed' || task.status === 'cancelled'
            ? 'danger'
            : task.status === 'completed'
              ? 'success'
              : task.status === 'running' || task.status === 'due'
                ? 'running'
                : 'muted'
      })
      liveStatusDetail = task.lastError || `Scheduled for ${formatDateTime(task.runAt) || task.runAt}`
    } else if (job) {
      linkedKindLabel = 'Run Queue'
      const provider = formatProvider(job.provider)
      if (provider) badges.push({ label: provider, tone: 'muted', title: 'Run provider' })
      badges.push({
        label: job.status,
        tone:
          job.status === 'failed' || job.status === 'cancelled'
            ? 'danger'
            : job.status === 'completed'
              ? 'success'
              : job.status === 'active' || job.status === 'starting' || job.status === 'queued'
                ? 'running'
                : 'muted'
      })
      if (job.source) badges.push({ label: job.source, tone: 'muted', title: 'Run source' })
      liveStatusDetail = job.lastError || job.statusReason || job.resumeHint
    } else if (link) {
      linkedKindLabel = link.kind
      staleReason = crossWorkspaceLink
        ? `${link.kind} ${link.id} belongs to another workspace.`
        : `${link.kind} ${link.id} is missing or no longer belongs to this workspace.`
    }

    if (card.labels?.length) {
      for (const label of card.labels.slice(0, 4)) badges.push({ label, tone: 'accent' })
    }
    if (card.blockedReason) badges.push({ label: 'Blocked', tone: 'danger', title: card.blockedReason })
    if (card.reminderAt) badges.push({ label: 'Reminder', tone: 'warning', title: card.reminderAt })

    const manualLaneStatus = columnStatus(card.columnId)
    const laneStatusMismatch =
      derivedStatus !== 'manual' && manualLaneStatus !== 'manual' && manualLaneStatus !== derivedStatus

    return {
      card,
      columnId: card.columnId,
      laneLabel: workspaceBoardColumnLabel(card.columnId),
      derivedStatus,
      statusLabel: workspaceBoardStatusLabel(derivedStatus),
      liveStatusDetail,
      attentionState: attentionForStatus(derivedStatus),
      badges: badges.slice(0, 8),
      linkedTitle: chat?.title || workflow?.name || task?.displayPrompt || task?.prompt || job?.promptPreview,
      linkedSubtitle:
        linkedKindLabel ||
        chat?.provider ||
        workflow?.template.provider ||
        task?.provider ||
        job?.provider ||
        (link ? link.kind : undefined),
      linkedKindLabel,
      staleReason,
      laneStatusMismatch,
      isStale: derivedStatus === 'stale'
    }
  })
}
