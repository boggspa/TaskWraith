import { agentIdenticonHash } from './agentIdenticon'
import {
  applyAddChatToProject,
  applyCreateProject,
  applyDeleteProject,
  applyMoveProject,
  applyRemoveChatFromAllProjects,
  applyRemoveChatFromProject,
  applyRenameProject,
  applyReorderProject,
  applySetProjectIconAndHue,
  cloneProject,
  migrateProjects,
  newProjectId,
  projectById,
  sortProjectsForDisplay,
  type Project,
  type ProjectInput,
  type ProjectPatch
} from '../../../shared/projects'

/**
 * Renderer-side Projects store: localStorage persistence + subscriptions over
 * the pure operations in `src/shared/projects.ts`. All record logic lives in
 * the shared module (the main-owned registry applies the identical functions);
 * this file only reads, seeds, persists, and notifies. Keep it that way — any
 * behavior added here and not in shared/ will drift the two sides apart.
 */

const STORAGE_KEY = 'taskwraith-sidebar-projects'

export const PROJECTS_STORAGE_KEY = STORAGE_KEY

export type { Project, ProjectIcon, ProjectInput } from '../../../shared/projects'

function readRawProjects(): Project[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return migrateProjects(parsed, Date.now())
  } catch {
    return []
  }
}

function writeRawProjects(projects: Project[]): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(projects))
}

const projectListeners = new Set<() => void>()
let storageBridged = false

function notifyProjectListeners(): void {
  for (const listener of [...projectListeners]) {
    try {
      listener()
    } catch {
      // Subscriber exceptions must not block the persistence path.
    }
  }
}

function ensureStorageBridge(): void {
  if (storageBridged) return
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  storageBridged = true
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== window.localStorage) return
    if (event.key !== STORAGE_KEY) return
    notifyProjectListeners()
  })
}

export function subscribeProjects(listener: () => void): () => void {
  ensureStorageBridge()
  projectListeners.add(listener)
  return () => {
    projectListeners.delete(listener)
  }
}

function persist(projects: Project[]): void {
  writeRawProjects(projects)
  notifyProjectListeners()
}

/** Persist only when the apply produced a new list (shared ops signal a no-op
 * by returning the same array reference — see shared/projects.ts). */
function persistIfChanged(previous: Project[], next: Project[]): void {
  if (next !== previous) persist(next)
}

export function listProjects(): Project[] {
  return sortProjectsForDisplay(readRawProjects().map(cloneProject))
}

export function getProject(projectId: string): Project | null {
  if (!projectId) return null
  const project = projectById(readRawProjects(), projectId)
  return project ? cloneProject(project) : null
}

export function createProject(input: ProjectInput): Project {
  const projects = readRawProjects()
  const id = newProjectId()
  const { projects: next, project } = applyCreateProject(projects, input, {
    id,
    now: Date.now(),
    defaultHue: agentIdenticonHash(id) % 360
  })
  persist(next)
  return cloneProject(project)
}

export function renameProject(projectId: string, name: string): Project {
  const projects = readRawProjects()
  const { projects: next, project } = applyRenameProject(projects, projectId, name, Date.now())
  persistIfChanged(projects, next)
  return cloneProject(project)
}

export function deleteProject(projectId: string): void {
  const projects = readRawProjects()
  persist(applyDeleteProject(projects, projectId))
}

export function reorderProject(projectId: string, order: number): Project {
  const projects = readRawProjects()
  const { projects: next, project } = applyReorderProject(projects, projectId, order, Date.now())
  persistIfChanged(projects, next)
  return cloneProject(project)
}

export function moveProject(projectId: string, parentId: string | null, order?: number): Project {
  const projects = readRawProjects()
  const { projects: next, project } = applyMoveProject(
    projects,
    projectId,
    parentId,
    order,
    Date.now()
  )
  persistIfChanged(projects, next)
  return cloneProject(project)
}

export function setProjectIconAndHue(projectId: string, patch: ProjectPatch): Project {
  const projects = readRawProjects()
  const { projects: next, project } = applySetProjectIconAndHue(
    projects,
    projectId,
    patch,
    Date.now()
  )
  persistIfChanged(projects, next)
  return cloneProject(project)
}

export function addChatToProject(projectId: string, chatId: string): Project {
  const projects = readRawProjects()
  const { projects: next, project } = applyAddChatToProject(projects, projectId, chatId, Date.now())
  persistIfChanged(projects, next)
  return cloneProject(project)
}

export function removeChatFromProject(projectId: string, chatId: string): Project {
  const projects = readRawProjects()
  const { projects: next, project } = applyRemoveChatFromProject(
    projects,
    projectId,
    chatId,
    Date.now()
  )
  persistIfChanged(projects, next)
  return cloneProject(project)
}

export function removeChatFromAllProjects(chatId: string): number {
  const projects = readRawProjects()
  const { projects: next, changedCount } = applyRemoveChatFromAllProjects(
    projects,
    chatId,
    Date.now()
  )
  if (changedCount > 0) persist(next)
  return changedCount
}
