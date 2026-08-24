export const SIDEBAR_ACTIVE_TAB_STORAGE_KEY = 'taskwraith-sidebar-active-tab'
export const LAST_ACTIVE_WORKSPACE_STORAGE_KEY = 'taskwraith-last-active-workspace-id'
export const LAST_ACTIVE_WORK_PROJECT_STORAGE_KEY = 'taskwraith-last-active-work-project-id'

export type SidebarActiveTab = 'chat' | 'threads' | 'projects' | 'terminal'

export interface StartupContextStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface ColdLaunchNewChatContext {
  activeTab: SidebarActiveTab
  workspaceId: string | null
  projectId: string | null
}

export interface ColdLaunchWorkspaceLike {
  id: string
  path: string
  lastOpenedAt?: number
}

export interface ColdLaunchProjectLike {
  id: string
  archived?: boolean
}

export interface ColdLaunchProjectProfileLike {
  projectId: string
  preferredWorkspaceId?: string
}

export interface ColdLaunchNewChatTarget<TWorkspace extends ColdLaunchWorkspaceLike> {
  surface: SidebarActiveTab
  workspace: TWorkspace | null
  projectId: string | null
}

function browserStorage(): StartupContextStorage | null {
  try {
    return typeof globalThis === 'undefined'
      ? null
      : ((globalThis as { localStorage?: StartupContextStorage }).localStorage ?? null)
  } catch {
    return null
  }
}

function readId(
  key: string,
  storage: StartupContextStorage | null = browserStorage()
): string | null {
  if (!storage) return null
  try {
    return storage.getItem(key)?.trim() || null
  } catch {
    return null
  }
}

function writeId(
  key: string,
  value: string | null,
  storage: StartupContextStorage | null = browserStorage()
): void {
  if (!storage) return
  try {
    const normalized = value?.trim() || null
    if (normalized) storage.setItem(key, normalized)
    else storage.removeItem(key)
  } catch {
    // Navigation memory is best-effort renderer chrome.
  }
}

export function readPersistedSidebarActiveTab(
  storage: StartupContextStorage | null = browserStorage()
): SidebarActiveTab | null {
  const stored = readId(SIDEBAR_ACTIVE_TAB_STORAGE_KEY, storage)
  return stored === 'chat' || stored === 'threads' || stored === 'projects' || stored === 'terminal' ? (stored as SidebarActiveTab) : null
}

export function rememberSidebarActiveTab(
  tab: SidebarActiveTab,
  storage: StartupContextStorage | null = browserStorage()
): void {
  writeId(SIDEBAR_ACTIVE_TAB_STORAGE_KEY, tab, storage)
}

export function rememberLastActiveWorkspaceId(
  workspaceId: string | null,
  storage: StartupContextStorage | null = browserStorage()
): void {
  writeId(LAST_ACTIVE_WORKSPACE_STORAGE_KEY, workspaceId, storage)
}

export function rememberLastActiveWorkProjectId(
  projectId: string | null,
  storage: StartupContextStorage | null = browserStorage()
): void {
  writeId(LAST_ACTIVE_WORK_PROJECT_STORAGE_KEY, projectId, storage)
}

export function readColdLaunchNewChatContext(
  storage: StartupContextStorage | null = browserStorage()
): ColdLaunchNewChatContext {
  return {
    activeTab: readPersistedSidebarActiveTab(storage) ?? 'chat',
    workspaceId: readId(LAST_ACTIVE_WORKSPACE_STORAGE_KEY, storage),
    projectId: readId(LAST_ACTIVE_WORK_PROJECT_STORAGE_KEY, storage)
  }
}

/**
 * Resolve the pristine draft a normal cold launch should present. Chat is
 * General. Code restores the explicit workspace id, with lastOpenedAt as a
 * compatibility fallback for installs that predate that memory. Work restores
 * a live project and uses only its explicit preferred workspace; a project
 * without one intentionally starts from General.
 */
export function resolveColdLaunchNewChatTarget<TWorkspace extends ColdLaunchWorkspaceLike>(input: {
  context: ColdLaunchNewChatContext
  workspaces: readonly TWorkspace[]
  projects: readonly ColdLaunchProjectLike[]
  projectProfiles: readonly ColdLaunchProjectProfileLike[]
}): ColdLaunchNewChatTarget<TWorkspace> {
  if (input.context.activeTab === 'threads') {
    const rememberedWorkspace = input.context.workspaceId
      ? (input.workspaces.find((workspace) => workspace.id === input.context.workspaceId) ?? null)
      : null
    const workspace =
      rememberedWorkspace ??
      input.workspaces.reduce<TWorkspace | null>((latest, candidate) => {
        if (!latest) return candidate
        return (candidate.lastOpenedAt ?? 0) > (latest.lastOpenedAt ?? 0) ? candidate : latest
      }, null)
    return workspace
      ? { surface: 'threads', workspace, projectId: null }
      : { surface: 'chat', workspace: null, projectId: null }
  }

  if (input.context.activeTab === 'projects') {
    const project = input.context.projectId
      ? (input.projects.find(
          (candidate) => candidate.id === input.context.projectId && candidate.archived !== true
        ) ?? null)
      : null
    if (!project) return { surface: 'projects', workspace: null, projectId: null }

    const preferredWorkspaceId = input.projectProfiles.find(
      (profile) => profile.projectId === project.id
    )?.preferredWorkspaceId
    const workspace = preferredWorkspaceId
      ? (input.workspaces.find((candidate) => candidate.id === preferredWorkspaceId) ?? null)
      : null
    return { surface: 'projects', workspace, projectId: project.id }
  }

  return { surface: 'chat', workspace: null, projectId: null }
}
