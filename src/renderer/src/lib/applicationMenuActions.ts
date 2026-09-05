import type { ApplicationMenuCommand } from '../../../shared/applicationMenu'

export interface ApplicationMenuActions {
  activeTab: 'chat' | 'threads' | 'projects' | 'terminal'
  workspace: { id: string; path: string } | null
  newWorkspaceChat: (id: string, path: string) => unknown
  newGlobalChat: () => unknown
  newTerminal: (workspacePath?: string) => unknown
  openFolder: () => unknown
  openGeneralSettings: () => unknown
  showApp: () => void
}

export function runApplicationMenuCommand(
  command: ApplicationMenuCommand,
  actions: ApplicationMenuActions
): unknown {
  if (command === 'settings') return actions.openGeneralSettings()
  actions.showApp()
  if (command === 'open-folder') return actions.openFolder()
  if (actions.activeTab === 'terminal') return actions.newTerminal(actions.workspace?.path)
  if (actions.activeTab === 'projects' || actions.activeTab === 'threads') {
    return actions.workspace
      ? actions.newWorkspaceChat(actions.workspace.id, actions.workspace.path)
      : actions.openFolder()
  }
  return actions.newGlobalChat()
}
