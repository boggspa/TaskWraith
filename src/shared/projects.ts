/**
 * Pure Project-record logic shared by the renderer projects store and the
 * main-owned project registry.
 *
 * Projects are the provider/workspace-agnostic organisational containers
 * behind the sidebar's Work surface. This module owns their V1 record shape,
 * normalization/migration, and every mutation — as pure list-in/list-out
 * operations so both processes apply IDENTICAL logic:
 *
 *   - The renderer facade applies an op optimistically to its in-memory
 *     snapshot and sends the SAME op to main.
 *   - Main applies the op to its authoritative state and broadcasts.
 *
 * Because the logic is shared, the two applications can only diverge if the
 * op itself is non-deterministic. It never is: ops carry their generated
 * `id`, timestamp (`now`), and derived defaults (`defaultHue`) as explicit
 * seed data. No APPLY function may read a clock, RNG, or storage — only the
 * initiator-side generator (`newProjectId`) touches crypto/time, and its
 * output travels inside the op.
 *
 * Mutations signal "nothing changed" by returning the SAME `projects` array
 * reference they were given; callers use that to skip persistence and
 * broadcasts, preserving the store's historical no-op semantics.
 */

export const PROJECT_SCHEMA_VERSION = 1

const PROJECT_ID_PREFIX = 'project-'
const DEFAULT_PROJECT_ICON_KIND = 'seed'

export type ProjectIcon = {
  iconKind: 'named' | 'seed' | 'asset'
  slug?: string
  seed?: string
  assetKey?: string
  accent?: string
  saturation?: number
  brightness?: number
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
  /** Shelved but fully retained: archiving never deletes chats, claims, or
   * references, and always cascades over the descendant subtree (mirroring
   * delete's cascade mental model) so a tree never re-roots. Absent = live. */
  archived?: boolean
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

export type ProjectPatch = {
  icon?: ProjectIcon
  hue?: number
}

export const MAX_PROJECT_BRIEF_LENGTH = 4000

/**
 * Main-owned companion record for a Project's Work-surface semantics. Kept
 * OUTSIDE the V1 Project shape on purpose: the V1 record round-trips through
 * strip-unknown-fields migration in old builds, so companion data grafted
 * onto it would be silently discarded. Device-local view preferences do NOT
 * belong here — this record is durable, broadcast, and (eventually) bridged.
 *
 * `homeChatId` is the lazy home-chat claim: written only when a chat is
 * explicitly designated (or, later, on a home draft's first send), never at
 * Project creation. A chat can be the home of at most one Project — the
 * registry enforces uniqueness at claim time and the normalizer heals
 * violations deterministically on read.
 */
export type ProjectWorkProfile = {
  projectId: string
  homeChatId?: string
  brief?: string
  preferredWorkspaceId?: string
  updatedAt: number
}

export type ProjectReferenceKind = 'file' | 'folder' | 'url' | 'connector'
export type ProjectReferenceContextPolicy = 'available' | 'off'
export type ProjectReferenceAvailability = 'ok' | 'missing'

export const MAX_PROJECT_REFERENCE_REVISION_LENGTH = 128

/**
 * The one read-only cloud connector of this phase: GitHub resources addressed
 * as `github://owner/repo[/path][@ref]`. Auth is delegated ENTIRELY to the
 * user's own `gh` CLI (with an anonymous public-API fallback) — the app never
 * stores or sees connector credentials, mirroring how provider CLIs own their
 * own auth. Verification is a single metadata request (latest commit touching
 * the resource — the stable revision); content is NEVER fetched, and in
 * explicit run context a connector reference is permanently catalogue-only
 * until a future phase adds disclosed, bounded retrieval.
 */
export interface GitHubReferenceLocator {
  owner: string
  repo: string
  path?: string
  ref?: string
}

const GITHUB_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9._-]+$/

export function parseGitHubReferenceLocator(locator: string): GitHubReferenceLocator | null {
  const trimmed = locator.trim()
  if (!trimmed.startsWith('github://')) return null
  let rest = trimmed.slice('github://'.length)
  let ref: string | undefined
  const atIndex = rest.lastIndexOf('@')
  if (atIndex > 0) {
    ref = rest.slice(atIndex + 1)
    rest = rest.slice(0, atIndex)
    if (!ref || ref.length > MAX_PROJECT_REFERENCE_REVISION_LENGTH || ref.includes('/')) {
      return null
    }
  }
  const segments = rest.split('/').filter(Boolean)
  if (segments.length < 2) return null
  const [owner, repo, ...pathSegments] = segments
  if (!GITHUB_NAME_PATTERN.test(owner) || !GITHUB_REPO_PATTERN.test(repo)) return null
  if (pathSegments.some((segment) => segment === '.' || segment === '..')) return null
  return {
    owner,
    repo,
    ...(pathSegments.length > 0 ? { path: pathSegments.join('/') } : {}),
    ...(ref ? { ref } : {})
  }
}

/**
 * Normalize user input into the canonical `github://` form. Accepts the
 * canonical form, `owner/repo[/path]`, and pasted github.com URLs
 * (`/blob/<ref>/path`, `/tree/<ref>/path`, or a bare repo). Returns null for
 * anything else — the caller surfaces the format hint.
 */
export function normalizeGitHubReferenceInput(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('github://')) {
    return parseGitHubReferenceLocator(trimmed) ? trimmed : null
  }
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      return null
    }
    if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null
    const segments = url.pathname.split('/').filter(Boolean)
    if (segments.length < 2) return null
    const [owner, repo, marker, ref, ...pathSegments] = segments
    const repoName = repo.endsWith('.git') ? repo.slice(0, -4) : repo
    let candidate: string
    if ((marker === 'blob' || marker === 'tree') && ref) {
      const path = pathSegments.join('/')
      candidate = `github://${owner}/${repoName}${path ? `/${path}` : ''}@${ref}`
    } else {
      candidate = `github://${owner}/${repoName}`
    }
    return parseGitHubReferenceLocator(candidate) ? candidate : null
  }
  const candidate = `github://${trimmed.replace(/^\/+/, '')}`
  return parseGitHubReferenceLocator(candidate) ? candidate : null
}

/**
 * A Project's durable library entry: "this source matters to the Project."
 *
 * THE SAFETY BOUNDARY (non-negotiable, from the design brief): a reference
 * is a CATALOGUE entry — it grants NO filesystem, network, or provider
 * access, is never read, fetched, indexed, or injected merely because it is
 * present, and never creates an external-path grant. A user may explicitly
 * select entries for one committed send; main then re-resolves their ids,
 * binds the disclosure to that run, and applies only authority the run already
 * had. `lastVerified` is the LAST-KNOWN
 * availability from an explicit user-triggered probe (a single stat — never
 * content), shown as-is at browse time; nothing verifies on open.
 */
export type ProjectReference = {
  id: string
  projectId: string
  kind: ProjectReferenceKind
  /** Absolute path (file/folder) or URL. Opaque to this module. */
  locator: string
  title: string
  provenance: { addedBy: 'user'; addedAt: number }
  /** 'available': listed for future explicit context selection. 'off':
   * retained for the user but excluded from any agent-facing surface. */
  contextPolicy: ProjectReferenceContextPolicy
  /** Last explicit availability probe. `revision` is the connector-stable
   * version identifier seen at that probe (GitHub: the latest commit sha
   * touching the resource) — the audit anchor for cloud references. */
  lastVerified?: { at: number; status: ProjectReferenceAvailability; revision?: string }
  updatedAt: number
}

/** Seed data a `create` op must carry so apply stays deterministic. */
export type CreateProjectSeed = {
  id: string
  now: number
  /** Fallback hue when the input doesn't specify one. The initiator derives
   * it (renderer: identicon hash of the new id) — apply never computes it. */
  defaultHue: number
}

export function newProjectId(): string {
  const uuid =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `${PROJECT_ID_PREFIX}${uuid}`
}

const PROJECT_REFERENCE_ID_PREFIX = 'ref-'

export function newProjectReferenceId(): string {
  const uuid =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `${PROJECT_REFERENCE_ID_PREFIX}${uuid}`
}

function normalizeHue(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) return 0
  return ((Math.round(value) % 360) + 360) % 360
}

function normalizePercent(value: unknown): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    return undefined
  }
  return Math.max(0, Math.min(100, Math.round(value)))
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
  const saturation = normalizePercent(icon.saturation)
  const brightness = normalizePercent(icon.brightness)
  return {
    iconKind: icon.iconKind,
    ...(icon.slug ? { slug: icon.slug } : {}),
    ...(icon.seed ? { seed: icon.seed } : {}),
    ...(icon.assetKey ? { assetKey: icon.assetKey } : {}),
    ...(icon.accent ? { accent: icon.accent } : {}),
    ...(saturation !== undefined ? { saturation } : {}),
    ...(brightness !== undefined ? { brightness } : {})
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
    ...(icon.accent ? { accent: icon.accent } : {}),
    ...(typeof icon.saturation === 'number' ? { saturation: icon.saturation } : {}),
    ...(typeof icon.brightness === 'number' ? { brightness: icon.brightness } : {})
  }
}

export function cloneProject(project: Project): Project {
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
    (typeof candidate.accent === 'undefined' || typeof candidate.accent === 'string') &&
    (typeof candidate.saturation === 'undefined' ||
      (typeof candidate.saturation === 'number' && Number.isFinite(candidate.saturation))) &&
    (typeof candidate.brightness === 'undefined' ||
      (typeof candidate.brightness === 'number' && Number.isFinite(candidate.brightness)))
  )
}

export function isProject(value: unknown): value is Project {
  if (!value || typeof value !== 'object') return false
  const entry = value as Project
  return (
    typeof entry.id === 'string' &&
    entry.id.length > 0 &&
    entry.schemaVersion === PROJECT_SCHEMA_VERSION &&
    typeof entry.name === 'string' &&
    entry.name.trim().length > 0 &&
    isProjectIcon(entry.icon) &&
    typeof entry.hue === 'number' &&
    Number.isFinite(entry.hue) &&
    (entry.parentId === null || typeof entry.parentId === 'string') &&
    (typeof entry.archived === 'undefined' || typeof entry.archived === 'boolean') &&
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

/**
 * Best-effort single-record migration: reconstructs ONLY known V1 fields, so
 * unknown fields from other builds are deliberately stripped (forward-compat
 * by subtraction — companion data must live in companion records, never be
 * grafted onto this shape). `now` seeds missing timestamps; callers supply it
 * so migration output is deterministic for a given input.
 */
export function migrateProject(value: unknown, now: number): Project | null {
  if (!value || typeof value !== 'object') return null
  const entry = value as Partial<Project>
  if (typeof entry.id !== 'string' || entry.id.length === 0) return null
  if (typeof entry.name !== 'string' || entry.name.trim().length === 0) return null
  const createdAt =
    typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt)
      ? entry.createdAt
      : now
  const updatedAt =
    typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
      ? entry.updatedAt
      : createdAt
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
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
    ...(entry.archived === true ? { archived: true } : {}),
    createdAt,
    updatedAt
  }
}

export function migrateProjects(candidates: unknown[], now: number): Project[] {
  const seen = new Set<string>()
  const projects: Project[] = []
  for (const candidate of candidates) {
    const migrated = migrateProject(candidate, now)
    if (!isProject(migrated) || seen.has(migrated.id)) continue
    seen.add(migrated.id)
    projects.push({
      ...migrated,
      icon: cloneIcon(migrated.icon)
    })
  }
  return projects
}

export function projectById(projects: Project[], id: string): Project | null {
  return projects.find((project) => project.id === id) ?? null
}

export function cloneProjectWorkProfile(profile: ProjectWorkProfile): ProjectWorkProfile {
  return { ...profile }
}

function normalizeOptionalIdField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** A profile carrying no semantic fields is dead weight — drop it. */
function isMeaningfulWorkProfile(profile: ProjectWorkProfile): boolean {
  return (
    profile.homeChatId !== undefined ||
    profile.brief !== undefined ||
    profile.preferredWorkspaceId !== undefined
  )
}

/**
 * Best-effort work-profile migration with the same philosophy as
 * `migrateProjects`: reconstruct known fields, drop what can't be trusted.
 * Referential integrity is enforced against `validProjectIds` (a profile for
 * a vanished Project is dropped), duplicate projectIds keep the first entry,
 * and a `homeChatId` claimed by an earlier profile is cleared from later
 * ones — one home per chat, healed deterministically on read.
 */
export function migrateProjectWorkProfiles(
  candidates: unknown[],
  validProjectIds: ReadonlySet<string>,
  now: number
): ProjectWorkProfile[] {
  const seenProjectIds = new Set<string>()
  const claimedHomeChatIds = new Set<string>()
  const profiles: ProjectWorkProfile[] = []
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    const entry = candidate as Partial<ProjectWorkProfile>
    const projectId = normalizeOptionalIdField(entry.projectId)
    if (!projectId || !validProjectIds.has(projectId) || seenProjectIds.has(projectId)) continue
    let homeChatId = normalizeOptionalIdField(entry.homeChatId)
    if (homeChatId) {
      if (claimedHomeChatIds.has(homeChatId)) homeChatId = undefined
      else claimedHomeChatIds.add(homeChatId)
    }
    const brief =
      typeof entry.brief === 'string' && entry.brief.trim()
        ? entry.brief.slice(0, MAX_PROJECT_BRIEF_LENGTH)
        : undefined
    const preferredWorkspaceId = normalizeOptionalIdField(entry.preferredWorkspaceId)
    const profile: ProjectWorkProfile = {
      projectId,
      ...(homeChatId ? { homeChatId } : {}),
      ...(brief !== undefined ? { brief } : {}),
      ...(preferredWorkspaceId ? { preferredWorkspaceId } : {}),
      updatedAt:
        typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
          ? entry.updatedAt
          : now
    }
    if (!isMeaningfulWorkProfile(profile)) continue
    seenProjectIds.add(projectId)
    profiles.push(profile)
  }
  return profiles
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

function clampOrder(index: number, siblingCount: number): number {
  const floor = Math.max(1, Math.floor(index))
  return Math.min(siblingCount, floor)
}

/** Display ordering: roots first (by order, then name), then children grouped
 * by parent. Non-mutating. */
export function sortProjectsForDisplay(projects: Project[]): Project[] {
  return [...projects].sort((a, b) => {
    if (a.parentId === b.parentId) {
      if (a.order === b.order) return a.name.localeCompare(b.name)
      return a.order - b.order
    }
    if (a.parentId === null) return -1
    if (b.parentId === null) return 1
    return String(a.parentId).localeCompare(String(b.parentId))
  })
}

export type ProjectMutation = {
  projects: Project[]
  project: Project
}

export function applyCreateProject(
  projects: Project[],
  input: ProjectInput,
  seed: CreateProjectSeed
): ProjectMutation {
  const name = input.name?.trim()
  if (!name) throw new Error('Project name is required.')

  const parentId = normalizeParentId(input.parentId)
  if (!isValidParent(projects, parentId)) {
    throw new Error('Parent project not found.')
  }

  const newProject: Project = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: seed.id,
    name,
    icon: normalizeIcon(input.icon, seed.id),
    hue: normalizeHue(input.hue ?? seed.defaultHue),
    parentId,
    order: 1,
    memberChatIds: normalizeChatIds(input.memberChatIds),
    createdAt: seed.now,
    updatedAt: seed.now
  }

  const targetSiblings = siblingsForParent(projects, parentId)
  const insertion = Math.max(
    1,
    Math.min(targetSiblings.length + 1, Math.round(input.order ?? targetSiblings.length + 1))
  )
  const reorderedSiblings = [...targetSiblings]
  reorderedSiblings.splice(insertion - 1, 0, newProject)
  const next = writeSiblings([...projects, newProject], normalizeSiblingOrders(reorderedSiblings))
  return { projects: next, project: projectById(next, seed.id)! }
}

export function applyRenameProject(
  projects: Project[],
  projectId: string,
  name: string,
  now: number
): ProjectMutation {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Project name is required.')

  const current = assertProjectExists(projects, projectId)
  if (current.name === trimmed) return { projects, project: current }

  const next = {
    ...current,
    name: trimmed,
    updatedAt: now
  }
  return {
    projects: projects.map((project) => (project.id === projectId ? next : project)),
    project: next
  }
}

export function applyDeleteProject(projects: Project[], projectId: string): Project[] {
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

  let next = projects.filter((entry) => !deleteIds.has(entry.id))
  const reindexed = siblingsForParent(next, project.parentId)
  next = writeSiblings(next, normalizeSiblingOrders(reindexed))
  return next
}

function reorderWithinParent(
  projects: Project[],
  projectId: string,
  order: number,
  project: Project,
  now: number
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
    updatedAt: now
  }
  reordered.splice(target - 1, 0, moved)
  return writeSiblings(projects, normalizeSiblingOrders(reordered))
}

export function applyReorderProject(
  projects: Project[],
  projectId: string,
  order: number,
  now: number
): ProjectMutation {
  if (!Number.isFinite(order)) throw new Error('Invalid order.')
  const project = assertProjectExists(projects, projectId)
  const next = reorderWithinParent(projects, projectId, order, project, now)
  if (next === projects) return { projects, project }
  return { projects: next, project: projectById(next, projectId) ?? project }
}

export function applyMoveProject(
  projects: Project[],
  projectId: string,
  parentId: string | null,
  order: number | undefined,
  now: number
): ProjectMutation {
  const targetParentId = normalizeParentId(parentId)
  const project = assertProjectExists(projects, projectId)

  if (!isValidParent(projects, targetParentId)) {
    throw new Error('Parent project not found.')
  }
  if (wouldCreateCycle(projects, projectId, targetParentId)) {
    throw new Error('Cannot move a project into its own descendant.')
  }

  if (project.parentId === targetParentId) {
    if (order === undefined) return { projects, project }
    const reordered = reorderWithinParent(projects, projectId, order, project, now)
    if (reordered === projects) return { projects, project }
    return { projects: reordered, project: projectById(reordered, projectId) ?? project }
  }

  const removed = projects.filter((item) => item.id !== projectId)
  const sourceSiblings = normalizeSiblingOrders(siblingsForParent(removed, project.parentId))
  let next = writeSiblings(removed, sourceSiblings)

  const targetSiblings = siblingsForParent(next, targetParentId)
  const insertion = clampOrder(order ?? targetSiblings.length + 1, targetSiblings.length + 1)
  const nextTarget = {
    ...project,
    parentId: targetParentId,
    updatedAt: now
  }
  const targetWithProject = [...targetSiblings]
  targetWithProject.splice(insertion - 1, 0, nextTarget)
  next = writeSiblings([...next, nextTarget], normalizeSiblingOrders(targetWithProject))
  return { projects: next, project: projectById(next, projectId) ?? nextTarget }
}

/**
 * Archive or restore a project AND its descendant subtree. Both directions
 * cascade so the tree never re-roots: archiving a folder shelves everything
 * inside it, restoring brings the subtree back together. Chats, home claims,
 * and references are untouched — a shelf, not a shredder.
 */
export function applySetProjectArchived(
  projects: Project[],
  projectId: string,
  archived: boolean,
  now: number
): ProjectMutation {
  const project = assertProjectExists(projects, projectId)
  const targetIds = new Set<string>([projectId])
  const queue = [projectId]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) continue
    for (const child of projects) {
      if (child.parentId === current && !targetIds.has(child.id)) {
        targetIds.add(child.id)
        queue.push(child.id)
      }
    }
  }
  let changed = false
  const next = projects.map((entry) => {
    if (!targetIds.has(entry.id)) return entry
    if ((entry.archived === true) === archived) return entry
    changed = true
    const updated: Project = { ...entry, updatedAt: now }
    if (archived) updated.archived = true
    else delete updated.archived
    return updated
  })
  if (!changed) return { projects, project }
  return { projects: next, project: projectById(next, projectId) ?? project }
}

export function applySetProjectIconAndHue(
  projects: Project[],
  projectId: string,
  patch: ProjectPatch,
  now: number
): ProjectMutation {
  const project = assertProjectExists(projects, projectId)
  if (!patch.icon && patch.hue === undefined) {
    throw new Error('No update provided for icon or hue.')
  }

  const next: Project = {
    ...project,
    icon: patch.icon ? normalizeIcon(patch.icon, project.id) : project.icon,
    hue: patch.hue === undefined ? project.hue : normalizeHue(patch.hue),
    updatedAt: now
  }

  if (project.hue === next.hue && JSON.stringify(project.icon) === JSON.stringify(next.icon)) {
    return { projects, project }
  }

  return {
    projects: projects.map((item) => (item.id === projectId ? next : item)),
    project: next
  }
}

export function applyAddChatToProject(
  projects: Project[],
  projectId: string,
  chatId: string,
  now: number
): ProjectMutation {
  const trimmed = chatId.trim()
  if (!trimmed) throw new Error('Chat id is required.')

  const project = assertProjectExists(projects, projectId)
  if (project.memberChatIds.includes(trimmed)) return { projects, project }

  const next: Project = {
    ...project,
    memberChatIds: [...project.memberChatIds, trimmed],
    updatedAt: now
  }
  return {
    projects: projects.map((item) => (item.id === projectId ? next : item)),
    project: next
  }
}

export function applyRemoveChatFromProject(
  projects: Project[],
  projectId: string,
  chatId: string,
  now: number
): ProjectMutation {
  const trimmed = chatId.trim()
  if (!trimmed) throw new Error('Chat id is required.')

  const project = assertProjectExists(projects, projectId)
  const nextIds = project.memberChatIds.filter((id) => id !== trimmed)
  if (nextIds.length === project.memberChatIds.length) return { projects, project }

  const next: Project = {
    ...project,
    memberChatIds: nextIds,
    updatedAt: now
  }
  return {
    projects: projects.map((item) => (item.id === projectId ? next : item)),
    project: next
  }
}

export function applyRemoveChatFromAllProjects(
  projects: Project[],
  chatId: string,
  now: number
): { projects: Project[]; changedCount: number } {
  const trimmed = chatId.trim()
  if (!trimmed) throw new Error('Chat id is required.')

  let changedCount = 0
  const next = projects.map((project) => {
    if (!project.memberChatIds.includes(trimmed)) return project
    changedCount += 1
    return {
      ...project,
      memberChatIds: project.memberChatIds.filter((id) => id !== trimmed),
      updatedAt: now
    }
  })

  if (changedCount === 0) return { projects, changedCount: 0 }
  return { projects: next, changedCount }
}

/**
 * The wire format for project mutations. The initiating renderer builds an op
 * (including all seed data), applies it optimistically via the same functions
 * above, and sends it to main; main re-applies it against authoritative state.
 * Every op re-validates against the state it is applied to, so a stale or
 * malicious op degrades to a thrown Error, never a corrupt store.
 */
export type ProjectOp =
  | { kind: 'create'; input: ProjectInput; id: string; now: number; defaultHue: number }
  | { kind: 'rename'; projectId: string; name: string; now: number }
  | { kind: 'delete'; projectId: string }
  | { kind: 'reorder'; projectId: string; order: number; now: number }
  | { kind: 'move'; projectId: string; parentId: string | null; order?: number; now: number }
  | { kind: 'set-icon-hue'; projectId: string; patch: ProjectPatch; now: number }
  | { kind: 'set-archived'; projectId: string; archived: boolean; now: number }
  | { kind: 'add-chat'; projectId: string; chatId: string; now: number }
  | { kind: 'remove-chat'; projectId: string; chatId: string; now: number }
  | { kind: 'remove-chat-everywhere'; chatId: string; now: number }

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

/**
 * Field-level type validation for ops arriving over IPC (untrusted `unknown`).
 * This guarantees apply cannot TypeError on malformed field types; SEMANTIC
 * validation (name required, parent exists, cycles, …) stays in the apply
 * functions where it also protects in-process callers. Returns null rather
 * than throwing so the IPC handler can reject with a stable error.
 */
export function parseProjectOp(value: unknown): ProjectOp | null {
  if (!value || typeof value !== 'object') return null
  const op = value as Record<string, unknown>
  switch (op.kind) {
    case 'create': {
      if (!isNonEmptyString(op.id) || !isFiniteNumber(op.now) || !isFiniteNumber(op.defaultHue)) {
        return null
      }
      const input = op.input
      if (!input || typeof input !== 'object') return null
      const candidate = input as Record<string, unknown>
      if (typeof candidate.name !== 'string') return null
      if (
        candidate.parentId !== undefined &&
        candidate.parentId !== null &&
        typeof candidate.parentId !== 'string'
      ) {
        return null
      }
      if (candidate.order !== undefined && !isFiniteNumber(candidate.order)) return null
      if (candidate.hue !== undefined && !isFiniteNumber(candidate.hue)) return null
      // icon / memberChatIds tolerate any shape: normalizeIcon and
      // normalizeChatIds already treat them as untrusted.
      return {
        kind: 'create',
        input: {
          name: candidate.name,
          parentId: (candidate.parentId ?? undefined) as string | null | undefined,
          order: candidate.order as number | undefined,
          icon: candidate.icon as ProjectIcon | undefined,
          hue: candidate.hue as number | undefined,
          memberChatIds: candidate.memberChatIds as string[] | undefined
        },
        id: op.id,
        now: op.now,
        defaultHue: op.defaultHue
      }
    }
    case 'rename': {
      if (!isNonEmptyString(op.projectId) || typeof op.name !== 'string') return null
      if (!isFiniteNumber(op.now)) return null
      return { kind: 'rename', projectId: op.projectId, name: op.name, now: op.now }
    }
    case 'delete': {
      if (!isNonEmptyString(op.projectId)) return null
      return { kind: 'delete', projectId: op.projectId }
    }
    case 'reorder': {
      if (!isNonEmptyString(op.projectId) || typeof op.order !== 'number') return null
      if (!isFiniteNumber(op.now)) return null
      return { kind: 'reorder', projectId: op.projectId, order: op.order, now: op.now }
    }
    case 'move': {
      if (!isNonEmptyString(op.projectId) || !isFiniteNumber(op.now)) return null
      if (op.parentId !== null && typeof op.parentId !== 'string') return null
      if (op.order !== undefined && !isFiniteNumber(op.order)) return null
      return {
        kind: 'move',
        projectId: op.projectId,
        parentId: op.parentId,
        order: op.order as number | undefined,
        now: op.now
      }
    }
    case 'set-icon-hue': {
      if (!isNonEmptyString(op.projectId) || !isFiniteNumber(op.now)) return null
      const patch = op.patch
      if (!patch || typeof patch !== 'object') return null
      const candidate = patch as Record<string, unknown>
      if (candidate.hue !== undefined && !isFiniteNumber(candidate.hue)) return null
      return {
        kind: 'set-icon-hue',
        projectId: op.projectId,
        patch: {
          icon: candidate.icon as ProjectIcon | undefined,
          hue: candidate.hue as number | undefined
        },
        now: op.now
      }
    }
    case 'set-archived': {
      if (!isNonEmptyString(op.projectId) || typeof op.archived !== 'boolean') return null
      if (!isFiniteNumber(op.now)) return null
      return { kind: 'set-archived', projectId: op.projectId, archived: op.archived, now: op.now }
    }
    case 'add-chat':
    case 'remove-chat': {
      if (!isNonEmptyString(op.projectId) || typeof op.chatId !== 'string') return null
      if (!isFiniteNumber(op.now)) return null
      return { kind: op.kind, projectId: op.projectId, chatId: op.chatId, now: op.now }
    }
    case 'remove-chat-everywhere': {
      if (typeof op.chatId !== 'string' || !isFiniteNumber(op.now)) return null
      return { kind: 'remove-chat-everywhere', chatId: op.chatId, now: op.now }
    }
    default:
      return null
  }
}

/**
 * Apply a wire op to a project list. `changed` mirrors the historical no-op
 * semantics: false means the returned array is the input array and callers
 * must not persist or broadcast.
 */
export function applyProjectOp(
  projects: Project[],
  op: ProjectOp
): { projects: Project[]; changed: boolean } {
  switch (op.kind) {
    case 'create': {
      const result = applyCreateProject(projects, op.input, {
        id: op.id,
        now: op.now,
        defaultHue: op.defaultHue
      })
      return { projects: result.projects, changed: true }
    }
    case 'rename': {
      const result = applyRenameProject(projects, op.projectId, op.name, op.now)
      return { projects: result.projects, changed: result.projects !== projects }
    }
    case 'delete': {
      const next = applyDeleteProject(projects, op.projectId)
      return { projects: next, changed: true }
    }
    case 'reorder': {
      const result = applyReorderProject(projects, op.projectId, op.order, op.now)
      return { projects: result.projects, changed: result.projects !== projects }
    }
    case 'move': {
      const result = applyMoveProject(projects, op.projectId, op.parentId, op.order, op.now)
      return { projects: result.projects, changed: result.projects !== projects }
    }
    case 'set-icon-hue': {
      const result = applySetProjectIconAndHue(projects, op.projectId, op.patch, op.now)
      return { projects: result.projects, changed: result.projects !== projects }
    }
    case 'set-archived': {
      const result = applySetProjectArchived(projects, op.projectId, op.archived, op.now)
      return { projects: result.projects, changed: result.projects !== projects }
    }
    case 'add-chat': {
      const result = applyAddChatToProject(projects, op.projectId, op.chatId, op.now)
      return { projects: result.projects, changed: result.projects !== projects }
    }
    case 'remove-chat': {
      const result = applyRemoveChatFromProject(projects, op.projectId, op.chatId, op.now)
      return { projects: result.projects, changed: result.projects !== projects }
    }
    case 'remove-chat-everywhere': {
      const result = applyRemoveChatFromAllProjects(projects, op.chatId, op.now)
      return { projects: result.projects, changed: result.changedCount > 0 }
    }
    default: {
      const exhausted: never = op
      throw new Error(`Unknown project op: ${String((exhausted as { kind?: string }).kind)}`)
    }
  }
}

function isProjectReferenceKind(value: unknown): value is ProjectReferenceKind {
  return value === 'file' || value === 'folder' || value === 'url' || value === 'connector'
}

function isProjectReferenceContextPolicy(
  value: unknown
): value is ProjectReferenceContextPolicy {
  return value === 'available' || value === 'off'
}

function isProjectReferenceAvailability(value: unknown): value is ProjectReferenceAvailability {
  return value === 'ok' || value === 'missing'
}

export function cloneProjectReference(reference: ProjectReference): ProjectReference {
  return {
    ...reference,
    provenance: { ...reference.provenance },
    ...(reference.lastVerified ? { lastVerified: { ...reference.lastVerified } } : {})
  }
}

/** Human title fallback: last path segment for files/folders, hostname for
 * URLs, the raw locator when neither parses. */
export function defaultProjectReferenceTitle(
  kind: ProjectReferenceKind,
  locator: string
): string {
  const trimmed = locator.trim()
  if (kind === 'connector') {
    const parsed = parseGitHubReferenceLocator(trimmed)
    if (!parsed) return trimmed
    const leaf = parsed.path?.split('/').filter(Boolean).pop()
    return `${parsed.owner}/${parsed.repo}${leaf ? ` · ${leaf}` : ''}`
  }
  if (kind === 'url') {
    try {
      const parsed = new URL(trimmed)
      return parsed.hostname || trimmed
    } catch {
      return trimmed
    }
  }
  const segments = trimmed.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] || trimmed
}

/**
 * Best-effort reference migration, same philosophy as the other record
 * normalizers: reconstruct known fields, drop orphans (vanished project),
 * duplicates, and anything untrustworthy.
 */
export function migrateProjectReferences(
  candidates: unknown[],
  validProjectIds: ReadonlySet<string>,
  now: number
): ProjectReference[] {
  const seen = new Set<string>()
  const references: ProjectReference[] = []
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    const entry = candidate as Partial<ProjectReference>
    if (typeof entry.id !== 'string' || !entry.id.trim()) continue
    if (seen.has(entry.id)) continue
    if (typeof entry.projectId !== 'string' || !validProjectIds.has(entry.projectId)) continue
    if (!isProjectReferenceKind(entry.kind)) continue
    if (typeof entry.locator !== 'string' || !entry.locator.trim()) continue
    const locator = entry.locator.trim()
    // Read-time integrity matches add-time validation: a connector entry
    // whose locator no longer parses cannot be verified or disclosed.
    if (entry.kind === 'connector' && !parseGitHubReferenceLocator(locator)) continue
    const provenanceAddedAt =
      entry.provenance &&
      typeof entry.provenance === 'object' &&
      typeof entry.provenance.addedAt === 'number' &&
      Number.isFinite(entry.provenance.addedAt)
        ? entry.provenance.addedAt
        : now
    const lastVerified =
      entry.lastVerified &&
      typeof entry.lastVerified === 'object' &&
      typeof entry.lastVerified.at === 'number' &&
      Number.isFinite(entry.lastVerified.at) &&
      isProjectReferenceAvailability(entry.lastVerified.status)
        ? {
            at: entry.lastVerified.at,
            status: entry.lastVerified.status,
            ...(typeof entry.lastVerified.revision === 'string' &&
            entry.lastVerified.revision.trim() &&
            entry.lastVerified.revision.length <= MAX_PROJECT_REFERENCE_REVISION_LENGTH
              ? { revision: entry.lastVerified.revision }
              : {})
          }
        : undefined
    seen.add(entry.id)
    references.push({
      id: entry.id,
      projectId: entry.projectId,
      kind: entry.kind,
      locator,
      title:
        typeof entry.title === 'string' && entry.title.trim()
          ? entry.title.trim()
          : defaultProjectReferenceTitle(entry.kind, locator),
      provenance: { addedBy: 'user', addedAt: provenanceAddedAt },
      contextPolicy: isProjectReferenceContextPolicy(entry.contextPolicy)
        ? entry.contextPolicy
        : 'available',
      ...(lastVerified ? { lastVerified } : {}),
      updatedAt:
        typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
          ? entry.updatedAt
          : now
    })
  }
  return references
}

/**
 * The wire format for reference-library mutations. Same contract as
 * `ProjectOp`: initiator supplies id/now seeds, apply re-validates against
 * the state it runs on, malformed field types are rejected by the parser
 * before apply can TypeError. `referenceKind` (not `kind`) on the add op —
 * `kind` is the op discriminant.
 */
export type ProjectReferenceOp =
  | {
      kind: 'add-reference'
      id: string
      projectId: string
      referenceKind: ProjectReferenceKind
      locator: string
      title?: string
      now: number
    }
  | {
      kind: 'update-reference'
      id: string
      patch: { title?: string; contextPolicy?: ProjectReferenceContextPolicy }
      now: number
    }
  | { kind: 'remove-reference'; id: string }
  | {
      kind: 'record-reference-verification'
      id: string
      status: ProjectReferenceAvailability
      revision?: string
      now: number
    }

export function parseProjectReferenceOp(value: unknown): ProjectReferenceOp | null {
  if (!value || typeof value !== 'object') return null
  const op = value as Record<string, unknown>
  switch (op.kind) {
    case 'add-reference': {
      if (!isNonEmptyString(op.id) || !isNonEmptyString(op.projectId)) return null
      if (!isProjectReferenceKind(op.referenceKind)) return null
      if (typeof op.locator !== 'string' || !isFiniteNumber(op.now)) return null
      if (op.title !== undefined && typeof op.title !== 'string') return null
      return {
        kind: 'add-reference',
        id: op.id,
        projectId: op.projectId,
        referenceKind: op.referenceKind,
        locator: op.locator,
        title: op.title as string | undefined,
        now: op.now
      }
    }
    case 'update-reference': {
      if (!isNonEmptyString(op.id) || !isFiniteNumber(op.now)) return null
      const patch = op.patch
      if (!patch || typeof patch !== 'object') return null
      const candidate = patch as Record<string, unknown>
      if (candidate.title !== undefined && typeof candidate.title !== 'string') return null
      if (
        candidate.contextPolicy !== undefined &&
        !isProjectReferenceContextPolicy(candidate.contextPolicy)
      ) {
        return null
      }
      return {
        kind: 'update-reference',
        id: op.id,
        patch: {
          title: candidate.title as string | undefined,
          contextPolicy: candidate.contextPolicy as ProjectReferenceContextPolicy | undefined
        },
        now: op.now
      }
    }
    case 'remove-reference': {
      if (!isNonEmptyString(op.id)) return null
      return { kind: 'remove-reference', id: op.id }
    }
    case 'record-reference-verification': {
      if (!isNonEmptyString(op.id) || !isFiniteNumber(op.now)) return null
      if (!isProjectReferenceAvailability(op.status)) return null
      if (
        op.revision !== undefined &&
        (typeof op.revision !== 'string' ||
          !op.revision.trim() ||
          op.revision.length > MAX_PROJECT_REFERENCE_REVISION_LENGTH)
      ) {
        return null
      }
      return {
        kind: 'record-reference-verification',
        id: op.id,
        status: op.status,
        revision: op.revision as string | undefined,
        now: op.now
      }
    }
    default:
      return null
  }
}

/**
 * Apply a reference op. `projects` is consulted for add-time referential
 * integrity only — references never mutate the project list. Adds are
 * idempotent per (projectId, kind, locator): re-adding an existing source
 * returns the current record unchanged.
 */
export function applyProjectReferenceOp(
  references: ProjectReference[],
  projects: Project[],
  op: ProjectReferenceOp
): { references: ProjectReference[]; changed: boolean } {
  switch (op.kind) {
    case 'add-reference': {
      if (!projectById(projects, op.projectId)) throw new Error('Project not found.')
      const locator = op.locator.trim()
      if (!locator) throw new Error('Reference locator is required.')
      if (op.referenceKind === 'connector' && !parseGitHubReferenceLocator(locator)) {
        throw new Error('Connector locator must be github://owner/repo[/path][@ref].')
      }
      const existing = references.find(
        (reference) =>
          reference.projectId === op.projectId &&
          reference.kind === op.referenceKind &&
          reference.locator === locator
      )
      if (existing) return { references, changed: false }
      const title = op.title?.trim() || defaultProjectReferenceTitle(op.referenceKind, locator)
      const next: ProjectReference = {
        id: op.id,
        projectId: op.projectId,
        kind: op.referenceKind,
        locator,
        title,
        provenance: { addedBy: 'user', addedAt: op.now },
        contextPolicy: 'available',
        updatedAt: op.now
      }
      return { references: [...references, next], changed: true }
    }
    case 'update-reference': {
      const current = references.find((reference) => reference.id === op.id)
      if (!current) throw new Error('Reference not found.')
      const title = op.patch.title?.trim()
      const next: ProjectReference = {
        ...current,
        ...(title ? { title } : {}),
        ...(op.patch.contextPolicy ? { contextPolicy: op.patch.contextPolicy } : {}),
        updatedAt: op.now
      }
      if (next.title === current.title && next.contextPolicy === current.contextPolicy) {
        return { references, changed: false }
      }
      return {
        references: references.map((reference) => (reference.id === op.id ? next : reference)),
        changed: true
      }
    }
    case 'remove-reference': {
      const next = references.filter((reference) => reference.id !== op.id)
      if (next.length === references.length) throw new Error('Reference not found.')
      return { references: next, changed: true }
    }
    case 'record-reference-verification': {
      const current = references.find((reference) => reference.id === op.id)
      if (!current) throw new Error('Reference not found.')
      const next: ProjectReference = {
        ...current,
        lastVerified: {
          at: op.now,
          status: op.status,
          ...(op.revision ? { revision: op.revision } : {})
        },
        updatedAt: op.now
      }
      return {
        references: references.map((reference) => (reference.id === op.id ? next : reference)),
        changed: true
      }
    }
    default: {
      const exhausted: never = op
      throw new Error(
        `Unknown project reference op: ${String((exhausted as { kind?: string }).kind)}`
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Project thread-graph edges
//
// A ProjectGraphEdge is a durable, user-authored dependency link between two
// member threads of a Project: `fromChatId` is upstream (a prerequisite),
// `toChatId` is downstream (depends on it). Like ProjectReference, edges are a
// companion record kept OUTSIDE the V1 Project shape so old builds don't strip
// them, and they grant NO execution — V1 renders them as an organisational map.
// Auto-derived relationship edges (parent/sub/side chats) are computed in the
// renderer projection and NEVER stored here; only explicit user edges are.
// ---------------------------------------------------------------------------

export type ProjectGraphEdge = {
  id: string
  projectId: string
  /** Upstream thread (the prerequisite). */
  fromChatId: string
  /** Downstream thread (depends on `fromChatId`). */
  toChatId: string
  kind: 'dependency'
  createdAt: number
}

const PROJECT_GRAPH_EDGE_ID_PREFIX = 'pgedge-'

export function newProjectGraphEdgeId(): string {
  const uuid =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `${PROJECT_GRAPH_EDGE_ID_PREFIX}${uuid}`
}

export type ProjectGraphEdgeOp =
  | {
      kind: 'add-edge'
      id: string
      projectId: string
      fromChatId: string
      toChatId: string
      now: number
    }
  | { kind: 'remove-edge'; id: string }

export function parseProjectGraphEdgeOp(value: unknown): ProjectGraphEdgeOp | null {
  if (!value || typeof value !== 'object') return null
  const op = value as Record<string, unknown>
  switch (op.kind) {
    case 'add-edge': {
      if (!isNonEmptyString(op.id) || !isNonEmptyString(op.projectId)) return null
      if (!isNonEmptyString(op.fromChatId) || !isNonEmptyString(op.toChatId)) return null
      if (!isFiniteNumber(op.now)) return null
      return {
        kind: 'add-edge',
        id: op.id,
        projectId: op.projectId,
        fromChatId: op.fromChatId.trim(),
        toChatId: op.toChatId.trim(),
        now: op.now
      }
    }
    case 'remove-edge': {
      if (!isNonEmptyString(op.id)) return null
      return { kind: 'remove-edge', id: op.id }
    }
    default:
      return null
  }
}

/**
 * Apply a graph-edge op. `projects` is consulted for referential integrity:
 * both endpoints must be current members of the target Project, and self-loops
 * are rejected. Adds are idempotent per (projectId, fromChatId, toChatId).
 */
export function applyProjectGraphEdgeOp(
  graphEdges: ProjectGraphEdge[],
  projects: Project[],
  op: ProjectGraphEdgeOp
): { graphEdges: ProjectGraphEdge[]; changed: boolean } {
  switch (op.kind) {
    case 'add-edge': {
      const project = projectById(projects, op.projectId)
      if (!project) throw new Error('Project not found.')
      const from = op.fromChatId.trim()
      const to = op.toChatId.trim()
      if (!from || !to) throw new Error('Edge endpoints are required.')
      if (from === to) throw new Error('An edge cannot connect a thread to itself.')
      if (!project.memberChatIds.includes(from) || !project.memberChatIds.includes(to)) {
        throw new Error('Both threads must be members of the project.')
      }
      const existing = graphEdges.find(
        (edge) =>
          edge.projectId === op.projectId && edge.fromChatId === from && edge.toChatId === to
      )
      if (existing) return { graphEdges, changed: false }
      const next: ProjectGraphEdge = {
        id: op.id,
        projectId: op.projectId,
        fromChatId: from,
        toChatId: to,
        kind: 'dependency',
        createdAt: op.now
      }
      return { graphEdges: [...graphEdges, next], changed: true }
    }
    case 'remove-edge': {
      const next = graphEdges.filter((edge) => edge.id !== op.id)
      if (next.length === graphEdges.length) throw new Error('Edge not found.')
      return { graphEdges: next, changed: true }
    }
    default: {
      const exhausted: never = op
      throw new Error(
        `Unknown project graph edge op: ${String((exhausted as { kind?: string }).kind)}`
      )
    }
  }
}

/**
 * Read-time integrity for stored edges: drop entries whose project is gone,
 * whose endpoints are not BOTH current members, or that self-loop/duplicate.
 */
export function migrateProjectGraphEdges(
  candidates: unknown[],
  projects: Project[],
  now: number
): ProjectGraphEdge[] {
  const projectMap = new Map(projects.map((project) => [project.id, project]))
  const seenIds = new Set<string>()
  const dedupe = new Set<string>()
  const edges: ProjectGraphEdge[] = []
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    const entry = candidate as Partial<ProjectGraphEdge>
    if (typeof entry.id !== 'string' || !entry.id.trim()) continue
    if (seenIds.has(entry.id)) continue
    if (typeof entry.projectId !== 'string') continue
    const project = projectMap.get(entry.projectId)
    if (!project) continue
    if (typeof entry.fromChatId !== 'string' || typeof entry.toChatId !== 'string') continue
    const from = entry.fromChatId.trim()
    const to = entry.toChatId.trim()
    if (!from || !to || from === to) continue
    if (!project.memberChatIds.includes(from) || !project.memberChatIds.includes(to)) continue
    const dedupeKey = `${entry.projectId} ${from} ${to}`
    if (dedupe.has(dedupeKey)) continue
    seenIds.add(entry.id)
    dedupe.add(dedupeKey)
    edges.push({
      id: entry.id,
      projectId: entry.projectId,
      fromChatId: from,
      toChatId: to,
      kind: 'dependency',
      createdAt:
        typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt)
          ? entry.createdAt
          : now
    })
  }
  return edges
}

/**
 * Drop stored edges that reference a removed chat (either endpoint). Scoped to
 * one project when `projectId` is given (a chat left a single project), else
 * app-wide (a chat was deleted everywhere).
 */
export function pruneProjectGraphEdgesForChat(
  graphEdges: ProjectGraphEdge[],
  chatId: string,
  projectId?: string
): ProjectGraphEdge[] {
  return graphEdges.filter((edge) => {
    if (projectId !== undefined && edge.projectId !== projectId) return true
    return edge.fromChatId !== chatId && edge.toChatId !== chatId
  })
}
