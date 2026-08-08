/**
 * Project Studio-lite companion artifacts (P2).
 *
 * Keepable office-research drafts (briefing / FAQ / decision-log) synthesized
 * from consentful P1 extracts. Companion meta lives in userData; markdown
 * bodies live under the workspace project-library tree.
 */

export const PROJECT_STUDIO_SCHEMA_VERSION = 1

export const MAX_PROJECT_STUDIO_ID_LENGTH = 256
export const MAX_PROJECT_STUDIO_TITLE_LENGTH = 240
export const MAX_PROJECT_STUDIO_SLUG_LENGTH = 120
export const MAX_PROJECT_STUDIO_PATH_LENGTH = 1024
export const MAX_PROJECT_STUDIO_SOURCE_IDS = 32
export const PROJECT_STUDIO_PER_SOURCE_EXCERPT_CHARS = 2_400

export type ProjectStudioKind = 'briefing' | 'faq' | 'decision-log'

export type ProjectStudioStatus = 'draft' | 'saved' | 'discarded'

export interface ProjectStudioCompanionMeta {
  schemaVersion: 1
  id: string
  projectId: string
  kind: ProjectStudioKind
  status: ProjectStudioStatus
  title: string
  slug: string
  relativePath: string
  sourceReferenceIds: string[]
  chatId?: string
  createdAt: number
  updatedAt: number
  /** Catalogue reference id assigned when the draft is saved to the library. */
  referenceId?: string
  discardedAt?: number
}

export interface ProjectStudioSourceExcerpt {
  title: string
  locator?: string
  excerpt: string
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

export function parseProjectStudioKind(value: unknown): ProjectStudioKind | null {
  return value === 'briefing' || value === 'faq' || value === 'decision-log' ? value : null
}

export function parseProjectStudioStatus(value: unknown): ProjectStudioStatus | null {
  return value === 'draft' || value === 'saved' || value === 'discarded' ? value : null
}

export function slugifyProjectStudioTitle(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_PROJECT_STUDIO_SLUG_LENGTH)
  return slug || 'studio-artifact'
}

export function buildProjectStudioRelativePath(input: {
  projectId: string
  kind: ProjectStudioKind
  slug: string
  date: string
}): string {
  const projectId = boundedString(input.projectId, MAX_PROJECT_STUDIO_ID_LENGTH)
  const slug = boundedString(input.slug, MAX_PROJECT_STUDIO_SLUG_LENGTH)
  const date =
    typeof input.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : null
  if (!projectId || !slug || !date || !parseProjectStudioKind(input.kind)) {
    throw new Error('Invalid Project Studio path components.')
  }
  return `.taskwraith/project-library/${projectId}/studio/${input.kind}/${slug}-${date}.md`
}

function formatIsoDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

export function truncateProjectStudioExcerpt(
  text: string,
  maxChars = PROJECT_STUDIO_PER_SOURCE_EXCERPT_CHARS
): string {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

function renderSourcesSection(sources: readonly ProjectStudioSourceExcerpt[]): string {
  const lines = ['## Sources', '']
  if (sources.length === 0) {
    lines.push('_No sources attached._', '')
    return lines.join('\n')
  }
  for (const source of sources) {
    lines.push(`- ${source.title}`)
  }
  lines.push('')
  return lines.join('\n')
}

function renderBriefingMarkdown(
  title: string,
  sources: readonly ProjectStudioSourceExcerpt[]
): string {
  const body: string[] = [
    `# ${title}`,
    '',
    '_Office research briefing drafted from consented Project reference extracts. Edit freely before saving to the library._',
    '',
    '## Executive summary',
    '',
    'Synthesize the key takeaways from the source excerpts below. This section is a template placeholder for human/agent polish.',
    '',
    '## Findings by source',
    ''
  ]
  for (const source of sources) {
    body.push(`### ${source.title}`)
    body.push('')
    if (source.locator) body.push(`Locator: \`${source.locator}\``)
    if (source.locator) body.push('')
    body.push(source.excerpt || '_No extract text available._')
    body.push('')
  }
  body.push(renderSourcesSection(sources))
  return body.join('\n').trimEnd() + '\n'
}

function renderFaqMarkdown(title: string, sources: readonly ProjectStudioSourceExcerpt[]): string {
  const body: string[] = [
    `# ${title}`,
    '',
    '_FAQ drafted from consented Project reference extracts for office research follow-up._',
    '',
    '## Suggested Q&A',
    ''
  ]
  for (const source of sources) {
    body.push(`### From ${source.title}`)
    body.push('')
    body.push(`**Q:** What does “${source.title}” establish for this project?`)
    body.push('')
    body.push(`**A:** ${source.excerpt || '_Fill in after reviewing the source._'}`)
    body.push('')
  }
  body.push(renderSourcesSection(sources))
  return body.join('\n').trimEnd() + '\n'
}

function renderDecisionLogMarkdown(
  title: string,
  sources: readonly ProjectStudioSourceExcerpt[]
): string {
  const body: string[] = [
    `# ${title}`,
    '',
    '_Decision log drafted from consented Project reference extracts. Record choices, owners, and open questions._',
    '',
    '## Candidate decisions',
    ''
  ]
  for (const [index, source] of sources.entries()) {
    body.push(`### Decision ${index + 1} — informed by ${source.title}`)
    body.push('')
    body.push('- **Status:** proposed')
    body.push('- **Owner:** _TBD_')
    body.push(`- **Evidence:** ${source.excerpt || '_Attach extract excerpt._'}`)
    body.push('- **Decision:** _TBD_')
    body.push('')
  }
  body.push(renderSourcesSection(sources))
  return body.join('\n').trimEnd() + '\n'
}

export function renderProjectStudioMarkdown(input: {
  kind: ProjectStudioKind
  title: string
  sources: readonly ProjectStudioSourceExcerpt[]
}): string {
  const title = input.title.trim() || 'Untitled Studio artifact'
  const sources = input.sources.map((source) => ({
    title: source.title.trim() || 'Untitled source',
    ...(source.locator ? { locator: source.locator } : {}),
    excerpt: truncateProjectStudioExcerpt(source.excerpt)
  }))
  switch (input.kind) {
    case 'briefing':
      return renderBriefingMarkdown(title, sources)
    case 'faq':
      return renderFaqMarkdown(title, sources)
    case 'decision-log':
      return renderDecisionLogMarkdown(title, sources)
    default: {
      const _exhaustive: never = input.kind
      return _exhaustive
    }
  }
}

export function parseProjectStudioCompanionMeta(value: unknown): ProjectStudioCompanionMeta | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'schemaVersion',
      'id',
      'projectId',
      'kind',
      'status',
      'title',
      'slug',
      'relativePath',
      'sourceReferenceIds',
      'chatId',
      'createdAt',
      'updatedAt',
      'referenceId',
      'discardedAt'
    ]) ||
    value.schemaVersion !== PROJECT_STUDIO_SCHEMA_VERSION
  ) {
    return null
  }

  const id = boundedString(value.id, MAX_PROJECT_STUDIO_ID_LENGTH)
  const projectId = boundedString(value.projectId, MAX_PROJECT_STUDIO_ID_LENGTH)
  const kind = parseProjectStudioKind(value.kind)
  const status = parseProjectStudioStatus(value.status)
  const title = boundedString(value.title, MAX_PROJECT_STUDIO_TITLE_LENGTH)
  const slug = boundedString(value.slug, MAX_PROJECT_STUDIO_SLUG_LENGTH)
  const relativePath = boundedString(value.relativePath, MAX_PROJECT_STUDIO_PATH_LENGTH)
  const chatId = boundedOptionalString(value, 'chatId', MAX_PROJECT_STUDIO_ID_LENGTH)
  const createdAt = boundedTimestamp(value.createdAt)
  const updatedAt = boundedTimestamp(value.updatedAt)
  if (
    !id ||
    !projectId ||
    !kind ||
    !status ||
    !title ||
    !slug ||
    !relativePath ||
    chatId === null ||
    createdAt === null ||
    updatedAt === null ||
    !Array.isArray(value.sourceReferenceIds) ||
    value.sourceReferenceIds.length === 0 ||
    value.sourceReferenceIds.length > MAX_PROJECT_STUDIO_SOURCE_IDS
  ) {
    return null
  }

  const sourceReferenceIds: string[] = []
  for (const entry of value.sourceReferenceIds) {
    const referenceId = boundedString(entry, MAX_PROJECT_STUDIO_ID_LENGTH)
    if (!referenceId) return null
    sourceReferenceIds.push(referenceId)
  }

  let referenceId: string | undefined
  if ('referenceId' in value) {
    const parsed = boundedString(value.referenceId, MAX_PROJECT_STUDIO_ID_LENGTH)
    if (!parsed) return null
    referenceId = parsed
  }

  let discardedAt: number | undefined
  if ('discardedAt' in value) {
    const parsed = boundedTimestamp(value.discardedAt)
    if (parsed === null) return null
    discardedAt = parsed
  }

  if (status === 'saved' && !referenceId) return null
  if (status === 'discarded' && discardedAt === undefined) return null
  if (status === 'draft' && (referenceId || discardedAt !== undefined)) return null

  return {
    schemaVersion: 1,
    id,
    projectId,
    kind,
    status,
    title,
    slug,
    relativePath,
    sourceReferenceIds,
    ...(chatId ? { chatId } : {}),
    createdAt,
    updatedAt,
    ...(referenceId ? { referenceId } : {}),
    ...(discardedAt !== undefined ? { discardedAt } : {})
  }
}

export function projectStudioDateStamp(now = Date.now()): string {
  return formatIsoDate(now)
}
