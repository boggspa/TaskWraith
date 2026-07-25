// Sidebar "Git" section grouping — pure, SSR-testable.
//
// Buckets chats carrying a persisted git-workflow marker
// (src/shared/chatGitWorkflow.ts) under the section's subheaders:
// PRs (draft / open / CI-failed), Pushed, Merged, Closed. The section is an
// ADDITIONAL reference surface: the same chats keep rendering in Pinned /
// Recents / Workspaces / Chats / Shared exactly as before (dual-surfacing is
// the sidebar norm), so callers must feed the UNfiltered visible-chat list —
// in particular, `hiddenFromMainList` chats belong here even though the main
// sections drop them.

import {
  CHAT_GIT_WORKFLOW_GROUP_LABELS,
  CHAT_GIT_WORKFLOW_GROUP_ORDER,
  chatGitWorkflowGroup,
  isChatGitWorkflowState,
  type ChatGitWorkflowGroup,
  type ChatGitWorkflowSnapshot
} from '../../../shared/chatGitWorkflow'

export interface GitWorkflowChatLike {
  gitWorkflow?: ChatGitWorkflowSnapshot
}

/** The chat's decoded marker, or null when absent/malformed. */
export function chatGitWorkflowMarker<T extends GitWorkflowChatLike>(
  chat: T
): ChatGitWorkflowSnapshot | null {
  const marker = chat.gitWorkflow
  return marker && isChatGitWorkflowState(marker.state) ? marker : null
}

export interface GitWorkflowSectionGroup<T extends GitWorkflowChatLike> {
  group: ChatGitWorkflowGroup
  label: string
  chats: T[]
}

/**
 * Bucket marker-carrying chats under the Git section subheaders, newest
 * marker first within each group. Chats without a valid marker are dropped.
 * Empty groups are omitted so the section renders only live subheaders.
 */
export function groupChatsByGitWorkflow<T extends GitWorkflowChatLike>(
  chats: T[]
): Array<GitWorkflowSectionGroup<T>> {
  const buckets = new Map<ChatGitWorkflowGroup, Array<{ chat: T; updatedAt: number }>>()
  for (const chat of chats) {
    const marker = chatGitWorkflowMarker(chat)
    if (!marker) continue
    const group = chatGitWorkflowGroup(marker.state)
    const bucket = buckets.get(group) || []
    bucket.push({ chat, updatedAt: marker.updatedAt })
    buckets.set(group, bucket)
  }
  const groups: Array<GitWorkflowSectionGroup<T>> = []
  for (const group of CHAT_GIT_WORKFLOW_GROUP_ORDER) {
    const bucket = buckets.get(group)
    if (!bucket || bucket.length === 0) continue
    bucket.sort((left, right) => right.updatedAt - left.updatedAt)
    groups.push({
      group,
      label: CHAT_GIT_WORKFLOW_GROUP_LABELS[group],
      chats: bucket.map((entry) => entry.chat)
    })
  }
  return groups
}
