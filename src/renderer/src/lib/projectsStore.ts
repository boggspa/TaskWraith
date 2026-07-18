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
  applySetProjectArchived,
  applySetProjectIconAndHue,
  cloneProject,
  cloneProjectReference,
  cloneProjectWorkProfile,
  migrateProjectReferences,
  migrateProjectWorkProfiles,
  migrateProjects,
  newProjectId,
  newProjectReferenceId,
  projectById,
  sortProjectsForDisplay,
  type Project,
  type ProjectInput,
  type ProjectOp,
  type ProjectPatch,
  type ProjectReference,
  type ProjectReferenceContextPolicy,
  type ProjectReferenceKind,
  type ProjectWorkProfile
} from '../../../shared/projects'

/**
 * Renderer Projects store: a SYNCHRONOUS facade over the main-owned
 * ProjectRegistry.
 *
 * The public API (sync reads, sync mutations that return records, throwing
 * validation) predates the registry and every consumer relies on it, so the
 * facade keeps an in-memory snapshot and applies each mutation OPTIMISTICALLY
 * with the same shared functions main applies authoritatively — identical
 * logic plus seeded ops (id / now / defaultHue travel inside the op) means
 * both sides deterministically converge. The op is then dispatched over IPC;
 * main persists, and its `projects-changed` broadcast / invoke result
 * reconciles us.
 *
 * Reconciliation rule: an authoritative payload is adopted only when NO ops
 * are in flight (`pendingOpCount === 0`). Adopting mid-flight would rewind
 * optimistic ops that main hasn't echoed yet; the final op's own
 * resolve/reject always closes the gap (rejects resync from a fresh
 * snapshot).
 *
 * Legacy migration: project records historically lived in localStorage under
 * PROJECTS_STORAGE_KEY. On first hydrate the facade hands that raw payload to
 * main (one-shot, idempotent there) and replaces it with a tombstone ONLY
 * after main acks — the ack-before-tombstone ordering is what makes a crashed
 * import retryable instead of data loss. Old builds parse the tombstone as
 * non-array and safely see an empty store.
 *
 * Without a preload bridge (renderToStaticMarkup tests, storybook-style
 * rendering) the facade degrades to a pure in-memory store: optimistic applies
 * still work, nothing persists.
 */

const STORAGE_KEY = 'taskwraith-sidebar-projects'

export const PROJECTS_STORAGE_KEY = STORAGE_KEY

export type {
  Project,
  ProjectIcon,
  ProjectInput,
  ProjectReference,
  ProjectReferenceContextPolicy,
  ProjectReferenceKind,
  ProjectWorkProfile
} from '../../../shared/projects'

type ProjectsBridge = Window['api']

let snapshot: Project[] = []
let workProfiles: ProjectWorkProfile[] = []
let references: ProjectReference[] = []
let pendingOpCount = 0
let initPromise: Promise<void> | null = null
let unsubscribeBroadcast: (() => void) | null = null

const projectListeners = new Set<() => void>()

function bridge(): ProjectsBridge | undefined {
  return typeof window !== 'undefined' ? window.api : undefined
}

/**
 * Electron wraps a rejected invoke as
 * "Error invoking remote method '<channel>': Error: <real message>".
 * Every async facade mutation rethrows through this so UI alerts show the
 * real validation message, not the transport framing.
 */
export function normalizeBridgeError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  const match = message.match(/^Error invoking remote method '[^']*': (?:Error: )?([\s\S]*)$/)
  return new Error(match?.[1]?.trim() ? match[1].trim() : message)
}

async function invokeBridge<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw normalizeBridgeError(error)
  }
}

function notifyProjectListeners(): void {
  for (const listener of [...projectListeners]) {
    try {
      listener()
    } catch {
      // Subscriber exceptions must not block the store.
    }
  }
}

/**
 * Adopt authoritative registry state from main (snapshot fetch, op/claim
 * result, or broadcast). Skipped while ops are in flight — see module doc.
 * Accepts the `{ projects, workProfiles }` state object or a bare project
 * array (a payload without profiles leaves the current profiles untouched).
 */
function adoptAuthoritative(payload: unknown): void {
  if (pendingOpCount > 0) return
  let projectsCandidate: unknown = payload
  let profilesCandidate: unknown
  let referencesCandidate: unknown
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const state = payload as {
      projects?: unknown
      workProfiles?: unknown
      references?: unknown
    }
    projectsCandidate = state.projects
    profilesCandidate = state.workProfiles
    referencesCandidate = state.references
  }
  if (!Array.isArray(projectsCandidate)) return
  const now = Date.now()
  const nextProjects = migrateProjects(projectsCandidate, now)
  const validIds = new Set(nextProjects.map((project) => project.id))
  const nextProfiles = Array.isArray(profilesCandidate)
    ? migrateProjectWorkProfiles(profilesCandidate, validIds, now)
    : workProfiles
  const nextReferences = Array.isArray(referencesCandidate)
    ? migrateProjectReferences(referencesCandidate, validIds, now)
    : references
  if (
    JSON.stringify(nextProjects) === JSON.stringify(snapshot) &&
    JSON.stringify(nextProfiles) === JSON.stringify(workProfiles) &&
    JSON.stringify(nextReferences) === JSON.stringify(references)
  ) {
    return
  }
  snapshot = nextProjects
  workProfiles = nextProfiles
  references = nextReferences
  notifyProjectListeners()
}

function isLegacyTombstoneRaw(raw: string): boolean {
  try {
    const value = JSON.parse(raw) as { migratedToMain?: unknown } | null
    return (
      !!value && typeof value === 'object' && !Array.isArray(value) && value.migratedToMain === true
    )
  } catch {
    return false
  }
}

function writeLegacyTombstone(): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ schemaVersion: 1, migratedToMain: true, migratedAt: Date.now() })
    )
  } catch {
    // Best effort — the main-side marker already prevents a double import,
    // and the next boot retries the tombstone.
  }
}

function readLegacyRaw(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

/**
 * One-shot localStorage → registry handover. Ordering is the contract:
 * import ack FIRST, tombstone SECOND. An invoke failure leaves the legacy
 * payload untouched for the next boot; a tombstone-write failure is healed
 * next boot via the main-side marker.
 */
async function runLegacyMigrationHandshake(
  api: NonNullable<ProjectsBridge>,
  markerPresent: boolean
): Promise<void> {
  const raw = readLegacyRaw()
  if (raw === null || isLegacyTombstoneRaw(raw)) return
  if (markerPresent) {
    // A previous session imported but its tombstone write never landed.
    writeLegacyTombstone()
    return
  }
  if (typeof api.importLegacyProjects !== 'function') return
  const result = await api.importLegacyProjects(raw)
  if (!result) return
  writeLegacyTombstone()
  if (typeof api.getProjectsSnapshot === 'function') {
    try {
      adoptAuthoritative(await api.getProjectsSnapshot())
    } catch {
      // The projects-changed broadcast already carried the imported records.
    }
  }
}

function ensureInitialized(): Promise<void> {
  if (initPromise) return initPromise
  const api = bridge()
  if (!api || typeof api.getProjectsSnapshot !== 'function') {
    // Headless render: stay a pure in-memory store.
    initPromise = Promise.resolve()
    return initPromise
  }
  if (!unsubscribeBroadcast && typeof api.onProjectsChanged === 'function') {
    unsubscribeBroadcast = api.onProjectsChanged((projects) => adoptAuthoritative(projects))
  }
  initPromise = (async () => {
    try {
      const snap = await api.getProjectsSnapshot()
      adoptAuthoritative(snap)
      await runLegacyMigrationHandshake(api, Boolean(snap?.legacyImportMarker))
    } catch (error) {
      console.error('Projects store hydrate failed', error)
    }
  })()
  return initPromise
}

/** Exposed for tests and any boot path that wants to await hydration. */
export function whenProjectsStoreReady(): Promise<void> {
  return ensureInitialized()
}

/** Test seam: module state survives across specs otherwise. */
export function resetProjectsStoreForTests(): void {
  snapshot = []
  workProfiles = []
  references = []
  pendingOpCount = 0
  initPromise = null
  unsubscribeBroadcast?.()
  unsubscribeBroadcast = null
  projectListeners.clear()
}

function dispatchOp(op: ProjectOp): void {
  const api = bridge()
  if (!api || typeof api.applyProjectOp !== 'function') return
  pendingOpCount += 1
  void api.applyProjectOp(op).then(
    (result) => {
      pendingOpCount -= 1
      adoptAuthoritative(result)
    },
    (error) => {
      pendingOpCount -= 1
      console.error('Project op rejected by main; resyncing', error)
      if (typeof api.getProjectsSnapshot === 'function') {
        void api
          .getProjectsSnapshot()
          .then((snap) => adoptAuthoritative(snap))
          .catch(() => {})
      }
    }
  )
}

export function subscribeProjects(listener: () => void): () => void {
  void ensureInitialized()
  projectListeners.add(listener)
  return () => {
    projectListeners.delete(listener)
  }
}

export function listProjects(): Project[] {
  void ensureInitialized()
  return sortProjectsForDisplay(snapshot.map(cloneProject))
}

export function getProject(projectId: string): Project | null {
  if (!projectId) return null
  void ensureInitialized()
  const project = projectById(snapshot, projectId)
  return project ? cloneProject(project) : null
}

export function listProjectWorkProfiles(): ProjectWorkProfile[] {
  void ensureInitialized()
  return workProfiles.map(cloneProjectWorkProfile)
}

export function getProjectWorkProfile(projectId: string): ProjectWorkProfile | null {
  if (!projectId) return null
  void ensureInitialized()
  const profile = workProfiles.find((entry) => entry.projectId === projectId)
  return profile ? cloneProjectWorkProfile(profile) : null
}

/**
 * The home-chat claim. Deliberately ASYNC and non-optimistic, unlike the
 * list mutations: claims are rare, main enforces one-home-per-chat against
 * authoritative state, and an optimistic twin would need that uniqueness
 * check locally without the authority to make it. Callers await the result;
 * validation errors ('Chat is already the home of another project.', …)
 * propagate for the UI to surface.
 */
export async function setProjectHomeChat(
  projectId: string,
  chatId: string | null
): Promise<void> {
  await ensureInitialized()
  const api = bridge()
  if (!api || typeof api.setProjectHomeChat !== 'function') {
    throw new Error('Project home chats need the desktop bridge.')
  }
  const result = await invokeBridge(() => api.setProjectHomeChat(projectId, chatId))
  adoptAuthoritative(result)
}

/** Update the user-authored profile fields (brief, preferred workspace).
 * Same contract as the claim: async, main-authoritative, no optimistic twin. */
export async function updateProjectWorkProfile(
  projectId: string,
  patch: { brief?: string | null; preferredWorkspaceId?: string | null }
): Promise<void> {
  await ensureInitialized()
  const api = bridge()
  if (!api || typeof api.updateProjectWorkProfile !== 'function') {
    throw new Error('Project profiles need the desktop bridge.')
  }
  const result = await invokeBridge(() => api.updateProjectWorkProfile(projectId, patch))
  adoptAuthoritative(result)
}

export function listProjectReferences(projectId?: string): ProjectReference[] {
  void ensureInitialized()
  const source = projectId
    ? references.filter((reference) => reference.projectId === projectId)
    : references
  return source.map(cloneProjectReference)
}

/** Reference-library mutations mirror the claim: ASYNC, main-authoritative,
 * no optimistic twin (they're rare and their validation — project existence,
 * dedupe — belongs to main). Rejections propagate for the UI. A reference is
 * catalogue metadata ONLY; nothing here grants or reads anything. */
export async function addProjectReference(input: {
  projectId: string
  kind: ProjectReferenceKind
  locator: string
  title?: string
}): Promise<void> {
  await ensureInitialized()
  const api = bridge()
  if (!api || typeof api.applyProjectReferenceOp !== 'function') {
    throw new Error('Project references need the desktop bridge.')
  }
  const result = await invokeBridge(() =>
    api.applyProjectReferenceOp({
      kind: 'add-reference',
      id: newProjectReferenceId(),
      projectId: input.projectId,
      referenceKind: input.kind,
      locator: input.locator,
      ...(input.title !== undefined ? { title: input.title } : {}),
      now: Date.now()
    })
  )
  adoptAuthoritative(result)
}

export async function updateProjectReference(
  id: string,
  patch: { title?: string; contextPolicy?: ProjectReferenceContextPolicy }
): Promise<void> {
  await ensureInitialized()
  const api = bridge()
  if (!api || typeof api.applyProjectReferenceOp !== 'function') {
    throw new Error('Project references need the desktop bridge.')
  }
  const result = await invokeBridge(() =>
    api.applyProjectReferenceOp({ kind: 'update-reference', id, patch, now: Date.now() })
  )
  adoptAuthoritative(result)
}

export async function removeProjectReference(id: string): Promise<void> {
  await ensureInitialized()
  const api = bridge()
  if (!api || typeof api.applyProjectReferenceOp !== 'function') {
    throw new Error('Project references need the desktop bridge.')
  }
  const result = await invokeBridge(() => api.applyProjectReferenceOp({ kind: 'remove-reference', id }))
  adoptAuthoritative(result)
}

/** Explicit, user-triggered availability check — main runs a single stat and
 * records the result; browse surfaces only ever show last-known state. */
export async function verifyProjectReference(id: string): Promise<void> {
  await ensureInitialized()
  const api = bridge()
  if (!api || typeof api.verifyProjectReference !== 'function') {
    throw new Error('Project references need the desktop bridge.')
  }
  const result = await invokeBridge(() => api.verifyProjectReference(id))
  adoptAuthoritative(result)
}

export function createProject(input: ProjectInput): Project {
  void ensureInitialized()
  const id = newProjectId()
  const op: ProjectOp = {
    kind: 'create',
    input,
    id,
    now: Date.now(),
    defaultHue: agentIdenticonHash(id) % 360
  }
  const { projects: next, project } = applyCreateProject(snapshot, op.input, {
    id: op.id,
    now: op.now,
    defaultHue: op.defaultHue
  })
  snapshot = next
  notifyProjectListeners()
  dispatchOp(op)
  return cloneProject(project)
}

export function renameProject(projectId: string, name: string): Project {
  void ensureInitialized()
  const now = Date.now()
  const { projects: next, project } = applyRenameProject(snapshot, projectId, name, now)
  if (next !== snapshot) {
    snapshot = next
    notifyProjectListeners()
    dispatchOp({ kind: 'rename', projectId, name, now })
  }
  return cloneProject(project)
}

export function deleteProject(projectId: string): void {
  void ensureInitialized()
  snapshot = applyDeleteProject(snapshot, projectId)
  notifyProjectListeners()
  dispatchOp({ kind: 'delete', projectId })
}

export function reorderProject(projectId: string, order: number): Project {
  void ensureInitialized()
  const now = Date.now()
  const { projects: next, project } = applyReorderProject(snapshot, projectId, order, now)
  if (next !== snapshot) {
    snapshot = next
    notifyProjectListeners()
    dispatchOp({ kind: 'reorder', projectId, order, now })
  }
  return cloneProject(project)
}

export function moveProject(projectId: string, parentId: string | null, order?: number): Project {
  void ensureInitialized()
  const now = Date.now()
  const { projects: next, project } = applyMoveProject(snapshot, projectId, parentId, order, now)
  if (next !== snapshot) {
    snapshot = next
    notifyProjectListeners()
    dispatchOp({ kind: 'move', projectId, parentId, ...(order !== undefined ? { order } : {}), now })
  }
  return cloneProject(project)
}

export function setProjectArchived(projectId: string, archived: boolean): Project {
  void ensureInitialized()
  const now = Date.now()
  const { projects: next, project } = applySetProjectArchived(snapshot, projectId, archived, now)
  if (next !== snapshot) {
    snapshot = next
    notifyProjectListeners()
    dispatchOp({ kind: 'set-archived', projectId, archived, now })
  }
  return cloneProject(project)
}

export function setProjectIconAndHue(projectId: string, patch: ProjectPatch): Project {
  void ensureInitialized()
  const now = Date.now()
  const { projects: next, project } = applySetProjectIconAndHue(snapshot, projectId, patch, now)
  if (next !== snapshot) {
    snapshot = next
    notifyProjectListeners()
    dispatchOp({ kind: 'set-icon-hue', projectId, patch, now })
  }
  return cloneProject(project)
}

export function addChatToProject(projectId: string, chatId: string): Project {
  void ensureInitialized()
  const now = Date.now()
  const { projects: next, project } = applyAddChatToProject(snapshot, projectId, chatId, now)
  if (next !== snapshot) {
    snapshot = next
    notifyProjectListeners()
    dispatchOp({ kind: 'add-chat', projectId, chatId, now })
  }
  return cloneProject(project)
}

export function removeChatFromProject(projectId: string, chatId: string): Project {
  void ensureInitialized()
  const now = Date.now()
  const { projects: next, project } = applyRemoveChatFromProject(snapshot, projectId, chatId, now)
  if (next !== snapshot) {
    snapshot = next
    notifyProjectListeners()
    dispatchOp({ kind: 'remove-chat', projectId, chatId, now })
  }
  return cloneProject(project)
}

/**
 * Remove a chat id from every project's membership.
 *
 * NOT part of the chat-deletion flow anymore: main reconciles membership
 * itself at the AppStore.deleteChat / clearChats choke points (covering the
 * reaper, clear-chats, and iOS-bridge deletes the renderer never sees) and
 * broadcasts `projects-changed`. The App.tsx delete path used to call this as
 * belt-and-braces; that call was removed because main coverage is total and
 * secondary windows could never dispatch project ops anyway
 * (`projects:apply-op` is main-renderer-only). This wrapper stays as the
 * explicit UI-level lever for the same op — unlike the other mutations it
 * ALWAYS dispatches, so it can clean authoritative membership even when the
 * local snapshot isn't hydrated. Main's apply is a persisted no-op when
 * nothing references the chat.
 */
export function removeChatFromAllProjects(chatId: string): number {
  void ensureInitialized()
  const now = Date.now()
  const { projects: next, changedCount } = applyRemoveChatFromAllProjects(snapshot, chatId, now)
  if (changedCount > 0) {
    snapshot = next
    notifyProjectListeners()
  }
  dispatchOp({ kind: 'remove-chat-everywhere', chatId, now })
  return changedCount
}
