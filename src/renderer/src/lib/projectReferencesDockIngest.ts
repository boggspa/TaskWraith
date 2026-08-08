import { normalizeGitHubReferenceInput } from '../../../shared/projects'

export type DockIngestCandidate =
  | { kind: 'file' | 'folder'; locator: string }
  | { kind: 'url'; locator: string }
  | { kind: 'connector'; locator: string }

function isPortableAbsolutePath(value: string): boolean {
  return (
    value.startsWith('/') ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.startsWith('\\\\') ||
    value.startsWith('//')
  )
}

function hasDotDotSegment(value: string): boolean {
  return value.split(/[\\/]+/).includes('..')
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.username &&
      !parsed.password
    )
  } catch {
    return false
  }
}

export function classifyPastedReferenceText(text: string): DockIngestCandidate | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  // Prefer GitHub connector classification, but never let shorthand steal an
  // absolute path (normalizeGitHub strips a leading / and can accept it).
  if (!isPortableAbsolutePath(trimmed)) {
    const github = normalizeGitHubReferenceInput(trimmed)
    if (github) return { kind: 'connector', locator: github }
  }

  if (isSafeHttpUrl(trimmed)) return { kind: 'url', locator: trimmed }

  if (isPortableAbsolutePath(trimmed)) {
    if (hasDotDotSegment(trimmed)) return null
    return { kind: 'file', locator: trimmed }
  }

  return null
}

export function classifyDroppedPath(
  path: string,
  isDirectory: boolean
): DockIngestCandidate | null {
  const trimmed = path.trim()
  if (!trimmed) return null
  if (!isPortableAbsolutePath(trimmed) || hasDotDotSegment(trimmed)) return null
  return { kind: isDirectory ? 'folder' : 'file', locator: trimmed }
}
