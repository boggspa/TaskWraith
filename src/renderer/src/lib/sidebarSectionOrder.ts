export type SidebarHierarchySectionId =
  | 'active-runs'
  | 'local-servers'
  | 'workflows'
  | 'workspace-boards'
  | 'pinned'
  | 'recents'
  | 'ensembles'
  | 'workspaces'
  | 'chats'
  | 'shared'

export const SIDEBAR_HIERARCHY_SECTION_IDS: readonly SidebarHierarchySectionId[] = [
  'active-runs',
  'local-servers',
  'workflows',
  'workspace-boards',
  'pinned',
  'recents',
  'ensembles',
  'workspaces',
  'chats',
  'shared'
] as const

export const DEFAULT_SIDEBAR_HIERARCHY_ORDER: readonly SidebarHierarchySectionId[] =
  SIDEBAR_HIERARCHY_SECTION_IDS

export const SIDEBAR_HIERARCHY_SECTION_LABELS: Record<SidebarHierarchySectionId, string> = {
  'active-runs': 'Active runs',
  'local-servers': 'Local servers',
  workflows: 'Workflows',
  'workspace-boards': 'Workspace Boards',
  pinned: 'Pinned',
  recents: 'Recents',
  ensembles: 'Ensembles',
  workspaces: 'Workspaces',
  chats: 'Chats',
  shared: 'Shared'
}

const STORAGE_KEY = 'taskwraith-sidebar-hierarchy-order'
const STORAGE_VERSION_KEY = 'taskwraith-sidebar-hierarchy-order-version'
const STORAGE_VERSION = 'hierarchy-v1'

export function normalizeSidebarHierarchyOrder(
  input: unknown
): SidebarHierarchySectionId[] {
  if (!Array.isArray(input)) {
    return [...DEFAULT_SIDEBAR_HIERARCHY_ORDER]
  }
  const seen = new Set<SidebarHierarchySectionId>()
  const next: SidebarHierarchySectionId[] = []
  for (const value of input) {
    if (
      typeof value === 'string' &&
      SIDEBAR_HIERARCHY_SECTION_IDS.includes(value as SidebarHierarchySectionId) &&
      !seen.has(value as SidebarHierarchySectionId)
    ) {
      const id = value as SidebarHierarchySectionId
      seen.add(id)
      next.push(id)
    }
  }
  for (const id of SIDEBAR_HIERARCHY_SECTION_IDS) {
    if (!seen.has(id)) next.push(id)
  }
  return next
}

export function loadSidebarHierarchyOrder(): SidebarHierarchySectionId[] {
  if (typeof window === 'undefined') {
    return [...DEFAULT_SIDEBAR_HIERARCHY_ORDER]
  }
  try {
    const version = window.localStorage.getItem(STORAGE_VERSION_KEY)
    if (version !== STORAGE_VERSION) {
      return [...DEFAULT_SIDEBAR_HIERARCHY_ORDER]
    }
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return [...DEFAULT_SIDEBAR_HIERARCHY_ORDER]
    return normalizeSidebarHierarchyOrder(JSON.parse(raw))
  } catch {
    return [...DEFAULT_SIDEBAR_HIERARCHY_ORDER]
  }
}

export function saveSidebarHierarchyOrder(order: SidebarHierarchySectionId[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_VERSION_KEY, STORAGE_VERSION)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(order))
  } catch {
    // Ignore quota / private-mode failures.
  }
}
