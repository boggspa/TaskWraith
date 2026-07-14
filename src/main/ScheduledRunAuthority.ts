import type { ChatRecord, ScheduledTask, ScheduledTaskKind } from './store/types'

export interface ScheduledRunAuthorityInput {
  task: ScheduledTask | null | undefined
  chat: ChatRecord | null | undefined
  expectedKind: ScheduledTaskKind
  appRunId?: string
  canonicalizePath: (value: string) => string
}

export interface RunAgentScheduledAuthorityInput extends Omit<
  ScheduledRunAuthorityInput,
  'expectedKind'
> {
  scheduledTaskId: unknown
  isMainRenderer: boolean
  alreadyBound?: boolean
}

const AUTHORITY_ERROR =
  'Scheduled occurrence does not match this chat, workspace, run, or dispatch mode.'

/**
 * Validate the durable, main-owned scheduled occurrence before its id may lift
 * the unattended posture. A renderer-supplied task id is routing data, never a
 * capability: only the exact occurrence already transitioned to `running` for
 * this chat/workspace/run may be honored.
 */
export function assertScheduledRunAuthority(input: ScheduledRunAuthorityInput): ScheduledTask {
  const { task, chat } = input
  if (!task || !chat || chat.scope === 'global') throw new Error(AUTHORITY_ERROR)

  const actualKind: ScheduledTaskKind = task.kind === 'ensemble' ? 'ensemble' : 'single'
  const chatKind: ScheduledTaskKind = chat.chatKind === 'ensemble' ? 'ensemble' : 'single'
  const taskRunId = task.runId?.trim()
  const requestedRunId = input.appRunId?.trim()
  if (
    task.status !== 'running' ||
    !taskRunId ||
    actualKind !== input.expectedKind ||
    chatKind !== input.expectedKind ||
    (input.expectedKind === 'ensemble' && !task.ensembleSnapshot) ||
    task.chatId !== chat.appChatId ||
    !task.workspaceId ||
    !chat.workspaceId ||
    task.workspaceId !== chat.workspaceId ||
    !task.workspacePath?.trim() ||
    !chat.workspacePath?.trim() ||
    (requestedRunId !== undefined && requestedRunId !== taskRunId)
  ) {
    throw new Error(AUTHORITY_ERROR)
  }

  let taskWorkspace: string
  let chatWorkspace: string
  try {
    taskWorkspace = input.canonicalizePath(task.workspacePath)
    chatWorkspace = input.canonicalizePath(chat.workspacePath)
  } catch {
    throw new Error(AUTHORITY_ERROR)
  }
  if (taskWorkspace !== chatWorkspace) throw new Error(AUTHORITY_ERROR)
  return task
}

/**
 * Bind the renderer's final `run-agent` handoff to the same durable occurrence
 * that was accepted at compose time. Secondary renderers may never dispatch a
 * scheduled occurrence, and the main renderer must present the exact task/run
 * pair once (callers supply `alreadyBound` from their live dispatch registry).
 */
export function assertRunAgentScheduledAuthority(
  input: RunAgentScheduledAuthorityInput
): ScheduledTask | undefined {
  if (input.scheduledTaskId === undefined) return undefined
  if (!input.isMainRenderer || input.alreadyBound) throw new Error(AUTHORITY_ERROR)

  const scheduledTaskId =
    typeof input.scheduledTaskId === 'string' ? input.scheduledTaskId.trim() : ''
  const appRunId = input.appRunId?.trim()
  if (!scheduledTaskId || !appRunId || input.task?.id !== scheduledTaskId) {
    throw new Error(AUTHORITY_ERROR)
  }

  return assertScheduledRunAuthority({
    task: input.task,
    chat: input.chat,
    expectedKind: 'single',
    appRunId,
    canonicalizePath: input.canonicalizePath
  })
}
