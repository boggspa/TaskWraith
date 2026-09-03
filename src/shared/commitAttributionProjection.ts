import type { ChatMessage, ChatRecord, ToolActivity } from '../main/store/types'
import { resolveCatalogToolName } from './canonicalToolCoalesce'

/**
 * Which kind of commit receipt a tool activity can carry, or `null` when it
 * cannot carry one at all.
 *
 * This is the single definition shared by the renderer's close-out harvesting
 * and the main-side projection below. Keeping one copy is load-bearing: the
 * projection drops every activity this returns `null` for, so a main-side
 * copy that drifted stricter than the renderer's would silently delete
 * evidence the renderer was still looking for.
 */
export function commitAttributionActivityKind(
  activity: ToolActivity
): 'dedicated' | 'shell' | null {
  const catalogTool = resolveCatalogToolName(activity.toolName || '')
  if (catalogTool === 'git_commit') return 'dedicated'
  if (catalogTool === 'run_shell_command' || activity.category?.toLowerCase() === 'shell') {
    return 'shell'
  }
  const text = `${activity.toolName || ''} ${activity.displayName || ''}`.toLowerCase()
  return text.includes('git_commit') || text.includes('git commit') ? 'dedicated' : null
}

/** A message can only produce a commit attribution through one of these two. */
function messageCarriesCommitEvidence(message: ChatMessage): boolean {
  if ((message.metadata?.closeoutCommits || []).length > 0) return true
  return (message.toolActivities || []).some(
    (activity) => commitAttributionActivityKind(activity) !== null
  )
}

function projectMessage(message: ChatMessage): ChatMessage {
  const activities = message.toolActivities || []
  const kept = activities.filter((activity) => commitAttributionActivityKind(activity) !== null)
  if (kept.length === activities.length) return message
  return { ...message, toolActivities: kept }
}

/**
 * Reduce one chat to the part the Commits inspector's attribution column can
 * actually read, or `null` when it holds no commit evidence at all.
 *
 * The record keeps its shape — callers still receive a `ChatRecord`, so the
 * renderer's collector runs unchanged — but the transcript is filtered down to
 * messages carrying a commit receipt, and those messages keep only their
 * commit-bearing tool activities. The transcript is ~95% of a chat record by
 * bytes and a workspace's worth of it was previously serialized across IPC to
 * build a map of a few hundred commit hashes.
 *
 * Every other field is preserved verbatim, because the collector reads several
 * of them to resolve a seat: `ensemble.participants` for the roster, and
 * `runs` / `fanoutWorktreeCandidates` / `threadWorktreeBinding` /
 * `workspacePath` to decide whether a shell commit landed in this workspace.
 */
export function projectChatForCommitAttribution(chat: ChatRecord): ChatRecord | null {
  const messages = (chat.messages || []).filter(messageCarriesCommitEvidence)
  if (messages.length === 0) return null
  return { ...chat, messages: messages.map(projectMessage) }
}
