import type { ChatMessage } from '../../../main/store/types'
import { mergeCodexReviewTelemetry, type CodexReviewTelemetry } from '../../../shared/codexReview'

/**
 * Merge a Codex review telemetry patch onto the synthesized `codex_review`
 * anchor activity, found by its tool_use id ANYWHERE in the message list (the
 * review's own tool items stream between the anchor and its completion, so the
 * anchor is usually not the trailing tool row).
 *
 * Pure and reference-stable: returns the SAME array when no activity matched, so
 * the caller's render-dedup (messagesRenderEqual) doesn't fire on a no-op.
 */
export function mergeReviewTelemetryIntoMessages(
  messages: ChatMessage[],
  toolUseId: string,
  telemetry: Partial<CodexReviewTelemetry> | null | undefined
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
        reviewSummary: mergeCodexReviewTelemetry(activity.reviewSummary, telemetry)
      }
    })
    if (!messageChanged) return message
    changed = true
    return { ...message, toolActivities: nextActivities }
  })
  return changed ? next : messages
}
