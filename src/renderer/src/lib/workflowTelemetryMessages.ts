import type { ChatMessage } from '../../../main/store/types'
import {
  mergeClaudeWorkflowTelemetry,
  type ClaudeWorkflowTelemetry
} from '../../../shared/claudeWorkflow'

/**
 * Merge a Claude Workflow telemetry patch onto the originating `Workflow` tool
 * activity, found by its tool_use id ANYWHERE in the message list.
 *
 * A workflow runs in the background, so its `task_progress`/`task_notification`
 * frames arrive interleaved with (or long after) other tool calls — the target
 * activity is usually NOT the trailing tool row. So we search every message
 * rather than relying on the trailing-message tool reducer.
 *
 * Pure and reference-stable: returns the SAME array when no activity matched, so
 * the caller's render-dedup (messagesRenderEqual) doesn't fire on a no-op.
 */
export function mergeWorkflowTelemetryIntoMessages(
  messages: ChatMessage[],
  toolUseId: string,
  telemetry: Partial<ClaudeWorkflowTelemetry> | null | undefined
): ChatMessage[] {
  if (!toolUseId || !telemetry) return messages
  let changed = false
  const next = messages.map((message) => {
    const activities = message.toolActivities
    if (!activities || activities.length === 0) return message
    let messageChanged = false
    const nextActivities = activities.map((activity) => {
      if (activity.id !== toolUseId) return activity
      messageChanged = true
      return {
        ...activity,
        workflowSummary: mergeClaudeWorkflowTelemetry(activity.workflowSummary, telemetry)
      }
    })
    if (!messageChanged) return message
    changed = true
    return { ...message, toolActivities: nextActivities }
  })
  return changed ? next : messages
}
