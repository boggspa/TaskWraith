import { agentIdenticonHash } from './agentIdenticon'

const STORAGE_KEY = 'taskwraith-sidebar-projects'
const PROJECT_ID_PREFIX = 'project-'
const SCHEMA_VERSION = 1

export const PROJECTS_STORAGE_KEY = STORAGE_KEY

const DEFAULT_PROJECT_ICON_KIND = 'seed'

export type ProjectIcon = {
  iconKind: 'named' | 'seed' | 'asset'
  slug?: string
  seed?: string
  assetKey?: string
  accent?: string
}

export type Project = {
  schemaVersion: number
  id: string
  name: string
  icon: ProjectIcon
  hue: number
  parentId: string | null
  order: number
  memberChatIds: string[]
  createdAt: number
  updatedAt: number
}

export type ProjectInput = {
  name: string
  parentId?: string | null
  order?: number
  icon?: ProjectIcon
  hue?: number
  memberChatIds?: string[]
}

type ProjectPatch = {
  icon?: ProjectIcon
  hue?: number
}

function newProjectId(): string {
  const uuid =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `${PROJECT_ID_PREFIX}${uuid}`
}

function normalizeHue(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) return 0
  return ((Math.round(value) % 360) + 360) % 360
}

function normalizeParentId(parentId: unknown): string | null {
  if (parentId === null) return null
  if (typeof parentId === 'string' && parentId.trim().length > 0) return parentId.trim()
  return null
}

function normalizeIcon(icon?: ProjectIcon, seed = ''): ProjectIcon {
  if (!icon || typeof icon !== 'object') {
    return { iconKind: DEFAULT_PROJECT_ICON_KIND, seed }
  }
  if (icon.iconKind !== 'named' && icon.iconKind !== 'seed' && icon.iconKind !== 'asset') {
    return { iconKind: DEFAULT_PROJECT_ICON_KIND, seed }
  }
  return {
    iconKind: icon.iconKind,
    ...(icon.slug ? { slug: icon.slug } : {}),
    ...(icon.seed ? { seed: icon.seed } : {}),
    ...(icon.assetKey ? { assetKey: icon.assetKey } : {}),
    ...(icon.accent ? { accent: icon.accent } : {})
  }
}

function normalizeChatIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed) continue
    seen.add(trimmed)
  }
  return [...seen]
}

function cloneIcon(icon: ProjectIcon): ProjectIcon {
  return {
    iconKind: icon.iconKind,
    ...(icon.slug ? { slug: icon.slug } : {}),
    ...(icon.seed ? { seed: icon.seed } : {}),
    ...(icon.assetKey ? { assetKey: icon.assetKey } : {}),
    ...(icon.accent ? { accent: icon.accent } : {})
  }
}

function cloneProject(project: Project): Project {
  return {
    ...project,
    icon: cloneIcon(project.icon),
    memberChatIds: [...project.memberChatIds]
  }
}

function isProjectIcon(value: unknown): value is ProjectIcon {
  if (!value || typeof value !== 'object') return false
  const candidate = value as ProjectIcon
  return (
    (candidate.iconKind === 'named' || candidate.iconKind === 'seed' || candidate.iconKind === 'asset') &&
    (typeof candidate.slug === 'undefined' || typeof candidate.slug === 'string') &&
    (typeof candidate.seed === 'undefined' || typeof candidate.seed === 'string') &&
    (typeof candidate.assetKey === 'undefined' || typeof candidate.assetKey === 'string') &&
    (typeof candidate.accent === 'undefined' || typeof candidate.accent === 'string')
  )
}

function isProject(value: unknown): value is Project {
  if (!value || typeof value !== 'object') return false
  const entry = value as Project
  return (
    typeof entry.id === 'string' &&
    entry.id.length > 0 &&
    entry.schemaVersion === SCHEMA_VERSION &&
    typeof entry.name === 'string' &&
    entry.name.trim().length > 0 &&
    isProjectIcon(entry.icon) &&
    typeof entry.hue === 'number' &&
    Number.isFinite(entry.hue) &&
    (entry.parentId === null || typeof entry.parentId === 'string') &&
    typeof entry.order === 'number' &&
    Number.isFinite(entry.order) &&
    Array.isArray(entry.memberChatIds) &&
    entry.memberChatIds.every((id) => typeof id === 'string') &&
    typeof entry.createdAt === 'number' &&
    Number.isFinite(entry.createdAt) &&
    typeof entry.updatedAt === 'number' &&
    Number.isFinite(entry.updatedAt)
  )
}

function migrateProject(value: unknown): Project | null {
  if (!value || typeof value !== 'object') return null
  const entry = value as Partial<Project>
  if (typeof entry.id !== 'string' || entry.id.length === 0) return null
  if (typeof entry.name !== 'string' || entry.name.trim().length === 0) return null
  const createdAt =
    typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt)
      ? entry.createdAt
      : Date.now()
  const updatedAt =
    typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
      ? entry.updatedAt
      : createdAt
  return {
    schemaVersion: SCHEMA_VERSION,
    id: entry.id,
    name: entry.name.trim(),
    icon: normalizeIcon(isProjectIcon(entry.icon) ? entry.icon : undefined, entry.id),
    hue: normalizeHue(entry.hue),
    parentId: normalizeParentId(entry.parentId),
    order: Math.max(
      1,
      Math.round(
        typeof entry.order === 'number' && Number.isFinite(entry.order) ? entry.order : 1
      )
    ),
    memberChatIds: normalizeChatIds(entry.memberChatIds),
    createdAt,
    updatedAt
  }
}

function migrateProjects(candidates: unknown[]): Project[] {
  const seen = new Set<string>()
  const projects: Project[] = []
  for (const candidate of candidates) {
    const migrated = migrateProject(candidate)
    if (!isProject(migrated) || seen.has(migrated.id)) continue
    seen.add(migrated.id)
    projects.push({
      ...migrated,
      icon: cloneIcon(migrated.icon)
    })
  }
  return projects
}

function readRawProjects(): Project[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return migrateProjects(parsed)
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

function projectById(projects: Project[], id: string): Project | null {
  return projects.find((project) => project.id === id) ?? null
}

function assertProjectExists(projects: Project[], projectId: string): Project {
  const project = projectById(projects, projectId)
  if (!project) {
    throw new Error('Project not found.')
  }
  return project
}

function isValidParent(projects: Project[], parentId: string | null): boolean {
  if (parentId === null) return true
  return projectById(projects, parentId) !== null
}

function wouldCreateCycle(projects: Project[], projectId: string, parentId: string | null): boolean {
  if (parentId === null) return false
  const seen = new Set<string>()
  let current: string | null = parentId
  while (current) {
    if (current === projectId) return true
    if (seen.has(current)) return false
    seen.add(current)
    current = projectById(projects, current)?.parentId ?? null
  }
  return false
}

function siblingsForParent(projects: Project[], parentId: string | null): Project[] {
  return [...projects]
    .filter((project) => project.parentId === parentId)
    .sort((a, b) => {
      if (a.order === b.order) return a.name.localeCompare(b.name)
      return a.order - b.order
    })
}

function normalizeSiblingOrders(siblings: Project[]): Project[] {
  return siblings.map((project, index) => ({
    ...project,
    order: index + 1
  }))
}

function writeSiblings(projects: Project[], siblings: Project[]): Project[] {
  if (siblings.length === 0) return projects
  const nextById = new Map(siblings.map((project) => [project.id, project]))
  return projects.map((project) => nextById.get(project.id) ?? project)
}

function persist(projects: Project[]): Project[] {
  writeRawProjects(projects)
  notifyProjectListeners()
  return projects
}

function clampOrder(index: number, siblingCount: number): number {
  const floor = Math.max(1, Math.floor(index))
  return Math.min(siblingCount, floor)
}

export function listProjects(): Project[] {
  return readRawProjects()
    .map(cloneProject)
    .sort((a, b) => {
      if (a.parentId === b.parentId) {
        if (a.order === b.order) return a.name.localeCompare(b.name)
        return a.order - b.order
      }
      if (a.parentId === null) return -1
      if (b.parentId === null) return 1
      return String(a.parentId).localeCompare(String(b.parentId))
    })
}

export function getProject(projectId: string): Project | null {
  if (!projectId) return null
  const project = projectById(readRawProjects(), projectId)
  return project ? cloneProject(project) : null
}

export function createProject(input: ProjectInput): Project {
  const name = input.name?.trim()
  if (!name) throw new Error('Project name is required.')

  const parentId = normalizeParentId(input.parentId)
  const projects = readRawProjects()
  if (!isValidParent(projects, parentId)) {
    throw new Error('Parent project not found.')
  }

  const id = newProjectId()
  const now = Date.now()
  const newProject: Project = {
    schemaVersion: SCHEMA_VERSION,
    id,
    name,
    icon: normalizeIcon(input.icon, id),
    hue: normalizeHue(input.hue ?? agentIdenticonHash(id) % 360),
    parentId,
    order: 1,
    memberChatIds: normalizeChatIds(input.memberChatIds),
    createdAt: now,
    updatedAt: now
  }

  const targetSiblings = siblingsForParent(projects, parentId)
  const insertion = Math.max(1, Math.min(targetSiblings.length + 1, Math.round(input.order ?? targetSiblings.length + 1)))
  const reorderedSiblings = [...targetSiblings]
  reorderedSiblings.splice(insertion - 1, 0, newProject)
  const nextProjects = writeSiblings([...projects, newProject], normalizeSiblingOrders(reorderedSiblings))
  persist(nextProjects)
  return cloneProject(projectById(nextProjects, id)!)
}

export function renameProject(projectId: string, name: string): Project {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Project name is required.')

  const projects = readRawProjects()
  const current = assertProjectExists(projects, projectId)
  if (current.name === trimmed) return cloneProject(current)

  const next = {
    ...current,
    name: trimmed,
    updatedAt: Date.now()
  }
  const nextProjects = projects.map((project) => (project.id === projectId ? next : project))
  persist(nextProjects)
  return cloneProject(next)
}

export function deleteProject(projectId: string): void {
  const projects = readRawProjects()
  const project = assertProjectExists(projects, projectId)

  const deleteIds = new Set<string>()
  const queue = [projectId]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || deleteIds.has(current)) continue
    deleteIds.add(current)
    for (const child of projects) {
      if (child.parentId === current) queue.push(child.id)
    }
  }

  let next = projects.filter((project) => !deleteIds.has(project.id))
  const siblingsParentId = project.parentId
  const reindexed = siblingsForParent(next, siblingsParentId)
  next = writeSiblings(next, normalizeSiblingOrders(reindexed))

  persist(next)
}

function reorderWithinParent(
  projects: Project[],
  projectId: string,
  order: number,
  project: Project
): Project[] {
  const siblings = siblingsForParent(projects, project.parentId)
  const total = siblings.length
  const index = siblings.findIndex((item) => item.id === projectId)
  if (index < 0) return projects
  const target = clampOrder(order, total)
  if (target === index + 1) return projects

  const reordered = [...siblings]
  reordered.splice(index, 1)
  const moved = {
    ...project,
    order: target,
    updatedAt: Date.now()
  }
  reordered.splice(target - 1, 0, moved)
  return writeSiblings(projects, normalizeSiblingOrders(reordered))
}

export function reorderProject(projectId: string, order: number): Project {
  if (!Number.isFinite(order)) throw new Error('Invalid order.')
  const projects = readRawProjects()
  const project = assertProjectExists(projects, projectId)
  const nextProjects = reorderWithinParent(projects, projectId, order, project)
  if (nextProjects === projects) return cloneProject(project)
  persist(nextProjects)
  return cloneProject(projectById(nextProjects, projectId) ?? project)
}

export function moveProject(projectId: string, parentId: string | null, order?: number): Project {
  const targetParentId = normalizeParentId(parentId)
  const projects = readRawProjects()
  const project = assertProjectExists(projects, projectId)

  if (!isValidParent(projects, targetParentId)) {
    throw new Error('Parent project not found.')
  }
  if (wouldCreateCycle(projects, projectId, targetParentId)) {
    throw new Error('Cannot move a project into its own descendant.')
  }

  if (project.parentId === targetParentId && typeof order === 'undefined') {
    return cloneProject(project)
  }

  if (project.parentId === targetParentId) {
    if (order === undefined) return cloneProject(project)
    const reordered = reorderWithinParent(projects, projectId, order, project)
    if (reordered === projects) return cloneProject(project)
    persist(reordered)
    return cloneProject(projectById(reordered, projectId) ?? project)
  }

  const removed = projects.filter((item) => item.id !== projectId)
  const sourceParentId = project.parentId
  const sourceSiblings = normalizeSiblingOrders(siblingsForParent(removed, sourceParentId))
  let next = writeSiblings(removed, sourceSiblings)

  const targetSiblings = siblingsForParent(next, targetParentId)
  const insertion = clampOrder(order ?? targetSiblings.length + 1, targetSiblings.length + 1)
  const nextTarget = {
    ...project,
    parentId: targetParentId,
    updatedAt: Date.now()
  }
  const targetWithProject = [...targetSiblings]
  targetWithProject.splice(insertion - 1, 0, nextTarget)
  next = writeSiblings([...next, nextTarget], normalizeSiblingOrders(targetWithProject))

  persist(next)
  return cloneProject(projectById(next, projectId) ?? nextTarget)
}

export function setProjectIconAndHue(projectId: string, patch: ProjectPatch): Project {
  const projects = readRawProjects()
  const project = assertProjectExists(projects, projectId)
  if (!patch.icon && patch.hue === undefined) {
    throw new Error('No update provided for icon or hue.')
  }

  const next: Project = {
    ...project,
    icon: patch.icon ? normalizeIcon(patch.icon, project.id) : project.icon,
    hue: patch.hue === undefined ? project.hue : normalizeHue(patch.hue),
    updatedAt: Date.now()
  }

  if (project.hue === next.hue && JSON.stringify(project.icon) === JSON.stringify(next.icon)) {
    return cloneProject(project)
  }

  const nextProjects = projects.map((item) => (item.id === projectId ? next : item))
  persist(nextProjects)
  return cloneProject(next)
}

export function addChatToProject(projectId: string, chatId: string): Project {
  const trimmed = chatId.trim()
  if (!trimmed) throw new Error('Chat id is required.')

  const projects = readRawProjects()
  const project = assertProjectExists(projects, projectId)
  if (project.memberChatIds.includes(trimmed)) return cloneProject(project)

  const next: Project = {
    ...project,
    memberChatIds: [...project.memberChatIds, trimmed],
    updatedAt: Date.now()
  }
  const nextProjects = projects.map((item) => (item.id === projectId ? next : item))
  persist(nextProjects)
  return cloneProject(next)
}

export function removeChatFromProject(projectId: string, chatId: string): Project {
  const trimmed = chatId.trim()
  if (!trimmed) throw new Error('Chat id is required.')

  const projects = readRawProjects()
  const project = assertProjectExists(projects, projectId)
  const nextIds = project.memberChatIds.filter((id) => id !== trimmed)
  if (nextIds.length === project.memberChatIds.length) return cloneProject(project)

  const next: Project = {
    ...project,
    memberChatIds: nextIds,
    updatedAt: Date.now()
  }
  const nextProjects = projects.map((item) => (item.id === projectId ? next : item))
  persist(nextProjects)
  return cloneProject(next)
}

export function removeChatFromAllProjects(chatId: string): number {
  const trimmed = chatId.trim()
  if (!trimmed) throw new Error('Chat id is required.')

  const projects = readRawProjects()
  let changed = 0
  const now = Date.now()
  const nextProjects = projects.map((project) => {
    if (!project.memberChatIds.includes(trimmed)) return project
    changed += 1
    return {
      ...project,
      memberChatIds: project.memberChatIds.filter((id) => id !== trimmed),
      updatedAt: now
    }
  })

  if (changed === 0) return 0
  persist(nextProjects)
  return changed
}
