import { resolveWorkspaceDisplayName } from '../../../shared/workspaceDisplayName'

export interface PaneWorkspaceChatIdentity {
  workspaceId?: string | null
  workspacePath?: string | null
}

export interface PaneWorkspaceRecord {
  id: string
  path: string
  displayName: string
  remoteOriginUrl?: string | null
}

function normalizePath(value: string | null | undefined): string {
  return String(value || '').trim().replace(/[\\/]+$/g, '')
}

function workspaceMatchesChat(
  workspace: PaneWorkspaceRecord,
  chat: PaneWorkspaceChatIdentity
): boolean {
  if (chat.workspaceId && workspace.id === chat.workspaceId) return true
  const chatPath = normalizePath(chat.workspacePath)
  return Boolean(chatPath && normalizePath(workspace.path) === chatPath)
}

export function resolveMainPaneWorkspaceLabel(input: {
  chat?: PaneWorkspaceChatIdentity | null
  isGlobalChat: boolean
  workspaces: readonly PaneWorkspaceRecord[]
  currentWorkspace?: PaneWorkspaceRecord | null
  snapshotRepoRoot?: string | null
  snapshotRemoteUrl?: string | null
}): string | null {
  if (input.chat && input.isGlobalChat) return null

  const currentMatchesChat = Boolean(
    input.chat &&
      input.currentWorkspace &&
      workspaceMatchesChat(input.currentWorkspace, input.chat)
  )
  const workspace = input.chat
    ? input.workspaces.find((candidate) => workspaceMatchesChat(candidate, input.chat!)) ||
      (currentMatchesChat ? input.currentWorkspace || null : null)
    : input.currentWorkspace || null
  const path = workspace?.path || input.chat?.workspacePath || ''
  if (!workspace && !path) return null

  // Composer git snapshots settle independently from pane focus. A snapshot
  // from the previously focused workspace must never rename this chat's header;
  // the matched workspace record already owns any safe remote-origin label.
  return resolveWorkspaceDisplayName({
    displayName: workspace?.displayName,
    path,
    remoteUrl: workspace?.remoteOriginUrl
  })
}
