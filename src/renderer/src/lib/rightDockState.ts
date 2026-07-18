export type RightDockTab =
  | 'home'
  | 'run'
  | 'chat'
  | 'inspector'
  | 'files'
  | 'media'
  | 'references'
  | 'pins'
  | 'terminal'

export interface RightDockTabAvailabilityInput {
  showHome?: boolean
  showCockpit: boolean
  hasSideChat: boolean
  isSideChatDockPanelOpen: boolean
  showInspector: boolean
  showFileEditor: boolean
  hasWorkspaceContext: boolean
  isChatMediaPanelOpen: boolean
  isProjectReferencesPanelOpen: boolean
  isPinnedMessagesPanelOpen: boolean
  isTerminalDockAvailable: boolean
}

export interface RightDockTabDescriptor {
  id: RightDockTab
  label: string
}

export const RIGHT_DOCK_PANEL_IDS: readonly RightDockTab[] = [
  'home',
  'chat',
  'run',
  'media',
  'references',
  'pins',
  'files',
  'inspector',
  'terminal'
]

export function buildRightDockTabs(input: RightDockTabAvailabilityInput): RightDockTabDescriptor[] {
  return [
    { id: 'home' as const, label: 'Home', available: input.showHome },
    { id: 'run' as const, label: 'Run', available: input.showCockpit },
    {
      id: 'chat' as const,
      label: 'Chat',
      available: input.hasSideChat && input.isSideChatDockPanelOpen
    },
    { id: 'inspector' as const, label: 'Inspect', available: input.showInspector },
    {
      id: 'files' as const,
      label: 'Files',
      available: input.showFileEditor && input.hasWorkspaceContext
    },
    { id: 'media' as const, label: 'Media', available: input.isChatMediaPanelOpen },
    {
      id: 'references' as const,
      label: 'Refs',
      available: input.isProjectReferencesPanelOpen
    },
    { id: 'pins' as const, label: 'Notes', available: input.isPinnedMessagesPanelOpen },
    { id: 'terminal' as const, label: 'Term', available: input.isTerminalDockAvailable }
  ]
    .filter((tab) => tab.available)
    .map(({ id, label }) => ({ id, label }))
}

export function shouldShowRightDock(input: {
  isChatPopoutWindow: boolean
  showSettings: boolean
  availableTabCount: number
}): boolean {
  return !input.isChatPopoutWindow && !input.showSettings && input.availableTabCount > 0
}

export function resolveActiveRightDockTab(
  availableTabs: readonly Pick<RightDockTabDescriptor, 'id'>[],
  selectedTab: RightDockTab
): RightDockTab {
  return availableTabs.some((tab) => tab.id === selectedTab)
    ? selectedTab
    : availableTabs[0]?.id || 'run'
}

export interface RightDockRestoreDecision {
  tab: RightDockTab
  shouldOpen: boolean
}

/**
 * Restores a chat's remembered destination without treating that destination
 * as persisted visibility. A closed dock stays closed; an already-open dock
 * may switch surfaces as the user moves between chats in the same session.
 */
export function resolveRightDockRestore(input: {
  savedTab: RightDockTab | null
  selectedTab: RightDockTab
  enabledTabs: readonly RightDockTab[]
  dockIsOpen: boolean
}): RightDockRestoreDecision | null {
  const { savedTab, selectedTab, enabledTabs, dockIsOpen } = input
  if (!savedTab || savedTab === selectedTab || !enabledTabs.includes(savedTab)) {
    return null
  }
  return { tab: savedTab, shouldOpen: dockIsOpen }
}
