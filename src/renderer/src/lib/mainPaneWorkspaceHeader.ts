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

export function resolvePaneWorkspace<TWorkspace extends PaneWorkspaceRecord>(input: {
  chat?: PaneWorkspaceChatIdentity | null
  isGlobalChat: boolean
  workspaces: readonly TWorkspace[]
  currentWorkspace?: TWorkspace | null
}): TWorkspace | null {
  if (input.chat && input.isGlobalChat) return null
  if (!input.chat) return input.currentWorkspace || null
  return (
    input.workspaces.find((candidate) => workspaceMatchesChat(candidate, input.chat!)) ||
    (input.currentWorkspace && workspaceMatchesChat(input.currentWorkspace, input.chat)
      ? input.currentWorkspace
      : null)
  )
}

export function resolvePaneWorkspacePath(input: {
  chat?: PaneWorkspaceChatIdentity | null
  isGlobalChat: boolean
  workspaces: readonly PaneWorkspaceRecord[]
  currentWorkspace?: PaneWorkspaceRecord | null
}): string | null {
  const workspace = resolvePaneWorkspace(input)
  return workspace?.path || (input.isGlobalChat ? null : input.chat?.workspacePath || null)
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

  const workspace = resolvePaneWorkspace(input)
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
