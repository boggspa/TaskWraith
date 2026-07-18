import type { ProjectReferenceKind } from './projects'

export const MAX_PROJECT_REFERENCE_CONTEXT_ITEMS = 12
export const MAX_PROJECT_REFERENCE_CONTEXT_ID_LENGTH = 256
export const MAX_PROJECT_REFERENCE_CONTEXT_TITLE_LENGTH = 512
export const MAX_PROJECT_REFERENCE_CONTEXT_LOCATOR_LENGTH = 4096

/**
 * Renderer intent for the next committed send. This is deliberately only a
 * list of catalogue ids: main re-resolves every id against the authoritative
 * Project registry before anything can reach a provider.
 */
export interface ProjectReferenceContextSelection {
  schemaVersion: 1
  projectId: string
  referenceIds: string[]
}

export type ProjectReferenceContextAccess =
  | 'workspace'
  | 'external-grant'
  | 'catalogue-only'

export interface ResolvedProjectReferenceContextItem {
  id: string
  kind: ProjectReferenceKind
  title: string
  locator: string
  /**
   * Main's run-time access classification. `catalogue-only` is label-only:
   * it grants no filesystem/network access and produces no content snapshot.
   */
  access: ProjectReferenceContextAccess
}

/** Main-resolved, posture-signed context that is safe to dispatch. */
export interface ResolvedProjectReferenceContext {
  schemaVersion: 1
  projectId: string
  projectName: string
  references: ResolvedProjectReferenceContextItem[]
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength) return null
  return trimmed
}

function isProjectReferenceKind(value: unknown): value is ProjectReferenceKind {
  return value === 'file' || value === 'folder' || value === 'url'
}

function isContextAccess(value: unknown): value is ProjectReferenceContextAccess {
  return value === 'workspace' || value === 'external-grant' || value === 'catalogue-only'
}

/** Strict enough for the main trust boundary, deterministic enough to queue. */
export function parseProjectReferenceContextSelection(
  value: unknown
): ProjectReferenceContextSelection | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  if (input.schemaVersion !== 1) return null
  const projectId = boundedString(input.projectId, MAX_PROJECT_REFERENCE_CONTEXT_ID_LENGTH)
  if (!projectId || !Array.isArray(input.referenceIds)) return null
  if (
    input.referenceIds.length === 0 ||
    input.referenceIds.length > MAX_PROJECT_REFERENCE_CONTEXT_ITEMS
  ) {
    return null
  }
  const referenceIds: string[] = []
  const seen = new Set<string>()
  for (const candidate of input.referenceIds) {
    const id = boundedString(candidate, MAX_PROJECT_REFERENCE_CONTEXT_ID_LENGTH)
    if (!id) return null
    if (seen.has(id)) continue
    seen.add(id)
    referenceIds.push(id)
  }
  return referenceIds.length > 0 ? { schemaVersion: 1, projectId, referenceIds } : null
}

/**
 * Canonicalizes the resolved bundle after an IPC round trip. Any malformed
 * item invalidates the whole bundle; partially accepting a tampered selection
 * would make the signed disclosure differ from the user's chosen context.
 */
export function parseResolvedProjectReferenceContext(
  value: unknown
): ResolvedProjectReferenceContext | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  if (input.schemaVersion !== 1 || !Array.isArray(input.references)) return null
  const projectId = boundedString(input.projectId, MAX_PROJECT_REFERENCE_CONTEXT_ID_LENGTH)
  const projectName = boundedString(input.projectName, MAX_PROJECT_REFERENCE_CONTEXT_TITLE_LENGTH)
  if (
    !projectId ||
    !projectName ||
    input.references.length === 0 ||
    input.references.length > MAX_PROJECT_REFERENCE_CONTEXT_ITEMS
  ) {
    return null
  }
  const references: ResolvedProjectReferenceContextItem[] = []
  const seen = new Set<string>()
  for (const candidate of input.references) {
    if (!candidate || typeof candidate !== 'object') return null
    const item = candidate as Record<string, unknown>
    const id = boundedString(item.id, MAX_PROJECT_REFERENCE_CONTEXT_ID_LENGTH)
    const title = boundedString(item.title, MAX_PROJECT_REFERENCE_CONTEXT_TITLE_LENGTH)
    const locator = boundedString(item.locator, MAX_PROJECT_REFERENCE_CONTEXT_LOCATOR_LENGTH)
    if (
      !id ||
      !title ||
      !locator ||
      !isProjectReferenceKind(item.kind) ||
      !isContextAccess(item.access) ||
      seen.has(id)
    ) {
      return null
    }
    if (item.kind === 'url' && item.access !== 'catalogue-only') return null
    seen.add(id)
    references.push({ id, kind: item.kind, title, locator, access: item.access })
  }
  return { schemaVersion: 1, projectId, projectName, references }
}

/** Fixed-field serialization used when the main process binds the bundle. */
export function serializeResolvedProjectReferenceContext(
  value: ResolvedProjectReferenceContext
): string {
  return JSON.stringify({
    schemaVersion: 1,
    projectId: value.projectId,
    projectName: value.projectName,
    references: value.references.map((reference) => ({
      id: reference.id,
      kind: reference.kind,
      title: reference.title,
      locator: reference.locator,
      access: reference.access
    }))
  })
}

/** Locator-free projection suitable for transcript and run-event metadata. */
export function projectReferenceContextDisclosure(
  value: ResolvedProjectReferenceContext
): {
  schemaVersion: 1
  projectId: string
  projectName: string
  references: Array<Pick<ResolvedProjectReferenceContextItem, 'id' | 'kind' | 'title' | 'access'>>
} {
  return {
    schemaVersion: 1,
    projectId: value.projectId,
    projectName: value.projectName,
    references: value.references.map(({ id, kind, title, access }) => ({ id, kind, title, access }))
  }
}
