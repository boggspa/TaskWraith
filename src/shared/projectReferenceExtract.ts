/**
 * Consentful Project-reference extract records (P1).
 *
 * Catalogue rows stay metadata-only. An extract is a separate, revocable
 * project-scoped text artifact created only after explicit user consent.
 */

export const PROJECT_REFERENCE_EXTRACT_SCHEMA_VERSION = 1

export const MAX_PROJECT_REFERENCE_EXTRACT_ID_LENGTH = 256
export const MAX_PROJECT_REFERENCE_EXTRACT_LOCATOR_LENGTH = 4096
export const MAX_PROJECT_REFERENCE_EXTRACT_ERROR_CODE_LENGTH = 128
export const MAX_PROJECT_REFERENCE_EXTRACT_ERROR_MESSAGE_LENGTH = 2000
export const MAX_PROJECT_REFERENCE_EXTRACT_PAGE_MAP_LENGTH = 10_000

export type ProjectReferenceExtractKind = 'url-html' | 'pdf-text' | 'office-text' | 'plain-text'

export type ProjectReferenceExtractStatus = 'pending' | 'ready' | 'failed' | 'revoked' | 'stale'

export type ProjectReferenceExtractOfficeFormat = 'docx' | 'xlsx' | 'pptx' | 'md' | 'csv' | 'tsv'

export interface ProjectReferenceExtractConsent {
  at: number
  chatId?: string
  actor: 'user'
  scope: 'this-reference'
}

export interface ProjectReferenceExtractHttpSource {
  finalUrl: string
  status: number
  fetchedAt: number
}

export interface ProjectReferenceExtractPageRange {
  first: number
  last: number
}

export interface ProjectReferenceExtractSource {
  locator: string
  contentSha256?: string
  http?: ProjectReferenceExtractHttpSource
  pageRange?: ProjectReferenceExtractPageRange
  officeFormat?: ProjectReferenceExtractOfficeFormat
}

export interface ProjectReferenceExtractPageSpan {
  pageNumber: number
  startOffset: number
  endOffset: number
}

export interface ProjectReferenceExtractText {
  charCount: number
  truncated: boolean
  artifactSha256: string
  pages?: ProjectReferenceExtractPageSpan[]
}

export interface ProjectReferenceExtractError {
  code: string
  message: string
}

/**
 * Durable extract metadata. Text bytes live content-addressed in the main
 * extract store; this record never elevates catalogue access into a grant.
 */
export interface ProjectReferenceExtract {
  schemaVersion: 1
  id: string
  projectId: string
  referenceId: string
  kind: ProjectReferenceExtractKind
  status: ProjectReferenceExtractStatus
  consent: ProjectReferenceExtractConsent
  source: ProjectReferenceExtractSource
  text?: ProjectReferenceExtractText
  error?: ProjectReferenceExtractError
  createdAt: number
  updatedAt: number
  revokedAt?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed)
  return Object.keys(record).every((key) => allowedKeys.has(key))
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength) return null
  // Metadata is rendered and persisted. Exclude terminal/control and
  // bidi-isolate characters that could forge UI structure.
  for (const character of trimmed) {
    const codePoint = character.codePointAt(0) ?? 0
    if (
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      return null
    }
  }
  return trimmed
}

function boundedOptionalString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number
): string | null | undefined {
  if (!(key in record)) return undefined
  return boundedString(record[key], maxLength)
}

function boundedTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function boundedNonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function boundedPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null
}

function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value)
}

export function parseProjectReferenceExtractKind(
  value: unknown
): ProjectReferenceExtractKind | null {
  return value === 'url-html' ||
    value === 'pdf-text' ||
    value === 'office-text' ||
    value === 'plain-text'
    ? value
    : null
}

export function parseProjectReferenceExtractStatus(
  value: unknown
): ProjectReferenceExtractStatus | null {
  return value === 'pending' ||
    value === 'ready' ||
    value === 'failed' ||
    value === 'revoked' ||
    value === 'stale'
    ? value
    : null
}

function parseOfficeFormat(value: unknown): ProjectReferenceExtractOfficeFormat | null {
  return value === 'docx' ||
    value === 'xlsx' ||
    value === 'pptx' ||
    value === 'md' ||
    value === 'csv' ||
    value === 'tsv'
    ? value
    : null
}

export function parseProjectReferenceExtractConsent(
  value: unknown
): ProjectReferenceExtractConsent | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['at', 'chatId', 'actor', 'scope']) ||
    value.actor !== 'user' ||
    value.scope !== 'this-reference'
  ) {
    return null
  }
  const at = boundedTimestamp(value.at)
  const chatId = boundedOptionalString(value, 'chatId', MAX_PROJECT_REFERENCE_EXTRACT_ID_LENGTH)
  if (at === null || chatId === null) return null
  return {
    at,
    actor: 'user',
    scope: 'this-reference',
    ...(chatId ? { chatId } : {})
  }
}

function parseHttpSource(value: unknown): ProjectReferenceExtractHttpSource | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['finalUrl', 'status', 'fetchedAt'])) return null
  const finalUrl = boundedString(value.finalUrl, MAX_PROJECT_REFERENCE_EXTRACT_LOCATOR_LENGTH)
  const fetchedAt = boundedTimestamp(value.fetchedAt)
  const status =
    typeof value.status === 'number' &&
    Number.isSafeInteger(value.status) &&
    value.status >= 100 &&
    value.status <= 599
      ? value.status
      : null
  if (!finalUrl || fetchedAt === null || status === null) return null
  return { finalUrl, status, fetchedAt }
}

function parsePageRange(value: unknown): ProjectReferenceExtractPageRange | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['first', 'last'])) return null
  const first = boundedPositiveInt(value.first)
  const last = boundedPositiveInt(value.last)
  if (first === null || last === null || last < first) return null
  return { first, last }
}

export function parseProjectReferenceExtractSource(
  value: unknown
): ProjectReferenceExtractSource | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['locator', 'contentSha256', 'http', 'pageRange', 'officeFormat'])
  ) {
    return null
  }
  const locator = boundedString(value.locator, MAX_PROJECT_REFERENCE_EXTRACT_LOCATOR_LENGTH)
  if (!locator) return null

  let contentSha256: string | undefined
  if ('contentSha256' in value) {
    const digest = boundedString(value.contentSha256, 64)
    if (!digest || !isSha256Hex(digest)) return null
    contentSha256 = digest.toLowerCase()
  }

  let http: ProjectReferenceExtractHttpSource | undefined
  if ('http' in value) {
    const parsed = parseHttpSource(value.http)
    if (!parsed) return null
    http = parsed
  }

  let pageRange: ProjectReferenceExtractPageRange | undefined
  if ('pageRange' in value) {
    const parsed = parsePageRange(value.pageRange)
    if (!parsed) return null
    pageRange = parsed
  }

  let officeFormat: ProjectReferenceExtractOfficeFormat | undefined
  if ('officeFormat' in value) {
    const parsed = parseOfficeFormat(value.officeFormat)
    if (!parsed) return null
    officeFormat = parsed
  }

  return {
    locator,
    ...(contentSha256 ? { contentSha256 } : {}),
    ...(http ? { http } : {}),
    ...(pageRange ? { pageRange } : {}),
    ...(officeFormat ? { officeFormat } : {})
  }
}

function parsePageSpan(value: unknown): ProjectReferenceExtractPageSpan | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['pageNumber', 'startOffset', 'endOffset'])) {
    return null
  }
  const pageNumber = boundedPositiveInt(value.pageNumber)
  const startOffset = boundedNonNegativeInt(value.startOffset)
  const endOffset = boundedNonNegativeInt(value.endOffset)
  if (
    pageNumber === null ||
    startOffset === null ||
    endOffset === null ||
    endOffset < startOffset
  ) {
    return null
  }
  return { pageNumber, startOffset, endOffset }
}

export function parseProjectReferenceExtractText(
  value: unknown
): ProjectReferenceExtractText | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['charCount', 'truncated', 'artifactSha256', 'pages']) ||
    typeof value.truncated !== 'boolean'
  ) {
    return null
  }
  const charCount = boundedNonNegativeInt(value.charCount)
  const artifactSha256 = boundedString(value.artifactSha256, 64)
  if (charCount === null || !artifactSha256 || !isSha256Hex(artifactSha256)) return null

  let pages: ProjectReferenceExtractPageSpan[] | undefined
  if ('pages' in value) {
    if (
      !Array.isArray(value.pages) ||
      value.pages.length > MAX_PROJECT_REFERENCE_EXTRACT_PAGE_MAP_LENGTH
    ) {
      return null
    }
    pages = []
    for (const entry of value.pages) {
      const span = parsePageSpan(entry)
      if (!span) return null
      pages.push(span)
    }
  }

  return {
    charCount,
    truncated: value.truncated,
    artifactSha256: artifactSha256.toLowerCase(),
    ...(pages ? { pages } : {})
  }
}

export function parseProjectReferenceExtractError(
  value: unknown
): ProjectReferenceExtractError | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['code', 'message'])) return null
  const code = boundedString(value.code, MAX_PROJECT_REFERENCE_EXTRACT_ERROR_CODE_LENGTH)
  const message = boundedString(value.message, MAX_PROJECT_REFERENCE_EXTRACT_ERROR_MESSAGE_LENGTH)
  if (!code || !message) return null
  return { code, message }
}

export function parseProjectReferenceExtract(value: unknown): ProjectReferenceExtract | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'schemaVersion',
      'id',
      'projectId',
      'referenceId',
      'kind',
      'status',
      'consent',
      'source',
      'text',
      'error',
      'createdAt',
      'updatedAt',
      'revokedAt'
    ]) ||
    value.schemaVersion !== PROJECT_REFERENCE_EXTRACT_SCHEMA_VERSION
  ) {
    return null
  }

  const id = boundedString(value.id, MAX_PROJECT_REFERENCE_EXTRACT_ID_LENGTH)
  const projectId = boundedString(value.projectId, MAX_PROJECT_REFERENCE_EXTRACT_ID_LENGTH)
  const referenceId = boundedString(value.referenceId, MAX_PROJECT_REFERENCE_EXTRACT_ID_LENGTH)
  const kind = parseProjectReferenceExtractKind(value.kind)
  const status = parseProjectReferenceExtractStatus(value.status)
  const consent = parseProjectReferenceExtractConsent(value.consent)
  const source = parseProjectReferenceExtractSource(value.source)
  const createdAt = boundedTimestamp(value.createdAt)
  const updatedAt = boundedTimestamp(value.updatedAt)
  if (
    !id ||
    !projectId ||
    !referenceId ||
    !kind ||
    !status ||
    !consent ||
    !source ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null
  }

  let text: ProjectReferenceExtractText | undefined
  if ('text' in value) {
    const parsed = parseProjectReferenceExtractText(value.text)
    if (!parsed) return null
    text = parsed
  }

  let error: ProjectReferenceExtractError | undefined
  if ('error' in value) {
    const parsed = parseProjectReferenceExtractError(value.error)
    if (!parsed) return null
    error = parsed
  }

  let revokedAt: number | undefined
  if ('revokedAt' in value) {
    const parsed = boundedTimestamp(value.revokedAt)
    if (parsed === null) return null
    revokedAt = parsed
  }

  if (status === 'ready' && !text) return null
  if (status === 'failed' && !error) return null
  if (status === 'pending' && (text || error || revokedAt !== undefined)) return null
  if (status === 'revoked' && revokedAt === undefined) return null

  return {
    schemaVersion: 1,
    id,
    projectId,
    referenceId,
    kind,
    status,
    consent,
    source,
    ...(text ? { text } : {}),
    ...(error ? { error } : {}),
    createdAt,
    updatedAt,
    ...(revokedAt !== undefined ? { revokedAt } : {})
  }
}
