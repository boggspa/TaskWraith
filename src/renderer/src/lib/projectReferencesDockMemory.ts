import { writeDockSurface } from './rightDockPersistence'

const STORAGE_KEY = 'taskwraith.work.referencesDockAutoOpened.v1'
export const PROJECT_REFERENCES_AUTO_OPEN_MIN_WIDTH = 980
const openedThisSession = new Set<string>()

function readProjectIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(
      parsed.filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0
      )
    )
  } catch {
    return new Set()
  }
}

/**
 * Per-device durable memory for the one automatic References-dock reveal each
 * Project receives. This is view chrome, not Project data, so it deliberately
 * stays out of the main-owned ProjectWorkProfile registry.
 */
export function hasAutoOpenedProjectReferences(projectId: string | null | undefined): boolean {
  const normalized = projectId?.trim()
  return Boolean(
    normalized && (openedThisSession.has(normalized) || readProjectIds().has(normalized))
  )
}

export function markProjectReferencesAutoOpened(projectId: string | null | undefined): void {
  const normalized = projectId?.trim()
  if (!normalized) return
  openedThisSession.add(normalized)
  try {
    const ids = readProjectIds()
    if (ids.has(normalized)) return
    ids.add(normalized)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids].sort()))
  } catch {
    // Best-effort device chrome. A blocked store may auto-open again later.
  }
}

/** Manual and automatic opens share one atomic chrome receipt. Persisting the
 * Work destination explicitly matters when the previous Project already had
 * the same active tab and React therefore has no tab-state change to observe. */
export function rememberProjectReferencesDockOpened(
  projectId: string | null | undefined
): void {
  const normalized = projectId?.trim()
  if (!normalized) return
  markProjectReferencesAutoOpened(normalized)
  writeDockSurface({ kind: 'work', projectId: normalized }, 'references')
}

export function resetProjectReferencesDockMemoryForTests(): void {
  openedThisSession.clear()
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Test seam only.
  }
}

/** @deprecated Prefer {@link shouldPinProjectReferencesOnWorkRoute}. */
export function shouldAutoOpenProjectReferences(input: {
  activeSidebarTab: string | null | undefined
  projectId: string | null | undefined
  viewportWidth: number
  hasSavedDockSurface?: boolean
}): boolean {
  return shouldPinProjectReferencesOnWorkRoute(input)
}

/** Work tab always exposes the References dock — no width, once-per-project, or saved-surface gate. */
export function shouldPinProjectReferencesOnWorkRoute(input: {
  activeSidebarTab: string | null | undefined
}): boolean {
  return input.activeSidebarTab === 'projects'
}

export type WorkRouteReferencesPinAction = {
  openPanel: boolean
  activateTab: 'references' | null
}

/** Work-route pin opens References and selects it as the active dock pane. A saved
 *  non-References surface (media, files, etc.) must not suppress that default. */
export function resolveWorkRouteReferencesPin(input: {
  activeSidebarTab: string | null | undefined
  savedDockSurface?: string | null
}): WorkRouteReferencesPinAction {
  if (!shouldPinProjectReferencesOnWorkRoute(input)) {
    return { openPanel: false, activateTab: null }
  }
  void input.savedDockSurface
  return { openPanel: true, activateTab: 'references' }
}
