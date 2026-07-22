export type GeminiPermissionRequest = {
  kind: 'attachment_access' | 'workspace_trust' | 'tool_permission'
  message: string
  paths: string[]
  source: 'structured' | 'text'
}

const STRICT_PERMISSION_PHRASES = [
  /\bapproval required\b/i,
  /\bpermission required\b/i,
  /\brequires confirmation\b/i,
  /\btool approval\b/i,
  /\baccess denied\b/i,
  /\bgrant access\b/i,
  /\ballow access\b/i,
  /\brequires access to\b/i,
  /\bneeds access to\b/i,
  /\boutside (?:the )?workspace\b/i,
  /\bnot (?:in|under|inside) (?:the )?workspace\b/i,
  /\binclude-directories\b/i,
  /\buntrusted workspace\b/i,
  /\btrust workspace\b/i
]

const PATH_KEYS = new Set([
  'file',
  'filePath',
  'file_path',
  'filename',
  'path',
  'paths',
  'directory',
  'directories',
  'includeDirectories',
  'include_directories',
  'requestedPath',
  'requested_path',
  'requestedPaths',
  'requested_paths'
])

const MESSAGE_KEYS = [
  'message',
  'error',
  'reason',
  'details',
  'detail',
  'description',
  'stderr',
  'content'
]

const sanitizePath = (value: string): string => {
  return value
    .trim()
    .replace(/^\s*["'`]|["'`]\s*$/g, '')
    .replace(/[)\]}.,;:!?`]+$/g, '')
}

const hasLikelyFileName = (value: string): boolean => {
  return /(?:^|[/\\])[^/\\]+\.[A-Za-z0-9]{1,12}(?:$|[?#])/.test(value)
}

const looksLikeRealFilePath = (value: string): boolean => {
  const trimmed = sanitizePath(value)
  if (
    !trimmed ||
    trimmed === '/' ||
    trimmed === './' ||
    trimmed === '../' ||
    trimmed === '~/' ||
    trimmed.startsWith('//')
  ) {
    return false
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return false
  }
  if (!hasLikelyFileName(trimmed)) {
    return false
  }
  return (
    trimmed.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    /^\.\.?\//.test(trimmed) ||
    /^\.\.?\\/.test(trimmed) ||
    /^~[\\/]/.test(trimmed)
  )
}

const dedupePaths = (values: string[]): string[] => {
  const seen = new Set<string>()
  const paths: string[] = []

  for (const value of values) {
    const path = sanitizePath(value)
    if (!looksLikeRealFilePath(path) || seen.has(path)) {
      continue
    }
    seen.add(path)
    paths.push(path)
  }

  return paths
}

const maybeDecodeFileUri = (value: string): string => {
  const stripped = value.replace(/^file:\/\//i, '')
  try {
    return decodeURIComponent(stripped)
  } catch {
    return stripped
  }
}

const extractTextPaths = (text: string): string[] => {
  const candidates: string[] = []
  const sanitized = text.replace(/\r/g, ' ')

  for (const match of sanitized.matchAll(/file:\/\/([^\s"']+)/gi)) {
    candidates.push(maybeDecodeFileUri(match[0] || ''))
  }

  for (const match of sanitized.matchAll(/["'`](.+?)["'`]/g)) {
    candidates.push(match[1] || '')
  }

  for (const token of sanitized.split(/\s+/)) {
    candidates.push(token)
  }

  return dedupePaths(candidates)
}

const hasStrictPermissionPhrase = (text: string): boolean => {
  return STRICT_PERMISSION_PHRASES.some((phrase) => phrase.test(text))
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const collectStructuredStrings = (
  value: unknown,
  options: { includeAllStrings: boolean },
  visited = new Set<unknown>()
): { paths: string[]; messages: string[]; permissionHints: string[] } => {
  const paths: string[] = []
  const messages: string[] = []
  const permissionHints: string[] = []

  if (!value || visited.has(value)) {
    return { paths, messages, permissionHints }
  }
  visited.add(value)

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = collectStructuredStrings(item, options, visited)
      paths.push(...nested.paths)
      messages.push(...nested.messages)
      permissionHints.push(...nested.permissionHints)
    }
    return { paths, messages, permissionHints }
  }

  if (!isRecord(value)) {
    return { paths, messages, permissionHints }
  }

  for (const [key, raw] of Object.entries(value)) {
    const keyIsPath = PATH_KEYS.has(key)
    const keyIsMessage = MESSAGE_KEYS.includes(key)
    const keyIsPermission = /permission|approval|trust|authorize|access|sandbox/i.test(key)

    if (typeof raw === 'string') {
      if (keyIsPath || (options.includeAllStrings && looksLikeRealFilePath(raw))) {
        paths.push(raw)
      }
      if (keyIsMessage) {
        messages.push(raw)
      }
      if (keyIsPermission || keyIsMessage) {
        permissionHints.push(raw)
      }
      continue
    }

    if (Array.isArray(raw) && keyIsPath) {
      for (const item of raw) {
        if (typeof item === 'string') {
          paths.push(item)
        }
      }
    }

    if (isRecord(raw) || Array.isArray(raw)) {
      const nested = collectStructuredStrings(raw, options, visited)
      paths.push(...nested.paths)
      messages.push(...nested.messages)
      permissionHints.push(...nested.permissionHints)
    }
  }

  return { paths, messages, permissionHints }
}

const kindFromText = (text: string): GeminiPermissionRequest['kind'] => {
  if (/\buntrusted workspace\b|\btrust workspace\b/i.test(text)) {
    return 'workspace_trust'
  }
  if (/\btool approval\b|\bapproval required\b|\brequires confirmation\b/i.test(text)) {
    return 'tool_permission'
  }
  return 'attachment_access'
}

const stringifyForFallback = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

const messageFromStructured = (messages: string[], fallback: string): string => {
  const message = messages.find((item) => item.trim()) || fallback
  return message.trim() || 'Gemini requested file access.'
}

/**
 * Attachment-modal path gate: keep only paths OUTSIDE the run's workspace.
 * Workspace-relative paths (./x, ../x is ambiguous but resolves inside far
 * more often than not) and absolute paths under the workspace root never
 * need an attachment grant — the run already has the workspace. `~/` paths
 * are treated as outside (the renderer cannot resolve the home dir; provider
 * messages about workspace files use absolute or relative forms).
 */
export function attachmentPathsOutsideWorkspace(
  paths: string[],
  workspacePath: string | null | undefined
): string[] {
  if (!workspacePath || !workspacePath.trim()) return paths
  const root = workspacePath.replace(/[\\/]+$/, '')
  return paths.filter((path) => {
    if (/^\.{1,2}[\\/]/.test(path)) return false
    if (path.startsWith('~')) return true
    return !(path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`))
  })
}

export function parseGeminiPermissionRequest(input: unknown): GeminiPermissionRequest | null {
  if (isRecord(input)) {
    const structured = collectStructuredStrings(input, { includeAllStrings: false })
    const structuredText = [
      String(input.type || ''),
      ...structured.permissionHints,
      ...structured.messages
    ].join('\n')
    const paths = dedupePaths(structured.paths)

    if (paths.length > 0 && hasStrictPermissionPhrase(structuredText)) {
      return {
        kind: kindFromText(structuredText),
        message: messageFromStructured(structured.messages, structuredText),
        paths,
        source: 'structured'
      }
    }
  }

  const text = stringifyForFallback(input)
  if (!text || !hasStrictPermissionPhrase(text)) {
    return null
  }

  const paths = extractTextPaths(text)
  if (paths.length === 0) {
    return null
  }

  return {
    kind: kindFromText(text),
    message: text,
    paths,
    source: 'text'
  }
}
