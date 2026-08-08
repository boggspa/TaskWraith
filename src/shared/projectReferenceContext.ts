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

export type ProjectReferenceContextAccess = 'workspace' | 'external-grant' | 'catalogue-only'

/**
 * Consentful extract metadata attached at Use-next resolve time.
 * Bodies stay out of this posture payload — only digests bind the disclosure.
 */
export interface ResolvedProjectReferenceContextExtract {
  extractId: string
  status: 'ready'
  charCount: number
  truncated: boolean
  /** sha256 hex of the durable extract text (not the injected prompt body). */
  contentDigest: string
}

export interface ResolvedProjectReferenceContextItem {
  id: string
  kind: ProjectReferenceKind
  title: string
  locator: string
  /**
   * Main's run-time access classification. `catalogue-only` is label-only:
   * it grants no filesystem/network access and produces no content snapshot.
   * A ready extract never widens this into a live fetch/path grant.
   */
  access: ProjectReferenceContextAccess
  /** Present only when an active ready extract exists for this reference. */
  extract?: ResolvedProjectReferenceContextExtract
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
  return value === 'file' || value === 'folder' || value === 'url' || value === 'connector'
}

function isContextAccess(value: unknown): value is ProjectReferenceContextAccess {
  return value === 'workspace' || value === 'external-grant' || value === 'catalogue-only'
}

function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value)
}

function parseResolvedExtract(value: unknown): ResolvedProjectReferenceContextExtract | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  const extractId = boundedString(input.extractId, MAX_PROJECT_REFERENCE_CONTEXT_ID_LENGTH)
  const contentDigest = boundedString(input.contentDigest, 64)
  const charCount =
    typeof input.charCount === 'number' &&
    Number.isSafeInteger(input.charCount) &&
    input.charCount >= 0
      ? input.charCount
      : null
  if (
    !extractId ||
    input.status !== 'ready' ||
    charCount === null ||
    typeof input.truncated !== 'boolean' ||
    !contentDigest ||
    !isSha256Hex(contentDigest.toLowerCase())
  ) {
    return null
  }
  return {
    extractId,
    status: 'ready',
    charCount,
    truncated: input.truncated,
    contentDigest: contentDigest.toLowerCase()
  }
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
    if ((item.kind === 'url' || item.kind === 'connector') && item.access !== 'catalogue-only') {
      return null
    }
    let extract: ResolvedProjectReferenceContextExtract | undefined
    if ('extract' in item) {
      const parsedExtract = parseResolvedExtract(item.extract)
      if (!parsedExtract) return null
      extract = parsedExtract
    }
    seen.add(id)
    references.push({
      id,
      kind: item.kind,
      title,
      locator,
      access: item.access,
      ...(extract ? { extract } : {})
    })
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
      access: reference.access,
      ...(reference.extract
        ? {
            extract: {
              extractId: reference.extract.extractId,
              status: reference.extract.status,
              charCount: reference.extract.charCount,
              truncated: reference.extract.truncated,
              contentDigest: reference.extract.contentDigest
            }
          }
        : {})
    }))
  })
}

/** Locator-free projection suitable for transcript and run-event metadata. */
export function projectReferenceContextDisclosure(value: ResolvedProjectReferenceContext): {
  schemaVersion: 1
  projectId: string
  projectName: string
  references: Array<
    Pick<ResolvedProjectReferenceContextItem, 'id' | 'kind' | 'title' | 'access'> & {
      extract?: Pick<
        ResolvedProjectReferenceContextExtract,
        'extractId' | 'status' | 'charCount' | 'truncated'
      >
    }
  >
} {
  return {
    schemaVersion: 1,
    projectId: value.projectId,
    projectName: value.projectName,
    references: value.references.map(({ id, kind, title, access, extract }) => ({
      id,
      kind,
      title,
      access,
      ...(extract
        ? {
            extract: {
              extractId: extract.extractId,
              status: extract.status,
              charCount: extract.charCount,
              truncated: extract.truncated
            }
          }
        : {})
    }))
  }
}
