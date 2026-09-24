export interface UpdateRestartActiveWorkInput {
  activeThreadCount: number
  scheduledTasks: ReadonlyArray<{ status: string }>
  workflows: ReadonlyArray<{ activeExecutionId?: string | null }>
}

/**
 * Names the live TaskWraith work an update restart should wait for, or returns
 * null when nothing is running. The text is shown to the user while the
 * restart is queued, so it says what is blocking rather than only that
 * something is.
 */
export function describeUpdateRestartActiveWork(
  input: UpdateRestartActiveWorkInput
): string | null {
  const parts: string[] = []
  const threads = Number.isFinite(input.activeThreadCount)
    ? Math.max(0, Math.floor(input.activeThreadCount))
    : 0
  if (threads > 0) parts.push(count(threads, 'active agent run', 'active agent runs'))
  const scheduled = input.scheduledTasks.filter(
    (task) => task.status === 'due' || task.status === 'running'
  ).length
  if (scheduled > 0) {
    parts.push(count(scheduled, 'scheduled task due or running', 'scheduled tasks due or running'))
  }
  const workflows = input.workflows.filter((workflow) => Boolean(workflow.activeExecutionId)).length
  if (workflows > 0) {
    parts.push(count(workflows, 'workflow still executing', 'workflows still executing'))
  }
  if (parts.length === 0) return null
  return `Waiting for ${parts.join(', ')}`
}

function count(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`
}
